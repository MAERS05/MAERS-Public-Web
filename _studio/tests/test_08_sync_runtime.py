# -*- coding: utf-8 -*-
"""同步运行时回归：草稿请求、Worker 路由、上传登记、合并确认和密码组媒体鉴权。"""

from .node_runtime import MOCK_DOM, MOCK_KV, MOCK_LOCAL_STORAGE, MOCK_SESSION_STORAGE, NodeTestCase, mock_window


# 节点草稿和图片上传用例共用同一套 Worker 协议夹具。
MOCK_RELAY_FETCH = """
const pushedPayloads = [];
globalThis.fetch = async (url, opts = {}) => {
    const ok = (data) => ({ ok: true, json: async () => data });
    if (url.endsWith('/push')) {
        pushedPayloads.push(JSON.parse(opts.body));
        return ok({ success: true, key: 'k_' + pushedPayloads.length });
    }
    if (url.includes('/api/pull?')) {
        return ok({ success: true, items: [
            ...pushedPayloads.map((d, i) => ({ key: 'k_' + i, data: d })),
            { key: 'k_remote_lock', data: {
                module: 'notes', action: 'lock',
                data: { id: 'n_remote_1', enc: 'enc:iv_r.ct_r' }, timestamp: Date.now() + 50
            } }
        ] });
    }
    if (url.endsWith('/api/drafts/upload')) {
        const { requestId, timestamp, tags } = JSON.parse(opts.body.get('registration'));
        const bucketId = opts.body.get('bucketId');
        const name = 'r2_1.jpg', relPath = 'photos/images/travel/' + name;
        const draft = {module:'photos',action:'upload',data:{category:'travel',path:relPath,name,tags},timestamp,requestId};
        pushedPayloads.push(draft);
        return ok({ success:true, name, path:new URL('/api/drafts/preview/' + relPath + '?p=' + crypto.randomUUID(), url).href,
            relPath, draft, bucketId });
    }
    throw new Error('Unexpected relay request ' + url);
};
"""



class Test08_SyncRuntime(NodeTestCase):
    """独立验证同步入口与 Worker 协议，全部网络请求使用内存夹具。"""

    def test_exif_names_match_local_upload_and_cloud_draft_order(self):
        """拍摄时间优先且不随时区偏移；草稿队列仍按上传时间排序。"""
        import base64
        import io
        import json
        from PIL import Image
        from services import photo_images

        exif = Image.Exif()
        exif[306] = '2024:05:06 07:08:09'
        exif[0x8769] = {36867: '2020:01:02 03:04:05', 36868: '2021:02:03 04:05:06'}
        output = io.BytesIO()
        Image.new('RGB', (2, 2)).save(output, 'JPEG', exif=exif)
        raw = output.getvalue()
        self.assertTrue(photo_images.new_upload_name(raw, '.jpg', False, '20300101_000000')[1].startswith('20200102_030405_'))
        body = 'const raw=Buffer.from(' + json.dumps(base64.b64encode(raw).decode()) + ", 'base64');\n" + r"""
        const {readExifDate,photoDateLabel,exifDateLabel}=await import('./shared/photo-date.module.js');
        const {cloudflareRelay}=await import('./data-manage/sync/cloudflare-relay.module.js');
        const worker=(await import('./data-manage/sync/cloudflare-worker-sync.js')).default;
        const file=new File([raw],'camera.jpg',{type:'image/jpeg'});
        assert.equal(readExifDate(raw),'20200102_030405');
        process.env.TZ='America/New_York';assert.equal(await photoDateLabel(file),'20200102_030405');
        process.env.TZ='Asia/Shanghai';assert.equal(await photoDateLabel(file),'20200102_030405');
        assert.equal(exifDateLabel('2021:02:29 00:00:00'),'');
        assert.equal(readExifDate(new Uint8Array([73,73,42,0,255,255,255,255])),'');
        const kv=memoryKV(),env={MAERS_SYNC_KV:kv,SECRET_KEY:'s'};
        globalThis.fetch=async(url,options)=>worker.fetch(new Request(url,options),env,{});
        const registration={requestId:'11111111-1111-4111-8111-111111111111',timestamp:1794528000000,tags:[]};
        const result=await cloudflareRelay.uploadFile('https://relay.example','s',file,'travel',registration);
        assert.equal(result.success,true,result.msg);
        assert.equal(result.name,'20200102_030405_11111111111141118111111111111111.jpg');
        assert.equal(result.draft.timestamp,registration.timestamp,'拍摄时间不得替代草稿队列的顺序时间');
        const retry=await cloudflareRelay.uploadFile('https://relay.example','s',file,'travel',registration);
        assert.equal(retry.relPath,result.relPath,'同一请求重试必须保持文件键不变');
        """
        self.run_node_esm(body, preamble=(MOCK_DOM, MOCK_KV, MOCK_LOCAL_STORAGE, mock_window('/admin-cms.html')))

    def test_cms_duplicate_names_are_rejected_before_relay_push(self):
        """并发新建在串行入队前复查重名，拒绝的改名和移动不进入云端队列。"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const sm = new SyncManager();
        sm.saveConfig({mode:'relay',relay:{endpoint:'https://relay.example.com',secret:'test'}});
        const root = [{id:'a',type:'folder',title:'A',children:[]},{id:'b',type:'folder',title:'B',children:[]}];
        const state = {root,allNodes:[]};
        const results = await Promise.all(['one','two'].map(id => sm.handleRelayAction('notes','add',
            {id,parentId:'a',type:'note',title:'同名'},state)));
        assert.deepEqual(results.map(result => result.success),[true,false]);
        assert.equal(pushedPayloads.length,1);
        assert.equal((await sm.handleRelayAction('notes','add',
            {id:'other',parentId:'b',type:'note',title:'同名'},state)).success,true);
        assert.equal((await sm.handleRelayAction('notes','update',
            {id:'a',data:{title:'B'}},state)).success,false);
        assert.equal((await sm.handleRelayAction('notes','move',
            {id:'one',targetParentId:'b'},state)).success,false);
        assert.equal(pushedPayloads.length,2);
        assert.equal(state.root[0].children[0].id,'one');
        """
        self.run_node_esm(body, preamble=(MOCK_LOCAL_STORAGE, MOCK_DOM,
            mock_window('/admin-cms.html', hostname='example.com'), MOCK_RELAY_FETCH))

    def test_sync_pending_requests_share_pull_and_discard_old_config(self):
        """同一中继的并发读取共用拉取，配置切换后的迟到结果不覆盖新计数或文档。"""
        body = """
        const {SyncManager}=await import('./data-manage/sync/sync-manager.module.js');
        const manager=new SyncManager();manager.updateButtonBadge=()=>{};
        manager.config={mode:'relay',relay:{endpoint:'https://a.example',secret:'a'}};
        const requests=[];
        globalThis.fetch=url=>new Promise(resolve=>requests.push({url,resolve}));
        const items=manager.getPendingItems(),count=manager.checkPendingRelayItems();
        assert.equal(requests.length,1);
        manager.config={mode:'relay',relay:{endpoint:'https://b.example',secret:'b'}};
        const next=manager.checkPendingRelayItems();assert.equal(requests.length,2);
        requests[1].resolve(Response.json({items:[{data:{module:'notes',action:'add',data:{id:'new'}}}]}));
        assert.equal(await next,1);
        requests[0].resolve(Response.json({items:[{data:{}},{data:{}},{data:{}}]}));
        assert.deepEqual(await items,[]);await count;assert.equal(manager.pendingItemsCount,1);
        const refresh=manager.checkPendingRelayItems();assert.equal(requests.length,3);
        requests[2].resolve(Response.json({items:[]}));await refresh;assert.equal(manager.pendingItemsCount,0);
        const failed=manager.checkPendingRelayItems();
        requests[3].resolve(new Response(null,{status:500}));
        assert.equal(await failed,null);
        assert.equal(manager.getButtonLabel(),'草稿读取失败');
        """
        self.run_node_esm(body,preamble=(MOCK_LOCAL_STORAGE,MOCK_DOM,mock_window('/admin-cms.html')))


    def test_sync_push_starts_fresh_pull_and_older_count_cannot_clear_badge(self):
        """草稿写入后重新拉取，较早的空列表不能清掉新计数或漏回放当前会话草稿。"""
        body = """
        const {Toast}=await import('./shared/toast.module.js');Toast._show=()=>{};
        const {SyncManager}=await import('./data-manage/sync/sync-manager.module.js');
        for(const status of [200,503]) {
            const manager=new SyncManager();manager.updateButtonBadge=()=>{};
            manager.config={mode:'relay',relay:{endpoint:'https://relay.example',secret:'test'}};
            const pulls=[];let ready;
            const freshPull=new Promise(resolve=>{ready=resolve;});
            globalThis.fetch=(url,options={})=>{
                if(url.endsWith('/push'))return Promise.resolve(Response.json({id:'queued'}));
                return new Promise(resolve=>{pulls.push(resolve);if(pulls.length===2)ready();});
            };
            const oldCount=manager.checkPendingRelayItems(),oldItems=manager.getPendingItems();
            assert.equal(pulls.length,1);
            const queued=manager.enqueue('notes','add',{id:'new',title:'new'});
            await freshPull;assert.equal(pulls.length,2);assert.equal(manager.pendingItemsCount,1);
            pulls[0](Response.json({items:[]},{status}));await oldCount;
            assert.equal(manager.pendingItemsCount,1);
            assert.equal((await oldItems)[0].data.id,'new');
            pulls[1](Response.json({items:[{key:'queued',data:manager.localPendingSessionItems[0]}]}));
            assert.equal((await queued).success,true);assert.equal(manager.pendingItemsCount,1);
        }
        """
        self.run_node_esm(body,preamble=(MOCK_LOCAL_STORAGE,MOCK_DOM,mock_window('/admin-cms.html')))


    def test_sync_merge_discards_pending_reads_started_before_ack(self):
        """电脑确认已合并后，较早发出的拉取不能恢复草稿或旧计数。"""
        body = """
        const {Toast}=await import('./shared/toast.module.js');Toast._show=()=>{};
        const {SyncManager}=await import('./data-manage/sync/sync-manager.module.js');
        const manager=new SyncManager();
        manager.config={mode:'local',relay:{endpoint:'https://relay.example',secret:'test'}};
        manager.Controller={loadData:async()=>true,refreshView:()=>{}};
        const data={module:'notes',action:'delete',data:{id:'gone'},timestamp:1};
        const items=[{key:'old',data}];
        manager.localPendingSessionItems=[data];
        let oldPull, pulls=0;
        globalThis.fetch=(url,options)=>{
            if(url.includes('/api/pull?')){
                pulls++;
                if(pulls===1)return new Promise(resolve=>{oldPull=resolve;});
                return Promise.resolve(Response.json({items}));
            }
            if(url.endsWith('/ack'))assert.deepEqual(JSON.parse(options.body).keys,['old']);
            else assert.match(url,/api[/]cms[/]node[?]/);
            return Promise.resolve(Response.json({success:true}));
        };
        const pending=manager.getPendingItems(), count=manager.checkPendingRelayItems();
        assert.equal(pulls,1);
        assert.equal(await manager.pullAndMerge(),true);
        oldPull(Response.json({items}));
        assert.deepEqual(await pending,[]);
        assert.equal(await count,0);
        assert.equal(manager.pendingItemsCount,0);
        """
        self.run_node_esm(body,preamble=(MOCK_LOCAL_STORAGE,MOCK_DOM,mock_window('/admin-cms.html',hostname='example.com')))


    def test_worker_routes_preserve_auth_and_hide_storage_failures(self):
        """路由拆分保留预检、同步密码和草稿接口；公开与私密存储错误都不泄漏内部信息。"""
        body = """
        const {default:worker}=await import('./data-manage/sync/cloudflare-worker-sync.js');
        const logs=[],original=console.error;
        console.error=(...args)=>logs.push(args);
        const call=(path,env={},options={})=>worker.fetch(new Request('https://relay.example'+path,options),env,{});
        const auth={'x-sync-key':'test','Origin':'https://site.example'};
        try {
            const preflight=await call('/api/pull',{}, {method:'OPTIONS',headers:{Origin:'https://site.example'}});
            assert.equal(preflight.status,204);
            assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://site.example');
            assert.equal((await call('/api/ping')).status,500);
            assert.equal((await call('/api/pull',{SECRET_KEY:'test'})).status,401);
            assert.equal((await call('/missing',{SECRET_KEY:'test'},{headers:auth})).status,404);
            assert.equal((await call('/api/pull',{SECRET_KEY:'test'},{headers:auth})).status,500);
            const stored=new Map();
            const kv={get:async key=>stored.has(key)?JSON.parse(stored.get(key)):null,
                put:async(key,data)=>stored.set(key,data),delete:async key=>stored.delete(key)};
            const pushed=await call('/api/drafts/push',{SECRET_KEY:'test',KV:kv},{method:'POST',headers:auth,
                body:JSON.stringify({module:'notes',action:'add',data:{id:'new'},requestId:crypto.randomUUID(),timestamp:1})});
            assert.equal(pushed.status,200);assert.equal(stored.size,1);
            const ack=await call('/api/ack',{SECRET_KEY:'test',KV:kv},{method:'POST',headers:auth,
                body:JSON.stringify({keys:[...stored.keys()]})});
            assert.deepEqual(await ack.json(),{success:true,deleted:1});assert.equal(stored.size,0);
            const fail=async()=>{throw new Error('internal-secret-and-private-path');};
            const response=await call('/api/pull',{SECRET_KEY:'test',KV:{list:fail}},{headers:auth});
            assert.equal(response.status,500);assert.doesNotMatch(await response.text(),/internal-secret/);
            assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://site.example');
            const media=await call('/private/photos/images/x/a.png?t=secret',{PRIVATE_PHOTOS_BUCKET:{get:fail}});
            assert.equal(media.status,500);assert.equal(media.headers.get('Cache-Control'),'no-store');
            assert.doesNotMatch(await media.text(),/internal-secret/);
            assert.doesNotMatch(JSON.stringify(logs),/internal-secret|t=secret/);
        } finally {console.error=original;}
        """
        self.run_node_esm(body)


    def test_worker_draft_size_follows_kv_value_limit(self):
        """私密草稿可以超过旧阈值，超过 KV 字节上限时返回可操作的提示。"""
        body = """
        const { default: worker } = await import('./data-manage/sync/cloudflare-worker-sync.js');
        let writes = 0;
        const env = { SECRET_KEY: 'test', KV: { get: async () => null, put: async () => { writes++; } } };
        const send = (module, action, data) => worker.fetch(new Request('https://relay.example/api/drafts/push', {
            method: 'POST', headers: { 'x-sync-key': 'test' },
            body: JSON.stringify({ module, action, data, timestamp: 1, requestId: crypto.randomUUID() })
        }), env);
        const privateDraft = { source: 'notes', group: 'default', revision: 'a'.repeat(64),
            enc: 'enc:AAAA.' + 'A'.repeat(16 * 1024 * 1024) };
        assert.equal((await send('private', 'replace', privateDraft)).status, 200);
        const tooLarge = await send('notes', 'update', { content: '中'.repeat(9 * 1024 * 1024) });
        assert.equal(tooLarge.status, 413);
        assert.match((await tooLarge.json()).error, /25 MiB/);
        assert.equal(writes, 1);
        """
        self.run_node_esm(body)


    def test_groups_worker_tokens_cannot_read_another_groups_images(self):
        """知道其他组的文件键也不能跨组读取；默认组令牌同样受到对象权限限制。"""
        body = """
        const {default:worker}=await import('./data-manage/sync/cloudflare-worker-sync.js');
        const {sha256Hex}=await import('./data-manage/encrypt/crypto.module.js');
        const objects=new Map();
        const bucket={async put(key,body){objects.set(key,String(body));},async get(key){
            return objects.has(key)?{body:objects.get(key),httpEtag:'test',writeHttpMetadata(){}}:null;
        }};
        const env={SECRET_KEY:'admin',PRIVATE_PHOTOS_BUCKET:bucket};
        const a='g_'+'a'.repeat(32),b='g_'+'b'.repeat(32);
        for(const [group,token] of [['default','root'],[a,'token-a'],[b,'token-b']]){
            const response=await worker.fetch(new Request('https://worker.example/api/private-token?g='+group,{
                method:'POST',headers:{'x-sync-key':'admin'},body:JSON.stringify({hash:await sha256Hex(token)})}),env,{});
            assert.equal(response.status,200);
        }
        const key='photos/images/shared/a.jpg';objects.set(key,'PRIVATE_IMAGE');
        objects.set('_maers/media-groups/'+await sha256Hex(key)+'.json',JSON.stringify({key,groups:[a]}));
        const read=(group,token)=>worker.fetch(new Request('https://worker.example/private/'+key+'?g='+group+'&t='+token),env,{});
        assert.equal((await read(a,'token-a')).status,200);
        assert.equal((await read(b,'token-b')).status,403);
        assert.equal((await read('default','root')).status,403);
        assert.equal((await read(b,'token-a')).status,403);
        """
        self.run_node_esm(body)

    def test_worker_can_read_private_markdown_with_valid_token(self):
        """Worker 凭有效令牌可从私有存储读取 markdown/ 正文，未授权或键越界返回 400/403。"""
        body = """
        const {default:worker}=await import('./data-manage/sync/cloudflare-worker-sync.js');
        const {sha256Hex}=await import('./data-manage/encrypt/crypto.module.js');
        const objects=new Map();
        const bucket={async put(key,body){objects.set(key,String(body));},async get(key){
            return objects.has(key)?{body:objects.get(key),httpEtag:'test',writeHttpMetadata(){}}:null;
        }};
        const env={SECRET_KEY:'admin',PRIVATE_PHOTOS_BUCKET:bucket};
        await worker.fetch(new Request('https://worker.example/api/private-token?g=default',{
            method:'POST',headers:{'x-sync-key':'admin'},body:JSON.stringify({hash:await sha256Hex('my-token')})}),env,{});

        const mdKey = 'markdown/notes/root-secret.md';
        objects.set(mdKey, '# 私密正文');

        const ok = await worker.fetch(new Request('https://worker.example/private/' + mdKey + '?t=my-token'), env, {});
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
        assert.equal(await ok.text(), '# 私密正文');

        const badToken = await worker.fetch(new Request('https://worker.example/private/' + mdKey + '?t=wrong'), env, {});
        assert.equal(badToken.status, 403);

        const badPath = await worker.fetch(new Request('https://worker.example/private/markdown/notes/escape/../../a.md?t=my-token'), env, {});
        assert.equal(badPath.status, 400);
        """
        self.run_node_esm(body)


    def test_24_mobile_gallery_restores_uploads_after_reload(self):
        """全新页面从中继恢复相册上传，隔离分类及私有记录，重复加载不覆盖已发布衍生图。"""
        body = """
        const { syncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const { State, initController, reloadData, fixPath } = await import('./custom/photos/admin/photos-controller.module.js');
        syncManager.config = {mode:'relay', relay:{endpoint:'https://relay.example', secret:'test'}};
        window.MAERS = {Config:{MEDIA_PUBLIC_BASE:'https://cdn.example'}};
        State.category = 'travel';
        let published = [{id:'published', path:'photos/images/travel/old.jpg', thumb:'old.webp', preview:'old.avif'}];
        initController({getGalleryData:async()=>published});
        const upload = (category, name, scope = 'public') => ({module:'photos', action:'upload',
            data:{category, name, path:`photos/images/${category}/${name}`, scope}, timestamp:10});
        let queue = [upload('travel','a.jpg'), upload('travel','b.jpg'), upload('other','c.jpg'),
            upload('travel','secret.jpg','private')];
        const preview = 'https://relay.example/api/drafts/preview/photos/images/travel/b.jpg?p=' + crypto.randomUUID();
        globalThis.fetch = async url => {
            if (url === '/data/album-config.json' || url === 'data/album-config.json') return Response.json([{id:'travel',title:'Travel'}]);
            assert.equal(url, 'https://relay.example/api/pull?cursor=');
            return {ok:true, json:async()=>({items:queue.map((data,i)=>({key:String(i),data})),
                media:[['photos/images/travel/b.jpg',preview]]})};
        };
        assert.equal(syncManager.localPendingSessionItems.length, 0, '模拟刷新后的全新页面');
        const fresh = await reloadData();
        assert.deepEqual(fresh.map(row=>row.name || row.id), ['b.jpg','a.jpg','published']);
        assert.equal(fresh[0].thumb, 'photos/images/travel/b.jpg', '未合并前直接使用原图');
        assert.equal(fixPath(fresh[0].preview), preview);
        assert.equal(fresh[0]._pendingRelay, true);
        assert.equal(State.hasChanges, false);
        assert.equal(published.length, 1, '回放不能污染静态数据缓存');
        const stableId = fresh[0].id;
        syncManager.localPendingSessionItems = [queue[0]];
        await reloadData();
        assert.equal(State.loadedData.length, 3, '同一时间戳的多个上传仍须恢复且去重');
        assert.equal(State.loadedData[0].id, stableId);
        published = [...published, {id:'merged',path:'https://cdn.example/photos/images/travel/a.jpg',
            thumb:'real.webp',preview:'real.avif',tags:['tag']}];
        await reloadData();
        assert.equal(State.loadedData.length, 3);
        assert.equal(State.loadedData.find(row=>row.id === 'merged').preview, 'real.avif');
        queue = []; syncManager.localPendingSessionItems = [];
        await reloadData();
        assert.equal(State.loadedData.length, 2, '合并并确认后以已发布数据为准');
        window.IS_ADMIN = false; State.isAdmin = false;
        let visitorPulls = 0;
        globalThis.fetch = async url => {
            if (url === '/data/album-config.json' || url === 'data/album-config.json') return Response.json([{id:'travel',title:'Travel'}]);
            visitorPulls++;
            return {ok:true,json:async()=>({items:[]})};
        };
        assert.equal((await reloadData()).length, 2);
        assert.equal(visitorPulls, 0, '访客不应拉取管理队列');
        """
        self.run_node_esm(body, preamble=(
            MOCK_LOCAL_STORAGE, MOCK_SESSION_STORAGE, MOCK_DOM, mock_window('/admin-photos.html', hostname='example.com', is_admin=True),
        ))


    def test_22_worker_upload_uuids_survive_same_second_and_random_number(self):
        """固定时钟并发上传同名及混合格式图片，校验公开键唯一与私密上传隔离。"""
        body = """
        const { File } = await import('node:buffer');
        globalThis.File = File;
        const { default: worker } = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const NativeDate = Date;
        globalThis.Date = class extends NativeDate {
            constructor(...args) { super(...(args.length ? args : [1793188800000])); }
            static now() { return 1793188800000; }
        };
        Math.random = () => 0;
        const kv = memoryKV();
        const env = { SECRET_KEY: 'test', KV:kv };
        const upload = async (index, category = 'travel', unsupported = false) => {
            const extension = index % 2 ? 'jpg' : 'png';
            const type = extension === 'jpg' ? 'image/jpeg' : 'image/png';
            const signature = extension === 'jpg' ? Uint8Array.of(255, 216, 255)
                : Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
            const file = new File(unsupported ? ['<svg/>'] : [signature, `image-${index}`], `same.${extension}`, { type });
            const form = new FormData();
            form.set('file', file);
            form.set('category', category);
            const response = await worker.fetch(new Request('https://worker.example/api/drafts/upload', {
                method: 'POST', headers: { 'x-sync-key': 'test' }, body: form }), env, {});
            if (category !== 'travel' || unsupported) return response.status;
            assert.equal(response.status, 200);
            const result = await response.json();
            assert.match(result.name, new RegExp(`^[0-9]{8}_[0-9]{6}_[a-f0-9]{32}\\\\.${extension}$`));
            const preview = await worker.fetch(new Request(result.path),env,{});
            assert.equal(preview.headers.get('content-type'), type);
            assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
            return result;
        };
        const results = await Promise.all(Array.from({ length: 40 }, (_, index) => upload(index)));
        assert.equal(new Set(results.map(result => result.relPath)).size, 40);
        assert.equal(new Set(results.map(result => result.name.split('.')[0])).size, 40);
        assert.equal(kv.entries.size, 40);
        for (const result of results) {
            assert.equal(new URL(result.path).pathname, `/api/drafts/preview/${result.relPath}`);
        }
        assert.equal(await upload(41, 'private'), 400);
        assert.equal(await upload(42, 'travel', true), 415);
        assert.equal(kv.entries.size, 40);
        """
        self.run_node_esm(body, preamble=(MOCK_KV,))


    def test_19_relay_refresh_reuses_backend_receipt_after_ack_failure(self):
        """确认失败后重建页面管理器，携带同一回执身份，避免重放已入库的新增。"""
        body = """
        const {SyncManager}=await import('./data-manage/sync/sync-manager.module.js');
        let ackOk=false, applied=0;
        const receipts=new Set();
        let queue=[{key:'sync_1',data:{module:'notes',action:'add',data:{id:'n',title:'草稿'},timestamp:1}}];
        globalThis.fetch=async(url,options={})=>{
            const ok=data=>({ok:true,json:async()=>data});
            if(url.endsWith('/api/crypto/local-session'))return ok({configured:false,keys:{}});
            if(url.endsWith('/api/studio/status'))return ok({state:'ready',active:0});
            if(url.endsWith('/api/session'))return ok({token:'session'});
            if(url.includes('/api/pull?'))return ok({items:queue});
            if(url.endsWith('/ack')){if(ackOk)queue=[];return {ok:ackOk};}
            const query=new URL(url,'http://relay.test').searchParams;
            const relay={source:query.get('_relay_source'),key:query.get('_relay_key')};
            assert.deepEqual(relay,{source:'https://relay.example',key:'sync_1'});
            assert.equal(JSON.parse(options.body)._relay,undefined);
            const identity=JSON.stringify(relay);
            if(!receipts.has(identity)){receipts.add(identity);applied++;}
            return ok({status:'success'});
        };
        const fresh=()=>{const m=new SyncManager();m.saveConfig({mode:'relay',relay:{endpoint:'https://relay.example/',secret:'test'}});m.Controller={loadData:async()=>{},refreshView(){}};return m;};
        assert.equal(await fresh().pullAndMerge(),false);
        ackOk=true;
        assert.equal(await fresh().pullAndMerge(),true);
        assert.equal(applied,1);
        assert.equal(queue.length,0);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html')))

    def test_upload_progress_waits_for_the_storage_response(self):
        """传输完成不能提前报告上传成功，存储响应和错误仍由原调用方判断。"""
        body = """
        const events = [];
        let sent;
        globalThis.XMLHttpRequest = class {
            constructor() { this.upload = {}; sent = this; }
            open(method, url) { this.method = method; this.url = url; }
            setRequestHeader() {}
            send(body) { this.body = body; }
            getAllResponseHeaders() { return 'content-type: application/json'; }
        };
        const { uploadFetch } = await import('./data-manage/upload-progress.module.js');
        let finished = false;
        const waiting = uploadFetch('https://upload.example/api/upload', { body: new Blob(['image']) },
            (done, total) => events.push([done, total])).then(result => { finished = true; return result; });
        sent.upload.onprogress({ loaded: 5, total: 10, lengthComputable: true });
        sent.upload.onload();
        await Promise.resolve();
        assert.equal(finished, false);
        assert.deepEqual(events, [[5, 10], [0, 0]]);
        sent.status = 500;
        sent.statusText = 'Storage failed';
        sent.response = new TextEncoder().encode(JSON.stringify({ error: 'not saved' })).buffer;
        sent.onload();
        const response = await waiting;
        assert.equal(response.ok, false);
        assert.equal((await response.json()).error, 'not saved');
        """
        self.run_node_esm(body)


    def test_05_sync_manager_relay_queue_and_state_replay(self):
        """节点新增、更新和刷新回放经过同一个中继协议，远端动作保持顺序。"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const sm = new SyncManager();
        sm.saveConfig({ mode: 'relay', relay: { endpoint: 'https://relay.example.com', secret: 'sec_123' } });
        assert.equal(sm.getEffectiveMode(), 'relay');

        // 1. 新增与更新草稿入队
        const state1 = { root: [], allNodes: [] };
        const addRes = await sm.handleRelayAction('notes', 'add',
            { id: 'n_mobile_1', parentId: 'root', type: 'note', title: '手机速记' }, state1);
        assert.equal(addRes.success, true);
        assert.equal(state1.root.length, 1);
        assert.equal(state1.root[0]._pendingRelay, true);

        await sm.handleRelayAction('notes', 'update',
            { id: 'n_mobile_1', data: { title: '手机速记-已改', content: '新正文' } }, state1);
        assert.equal(state1.root[0].title, '手机速记-已改');
        assert.equal(state1.root[0]._draftContent, '新正文');

        // 2. 刷新后合并本地与云端队列，自定义动作回调
        const fresh = { root: [], allNodes: [] };
        const customActions = [];
        await sm.applyPendingToState('notes', fresh, (item) => {
            if (item.action === 'lock') customActions.push(item.data.id);
        });
        assert.equal(fresh.root.length, 1, '本地与云端重复条目应去重');
        assert.equal(fresh.root[0].title, '手机速记-已改');
        assert.equal(fresh.root[0]._draftContent, '新正文');
        assert.deepEqual(customActions, ['n_remote_1']);
        """
        self.run_node_esm(body, preamble=(
            MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html', hostname='example.com'), MOCK_RELAY_FETCH,
        ))


    def test_05_photos_batch_upload_registers_preview(self):
        """相册批量上传登记草稿和本页预览，旧版重试记录仍沿用原桶。"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const { sha256Hex } = await import('./data-manage/encrypt/crypto.module.js');
        const sm = new SyncManager();
        sm.saveConfig({ mode: 'relay', relay: { endpoint: 'https://relay.example.com', secret: 'sec_123' } });
        const loaded = [];
        const file = new Blob(['IMG_BYTES'], { type: 'image/jpeg' });
        file.name = 'shot.jpg';
        const digest = await sha256Hex(await file.arrayBuffer());
        const retry = await sm.reserveRelayRequest(sm.getConfig().relay, ['photo', 'travel', file.name, digest, []], 'archive');
        const reopened = new SyncManager();
        const batch = await reopened.uploadPhotosBatch([file], 'travel', loaded);
        assert.equal(batch.success, true);
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0]._pendingRelay, true);
        assert.equal(loaded[0].bucketId, 'archive');
        assert.ok(pushedPayloads.some(p => p.module === 'photos' && p.action === 'upload' && p.requestId === retry.requestId));
        """
        self.run_node_esm(body, preamble=(
            MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html', hostname='example.com'), MOCK_RELAY_FETCH,
        ))


    def test_07_sync_failures_and_ordered_retry(self):
        """失败入队不改本地状态；失败时关闭弹窗则停止后续操作；确认重试不重复入库"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const { AdminModal } = await import('./data-manage/admin/admin-modal.module.js');
        AdminModal.choose = async () => null;
        const sm = new SyncManager();
        sm.saveConfig({ mode: 'relay', relay: { endpoint: 'https://relay.example.com', secret: 'test' } });
        sm.Controller = { loadData: async () => {}, refreshView() {} };
        let acceptPush = false, pushes = 0, ackOk = false, rejectUpdate = true, applied = [];
        let queue = ['add', 'update', 'delete'].map((action, i) => ({ key: String(i), data: {
            module: 'notes', action, data: { id: 'n1' }, timestamp: i
        } }));
        globalThis.fetch = async (url, opts = {}) => {
            const ok = data => ({ ok: true, json: async () => data });
            if (url.endsWith('/api/crypto/local-session')) return ok({configured:false,keys:{}});
            if (url.endsWith('/api/studio/status')) return ok({state:'ready',active:0});
            if (url.endsWith('/api/session')) return ok({ token: 'test-session' });
            if (url.endsWith('/push')) {
                pushes++; await Promise.resolve();
                return acceptPush ? ok({ id: 'p1' }) : { ok: false, status: 503, text: async () => 'offline' };
            }
            if (url.includes('/api/pull?')) return ok({ items: queue });
            if (url.endsWith('/ack')) {
                if (ackOk) { const keys = JSON.parse(opts.body).keys; queue = queue.filter(item => !keys.includes(item.key)); }
                return { ok: ackOk };
            }
            const action = new URL(url, 'https://local.example').searchParams.get('action');
            applied.push(action);
            return ok({ success: !(rejectUpdate && action === 'update'), msg: 'retry' });
        };
        const state = { root: [], allNodes: [] };
        const data = { id: 'n1', type: 'note', title: '草稿' };
        assert.equal((await sm.handleRelayAction('notes', 'add', data, state)).success, false);
        assert.equal(state.root.length, 0);
        assert.equal(sm.localPendingSessionItems.length, 0);
        acceptPush = true;
        await Promise.all([sm.handleRelayAction('notes', 'add', data, state), sm.handleRelayAction('notes', 'add', data, state)]);
        assert.equal(pushes, 2, '并发同一草稿只发一次');
        assert.equal(state.root.length, 1);
        assert.equal(await sm.pullAndMerge(), false);
        assert.deepEqual(applied, ['add', 'update']);
        assert.equal(sm.pendingItemsCount, 3, '确认失败不能减少云端待同步数');
        rejectUpdate = false; ackOk = true;
        assert.equal(await sm.pullAndMerge(), true);
        assert.deepEqual(applied, ['add', 'update', 'update', 'delete'], '已经入库的 add 不得重放');
        assert.equal(sm.pendingItemsCount, 0);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html')))


    def test_33_toolbar_label_shows_pending_merge_count(self):
        """本地分别显示合并与 Git 数量，云端仅显示待电脑合并的草稿。"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const sm = new SyncManager();
        assert.equal(sm.getButtonLabel(), '本地模式');
        sm.pendingItemsCount = 2;
        assert.equal(sm.getButtonLabel(), '待合并(2)');
        sm.pendingGitCount = 3;
        assert.equal(sm.getButtonLabel(), '待合并(2) · 待Git(3)');
        sm.pendingItemsCount = 0;
        assert.equal(sm.getButtonLabel(), '待Git(3)');
        sm.isLocalHost = () => false;
        assert.equal(sm.getButtonLabel(), '云端模式');
        const button = {classList:{add(){},remove(){}}}, title = {};
        const modal = {querySelector:selector => selector.includes('git-count-title') ? title : null};
        document.getElementById = id => id === 'maers-sync-btn' ? button : id === 'maers-sync-modal' ? modal : null;
        sm.pendingItemsCount = 2;
        sm.updateButtonBadge(false);
        assert.equal(button.textContent, '云端草稿(2)');
        assert.equal(title.textContent, '待电脑合并草稿(2)');
        assert.ok(button.title.includes('电脑本地后台拉取合并'));
        assert.ok(!button.title.includes('GitHub'));
        sm.pendingItemsCount = 0;
        sm.updateButtonBadge(false);
        assert.equal(button.textContent, '云端模式');
        assert.equal(title.textContent, '待电脑合并草稿(0)');
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html')))


    def test_08_photo_registration_retry_after_partial_kv_write(self):
        """原图写入后才登记，丢响应和 KV 配额失败可用同一请求编号重试。"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const { default: worker } = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const kv = memoryKV();
        let rejectImage = true, rejectDraft = false, dropReply = false, uploads = 0;
        const put = kv.put;
        kv.put = async (key, value, options) => {
            if (options.metadata?.key) {
                if (rejectImage) throw Error('KV PUT failed: 507 storage capacity');
                uploads++;
            } else if (rejectDraft) throw Error('KV PUT failed: 429 daily quota exceeded');
            await put(key, value, options);
        };
        const env = {SECRET_KEY:'test', KV:kv,
            PUBLIC_PHOTOS_BUCKET:{put:()=>assert.fail('formal bucket write')},
            PRIVATE_PHOTOS_BUCKET:{put:()=>assert.fail('formal bucket write')}};
        globalThis.fetch = async (url, opts) => {
            const response = await worker.fetch(new Request(url, opts), env);
            if (dropReply && url.endsWith('/api/drafts/upload')) throw Error('response lost');
            return response;
        };
        const sm = new SyncManager();
        sm.saveConfig({ mode: 'relay', relay: { endpoint: 'https://relay.example.com', secret: 'test' } });
        const file = () => new File([Uint8Array.of(255, 216, 255), 'abc'], 'a.jpg', {type:'image/jpeg'});
        const loaded = [], tags = ['旅行'];
        assert.equal((await sm.uploadPhotosBatch([file()], 'travel', loaded, tags)).success, false);
        assert.equal(uploads, 0); assert.equal(kv.entries.size, 0);
        rejectImage = false; rejectDraft = true;
        assert.equal((await sm.uploadPhotosBatch([file()], 'travel', loaded, tags)).success, false);
        assert.equal(kv.entries.size, 1);
        assert.deepEqual(await sm.getPendingItems(), [], '原图暂存成功但登记失败时不显示为可合并的图库草稿');
        rejectDraft = false; dropReply = true;
        assert.equal((await sm.uploadPhotosBatch([file()], 'travel', loaded, tags)).success, false);
        assert.equal(loaded.length, 0);
        const reopened = new SyncManager();
        const pulled = await reopened.getPendingItems();
        assert.equal(pulled.length, 1, '浏览器未收到响应，电脑仍可独立拉取登记');
        assert.deepEqual(pulled[0].data.tags, tags);
        await reopened.applyPendingPhotos('travel', loaded);
        dropReply = false;
        assert.equal((await reopened.uploadPhotosBatch([file()], 'travel', loaded, tags)).success, true);
        assert.equal(uploads, 1); assert.equal(kv.entries.size, 2); assert.equal(loaded.length, 1);
        assert.deepEqual(loaded[0].tags, tags);
        const attachment = await sm.uploadFile(file(), '_notes');
        assert.equal(attachment.success, true);
        assert.match(attachment.relPath, /^photos[/]images[/]_notes[/]/);
        assert.equal(kv.entries.size, 3);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM, MOCK_KV,
                                         mock_window('/admin-cms.html')))


    def test_28_worker_token_revocation_has_no_stale_memory_cache(self):
        """令牌写入私有存储后，每次鉴权读取新值，旧令牌立即被当前代码拒绝。"""
        body = """
        const {default:worker} = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const objects = new Map();
        const bucket = {async put(key,body){objects.set(key,String(body));},async get(key){
            return objects.has(key) ? {body:objects.get(key),httpEtag:'test',writeHttpMetadata(){}} : null;
        }};
        const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))))
            .map(v=>v.toString(16).padStart(2,'0')).join('');
        const env = {SECRET_KEY:'admin',PRIVATE_PHOTOS_BUCKET:bucket};
        objects.set('photos/images/secret/a.png','image');
        const update = token => worker.fetch(new Request('https://worker.example/api/private-token',{
            method:'POST',headers:{'x-sync-key':'admin'},body:JSON.stringify({hash:token})}),env,{});
        assert.equal((await update(await hash('old'))).status,200);
        const request = token => worker.fetch(new Request('https://worker.example/private/photos/images/secret/a.png?t='+token),env,{});
        assert.equal((await request('old')).status,200);
        assert.equal((await update(await hash('new'))).status,200);
        assert.equal((await request('old')).status,403);
        const response = await request('new');
        assert.equal(response.status,200);
        assert.equal(response.headers.get('Cache-Control'),'no-store');
        """
        self.run_node_esm(body)


    def test_29_worker_media_can_use_independent_https_gateway(self):
        """已发布的私密图片可以通过通用网关读取，环境无需绑定 R2。"""
        body = """
        const {default:worker} = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push({url,options});
            assert.equal(options.headers.Authorization,'Bearer gateway-key');
            if(url.includes('/_maers/media-groups/'))return new Response(null,{status:404});
            assert.equal(options.method, 'GET');
            return new Response('image',{status:200,headers:{'Content-Type':'image/png'}});
        };
        const env = {SECRET_KEY:'admin',MEDIA_GATEWAY_URL:'https://storage.example',
            MEDIA_GATEWAY_TOKEN:'gateway-key'};
        const token = 'private-token';
        env.PRIVATE_TOKEN_HASH = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))))
            .map(v=>v.toString(16).padStart(2,'0')).join('');
        const image = await worker.fetch(new Request('https://relay.example/private/photos/images/secret/a.png?t='+token),env,{});
        assert.equal(image.status,200);
        assert.equal(calls.at(-1).url,'https://storage.example/objects/private/photos/images/secret/a.png');
        assert.equal(image.headers.get('Cache-Control'),'no-store');
        """
        self.run_node_esm(body)

    def test_anonymous_images_use_the_public_s3_target_and_preserve_private_auth(self):
        body = r"""
        const {default:worker} = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const publicTarget = {provider:'r2',endpoint_url:'https://'+'a'.repeat(32)+'.eu.r2.cloudflarestorage.com',
            bucket_name:'public-images',access_key_id:'public-key',secret_access_key:'public-secret'};
        const privateTarget = {provider:'b2',endpoint_url:'https://s3.us-west-004.backblazeb2.com',
            bucket_name:'private-images',access_key_id:'private-key',secret_access_key:'private-secret'};
        const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode('visitor-token'));
        const env = {SECRET_KEY:'admin',PUBLIC_MEDIA_READS:'true',MEDIA_PUBLIC_BASE:'https://images.example',
            MEDIA_PUBLIC_S3:JSON.stringify(publicTarget),MEDIA_PRIVATE_S3:JSON.stringify(privateTarget),
            PRIVATE_TOKEN_HASH:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')};
        const requests = [];
        globalThis.fetch = async (url, options) => {
            requests.push({url, method:options.method, auth:options.headers.get('Authorization')});
            if (url.includes('/_maers/media-groups/') || url.endsWith('/missing.png')) return new Response(null,{status:404});
            const isPublic = url.startsWith(publicTarget.endpoint_url);
            return new Response(options.method === 'HEAD' ? null : isPublic ? 'public bytes' : 'private bytes', {
                headers:{'Content-Type':isPublic ? 'text/html' : 'image/png','Cache-Control':'public, max-age=3600'}
            });
        };
        const get = (path, options) => worker.fetch(new Request('https://relay.example'+path,options),env,{});
        const path = '/photos/images/旅行/照片 (1).png';
        const response = await get(path);
        assert.equal(response.status,200);
        assert.equal(response.headers.get('content-type'),'image/png');
        assert.equal(response.headers.get('access-control-allow-origin'),'*');
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.equal(response.headers.get('x-content-type-options'),'nosniff');
        assert.equal(await response.text(),'public bytes');
        assert.equal(requests[0].url, publicTarget.endpoint_url+'/public-images/photos/images/%E6%97%85%E8%A1%8C/%E7%85%A7%E7%89%87%20%281%29.png');
        assert.match(requests[0].auth,/Credential=public-key\/\d{8}\/auto\/s3\/aws4_request/);
        const head = await get('/photos/thumbnails/travel/t.webp',{method:'HEAD'});
        assert.equal(head.status,200);
        assert.equal(await head.text(),'');
        assert.equal(requests[1].method,'HEAD');
        assert.equal((await get('/photos/previews/travel/missing.png')).status,404);

        const before = requests.length;
        for (const key of ['/photos/images/travel/%2Fhidden.png','/photos/images/_cloud_private/a.png',
            '/photos/images/travel/a.svg','/photos/images/travel/a.json','/photos/images/travel/%FF.png']) {
            assert.equal((await get(key)).status,404);
        }
        assert.equal((await get('/markdown/notes/note.md')).status,401);
        assert.equal((await get(path,{method:'POST'})).status,401);
        assert.equal((await get('/private'+path+'?t=wrong')).status,403);
        assert.equal(requests.length,before);
        const privateImage = await get('/private'+path+'?t=visitor-token');
        assert.equal(privateImage.status,200);
        assert.equal(await privateImage.text(),'private bytes');
        assert.ok(requests.slice(before).every(call=>call.url.startsWith(privateTarget.endpoint_url+'/private-images/')));
        assert.match(requests.at(-1).auth,/Credential=private-key\/\d{8}\/us-west-004\/s3\/aws4_request/);

        const count = requests.length;
        env.PUBLIC_MEDIA_READS = 'false';
        assert.equal((await get(path)).status,401);
        env.PUBLIC_MEDIA_READS = 'true';
        env.MEDIA_PRIVATE_S3 = JSON.stringify({...publicTarget,endpoint_url:publicTarget.endpoint_url.replace('.eu.','.')});
        assert.equal((await get(path)).status,500);
        delete env.MEDIA_PRIVATE_S3;
        assert.equal((await get(path)).status,500);
        assert.equal(requests.length,count);

        delete env.MEDIA_PUBLIC_S3;
        Object.assign(env,{B2_ENDPOINT:privateTarget.endpoint_url,B2_PUBLIC_BUCKET:'public-images',
            B2_PRIVATE_BUCKET:'private-images',B2_KEY_ID:'b2-key',B2_APPLICATION_KEY:'b2-secret'});
        assert.equal((await get(path)).status,200);
        assert.ok(requests.at(-1).url.startsWith(privateTarget.endpoint_url+'/public-images/'));
        assert.match(requests.at(-1).auth,/Credential=b2-key\//);
        """
        self.run_node_esm(body)

    def test_b2_failures_keep_status_without_leaking_storage_details(self):
        """B2 拒绝读取时保留请求方法与状态码，不能当作缺图或泄漏错误正文。"""
        body = """
        const {default:worker} = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const logs=[],calls=[],original=console.error;
        console.error=(...args)=>logs.push(args);
        const env={SECRET_KEY:'admin',B2_ENDPOINT:'https://s3.us-west-004.backblazeb2.com',
            B2_PUBLIC_BUCKET:'public-photos',B2_PRIVATE_BUCKET:'private-photos',
            B2_KEY_ID:'sensitive-key-id',B2_APPLICATION_KEY:'sensitive-key-secret',
            PUBLIC_MEDIA_READS:'true'};
        let cancelled=false,pulls=0,status=403;
        globalThis.fetch=async(url,options)=>{
            calls.push(options.method);
            if(options.method==='HEAD')return new Response(null,{status});
            return new Response(new ReadableStream({pull(controller){
                pulls++;
                controller.enqueue(new TextEncoder().encode(pulls===1
                    ? '<Error><Code>AccessDenied</Code><Message>sensitive-key-secret/private/path</Message>'
                    : 'x'.repeat(1024)));
            },cancel(){cancelled=true;}}),{status:403});
        };
        const call=(path,options={})=>worker.fetch(new Request('https://relay.example'+path,
            {headers:{'x-sync-key':'admin'},...options}),env,{});
        const head=()=>call('/photos/images/travel/a.png',{method:'HEAD'});
        try {
            const ping=await call('/api/ping');
            assert.equal(ping.status,500);
            assert.equal(cancelled,true);assert.ok(pulls<=7,'错误正文只读取有限长度并关闭流');
            assert.deepEqual(logs.at(-1)[1].upstream,{provider:'b2',method:'GET',status:403,code:'AccessDenied'});
            assert.doesNotMatch(await ping.text(),/AccessDenied|sensitive|private[/]path/);
            calls.length=0;
            assert.equal((await head()).status,500);
            assert.deepEqual(calls,['HEAD'],'403 不是对象不存在');
            assert.deepEqual(logs.at(-1)[1].upstream,{provider:'b2',method:'HEAD',status:403,code:undefined});
            assert.doesNotMatch(JSON.stringify(logs),/sensitive|private[/]path/);
            status=404;calls.length=0;
            assert.equal((await head()).status,404);
            assert.deepEqual(calls,['HEAD']);
        } finally {console.error=original;}
        """
        self.run_node_esm(body)

    def test_kv_image_limits_and_ack_are_visible(self):
        """验证原图大小边界、额度提示、预览鉴权和成功合并后的清理。"""
        body = """
        const {File} = await import('node:buffer'); globalThis.File = File;
        const {default:worker} = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const {cloudImageError, cloudflareRelay} = await import('./data-manage/sync/cloudflare-relay.module.js');
        const kv = memoryKV();
        const env = {SECRET_KEY:'admin', KV:kv, PUBLIC_MEDIA_READS:'true',
            PUBLIC_PHOTOS_BUCKET:{get:async()=>null,put:()=>assert.fail('formal write')}};
        const call=(path, options={})=>worker.fetch(new Request(new URL(path,'https://relay.example'),options),env,{});
        const auth = {'x-sync-key':'admin'};
        const max = 25 * 1024 * 1024;
        const data = new Uint8Array(max);
        data.set([137,80,78,71,13,10,26,10]);
        const make = extra => new File([data, extra], 'a.png', {type:'image/png'});
        const requestId=crypto.randomUUID();
        const upload = file => {
            const form = new FormData();
            form.set('file', file);
            form.set('registration',JSON.stringify({requestId,timestamp:Date.now(),tags:[]}));
            return call('/api/drafts/upload',{method:'POST',headers:auth,body:form});
        };
        assert.match(cloudImageError(make('x')),/25 MiB/);
        const tooLarge = await upload(make('x'));
        assert.equal(tooLarge.status,413);
        assert.match((await tooLarge.json()).error,/25 MiB/);
        assert.equal(kv.entries.size,0);
        const put = kv.put;
        for (const [failure, status, hint] of [
            ['KV PUT failed: 429 Too Many Requests',429,/频率或额度/],
            ['KV PUT failed: 403 daily write quota exceeded',429,/今日写入额度/],
            ['KV PUT failed: 507 Namespace storage limit reached',507,/空间已满/]
        ]) {
            kv.put=async()=>{throw Error(failure)};
            const denied=await upload(new File([data.slice(0,16)],'a.png'));
            assert.equal(denied.status,status);
            assert.match((await denied.json()).error,hint);
        }
        kv.put = put;
        const accepted = await upload(make(''));
        assert.equal(accepted.status,200);
        const {path, relPath}=await accepted.json();
        assert.equal((await call('/'+relPath)).status,404);
        assert.equal((await call(path.replace(/p=.*/,'p='+crypto.randomUUID()))).status,404);
        const download='/api/drafts/media?path='+encodeURIComponent(relPath);
        assert.equal((await call(download)).status,401);
        const raw=await call(download,{headers:auth});
        assert.equal(raw.headers.get('x-maers-image-size'),String(max));
        assert.equal((await raw.arrayBuffer()).byteLength,max);
        globalThis.fetch = (url, options) => call(url, options);
        const pulled=await cloudflareRelay.pull('https://relay.example','admin');
        assert.equal(pulled.items.length,1);
        assert.deepEqual(pulled.media,[[relPath,path]]);
        assert.equal((await cloudflareRelay.ack('https://relay.example','admin',
            pulled.items.map(item=>item.key),[relPath])).success,true);
        assert.equal(kv.entries.size,0);
        const missing=await call(download,{headers:auth});
        assert.equal(missing.status,404);
        assert.match((await missing.json()).error,/30 天/);
        """
        self.run_node_esm(body, preamble=(MOCK_KV,))

    def test_worker_routes_selected_buckets_with_stable_paths_and_private_permissions(self):
        """跨账号草稿只记录目标桶组，已发布媒体仍按原路径和密码组读取。"""
        body = r"""
        const { File } = await import('node:buffer');
        globalThis.File = File;
        const { default: worker } = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256',
            new TextEncoder().encode(value))).toString('hex');
        const group = 'g_' + 'a'.repeat(32);
        const token = 'a'.repeat(64);
        const objects = new Map();
        const account = 'b'.repeat(32);
        const target = (bucket_name, provider = 'r2') => ({ provider, bucket_name, access_key_id: 'id',
            secret_access_key: 'secret', endpoint_url: provider === 'r2' ? `https://${account}.r2.cloudflarestorage.com` :
                'https://s3.us-west-004.backblazeb2.com' });
        const env = {
            SECRET_KEY: 'admin', MEDIA_PUBLIC_BASE: 'https://read.example', PUBLIC_MEDIA_READS: 'true',
            PUBLIC_CONTENT_READS: 'true', MEDIA_PUBLIC_S3: JSON.stringify(target('old-public')),
            MEDIA_PRIVATE_S3: JSON.stringify(target('old-private')),
            MEDIA_BUCKET_GROUPS: JSON.stringify({ archive: { public: target('next-public', 'b2'),
                private: target('next-private') } }), MEDIA_METADATA_BUCKET: 'archive',
            MEDIA_PHOTO_BUCKETS: JSON.stringify({ public: 'archive', private: 'archive' }),
            KV: memoryKV()
        };
        const legacy = 'photos/images/travel/old.png';
        const png = Uint8Array.of(137,80,78,71,13,10,26,10);
        objects.set('old-public/' + legacy, png);
        objects.set('old-private/_maers/private-tokens/' + group + '.json', JSON.stringify({ hash: await hash(token) }));
        globalThis.fetch = async (url, options) => {
            const key = decodeURIComponent(new URL(url).pathname.slice(1));
            assert.notEqual(options.method, 'PUT', '上传草稿不得触发正式桶写入');
            if (!objects.has(key)) return new Response(null, { status: 404 });
            return new Response(options.method === 'HEAD' ? null : objects.get(key), { headers: { ETag: '"object"' } });
        };
        const send = (path, options) => worker.fetch(new Request('https://read.example' + path, options), env, {});
        const headers = { 'x-sync-key': 'admin' };
        assert.equal((await send('/api/storage/buckets')).status, 401);
        assert.deepEqual(await (await send('/api/storage/buckets', { headers })).json(), { buckets: ['default', 'archive'] });
        const upload = id => {
            const form = new FormData();
            form.set('file', new File([png], 'same-name.png'));
            form.set('category', 'travel');
            if (id) form.set('bucketId', id);
            form.set('registration', JSON.stringify({ requestId: '12345678-1234-4123-8123-123456789012',
                timestamp: 1794127684613, tags: [] }));
            return send('/api/drafts/upload', { headers, method: 'POST', body: form });
        };
        const response = await upload();
        assert.equal(response.status, 200);
        const photo = await response.json();
        assert.equal(photo.bucketId, 'archive');
        assert.equal(objects.has('next-public/' + photo.relPath),false);
        assert.equal((await send('/' + photo.relPath)).status, 404);
        assert.equal((await send(new URL(photo.path).pathname + new URL(photo.path).search)).status, 200);
        assert.equal((await send('/' + legacy)).status, 200);
        env.MEDIA_PHOTO_BUCKETS = JSON.stringify({ public: 'default', private: 'archive' });
        assert.equal((await (await upload()).json()).bucketId, 'archive');
        assert.equal((await upload('default')).status, 409);
        assert.equal((await (await send('/api/pull?cursor=', { headers })).json()).items[0].data.data.bucketId, 'archive');

        const form = new FormData();
        form.set('file', new File([png], 'private.png'));
        const privateResponse = await send('/api/drafts/upload?g=' + group, {
            headers: { ...headers, 'x-private-media-token': token }, method: 'POST', body: form
        });
        assert.equal(privateResponse.status, 200);
        const privatePhoto = await privateResponse.json();
        assert.equal(privatePhoto.bucketId, 'archive');
        assert.equal(objects.has('next-private/' + privatePhoto.relPath),false);
        assert.equal((await send('/' + privatePhoto.relPath)).status, 404);
        assert.equal((await send('/private/' + privatePhoto.relPath + '?draft=1&g=' + group + '&t=' + token)).status, 200);

        const note = 'markdown/notes/plain.md';
        const secret = 'markdown/notes/secret.md';
        const route = JSON.stringify({ bucketId: 'archive', target: `b2:next-public|r2:${account}/next-private` });
        // 旧环境变量不改变记录位置，归属和权限继续从默认私密桶读取。
        objects.set('old-private/_maers/content-buckets/' + await hash(note) + '.json', route);
        objects.set('old-private/_maers/content-buckets/' + await hash(secret) + '.json', route);
        objects.set('next-public/' + note, 'public markdown');
        objects.set('next-private/' + secret, 'private markdown');
        objects.set('old-private/_maers/content-groups/' + await hash(secret) + '.json',
            JSON.stringify({ key: secret, groups: [group] }));
        assert.equal(await (await send('/' + note)).text(), 'public markdown');
        assert.equal((await send('/' + secret)).status, 404);
        assert.equal(await (await send('/private/' + secret + '?g=' + group + '&t=' + token)).text(), 'private markdown');

        env.PUBLIC_CONTENT_PATH_PREFIX = '/file/next-public';
        const rewritten = '/file/next-public/' + note;
        const publicResponse = await send(rewritten);
        assert.equal(publicResponse.status, 200);
        assert.equal(publicResponse.headers.get('Access-Control-Allow-Origin'), '*');
        assert.equal(await publicResponse.text(), 'public markdown');
        const head = await send(rewritten, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
        assert.equal((await send('/file/next-public/' + secret)).status, 404);
        assert.equal((await send('/file/next-private/' + note)).status, 401);
        assert.equal((await send('/file/next-public/private/' + secret)).status, 401);
        assert.equal((await send(rewritten, { method: 'POST' })).status, 401);
        assert.equal(await (await send('/' + note)).text(), 'public markdown');
        env.PUBLIC_CONTENT_READS = 'false';
        assert.equal((await send(rewritten)).status, 401);
        """
        self.run_node_esm(body, preamble=(MOCK_KV,))

    def test_b2_media_signature_and_password_group_boundary(self):
        """B2 请求签名与官方 SDK 一致，缺图和密码组鉴权保持原协议。"""
        import datetime
        import json
        from unittest import mock
        from botocore.auth import S3SigV4Auth
        from botocore.awsrequest import AWSRequest
        from botocore.config import Config
        from botocore.credentials import Credentials
        body = r"""
        const NativeDate = Date;
        globalThis.Date = class extends NativeDate { constructor(...args) {super(...(args.length?args:['2026-11-07T00:00:00Z']));} };
        const {default:worker} = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const calls = [], token = 'group-token', png = Uint8Array.of(137,80,78,71,13,10,26,10);
        const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))))
            .map(v=>v.toString(16).padStart(2,'0')).join('');
        const env = {SECRET_KEY:'admin',B2_ENDPOINT:'https://s3.us-west-004.backblazeb2.com',
            B2_PUBLIC_BUCKET:'public-photos',B2_PRIVATE_BUCKET:'private-photos',B2_KEY_ID:'test-id',
            B2_APPLICATION_KEY:'test-secret',PRIVATE_TOKEN_HASH:await hash(token)};
        globalThis.fetch = async (url,options) => {
            calls.push({url,method:options.method,authorization:options.headers.get('Authorization')});
            assert.equal(options.redirect,'manual');
            if(url.includes('/_maers/media-groups/')||url.includes('/missing.png'))return new Response(null,{status:404});
            if(options.method==='PUT')return new Response(null,{status:200});
            return new Response(options.method==='HEAD'?null:png,{headers:{'Content-Type':'image/png','ETag':'"image-etag"'}});
        };
        const media = (key,t=token,method='GET') => worker.fetch(new Request('https://relay.example/private/'+key+'?t='+t,{method}),env,{});
        assert.equal((await media('photos/images/travel/a.png','wrong')).status,403);
        assert.equal(calls.length,0);
        const key = 'photos/images/travel/照片 (1).png';
        const response = await media(key);
        assert.equal(response.status,200); assert.equal(response.headers.get('Cache-Control'),'no-store');
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()),png);
        const head = await media(key,token,'HEAD');
        assert.equal(head.status,200); assert.equal(await head.text(),'');
        assert.equal((await media('photos/images/travel/missing.png')).status,404);
        const update = await worker.fetch(new Request('https://relay.example/api/private-token',{
            method:'POST',headers:{'x-sync-key':'admin'},body:JSON.stringify({hash:await hash('replacement')})}),env,{});
        assert.equal(update.status,200);
        const previous = calls.length;
        env.B2_PUBLIC_BUCKET = env.B2_PRIVATE_BUCKET;
        assert.equal((await media(key)).status,500); assert.equal(calls.length,previous);
        console.log(JSON.stringify(calls));
        """
        calls = json.loads(self.run_node_esm(body))
        for call in calls:
            request = AWSRequest(method=call['method'], url=call['url'],
                                 headers={'x-amz-content-sha256': 'UNSIGNED-PAYLOAD'})
            request.context['client_config'] = Config(s3={'payload_signing_enabled': False})
            with mock.patch('botocore.auth.get_current_datetime', return_value=datetime.datetime(2026, 11, 7)):
                S3SigV4Auth(Credentials('test-id', 'test-secret'), 's3', 'us-west-004').add_auth(request)
            self.assertEqual(call['authorization'], request.headers['Authorization'])

    def test_25_pending_cover_survives_refresh_and_can_be_removed(self):
        """待 Git 的封面上传在当前页及全新会话回放生效，取消封面也不能恢复旧图。"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const config = {mode:'relay',relay:{endpoint:'https://relay.example',secret:'test'}};
        const queue = [];
        globalThis.fetch = async (url, options = {}) => {
            if (url.endsWith('/push')) queue.push(JSON.parse(options.body));
            return {ok:true,json:async()=>({id:'queued',items:queue.map(data=>({data}))})};
        };
        const freshState = () => {
            const node = {id:'book',type:'note',title:'书',coverImage:'old.png'};
            return {root:[node],allNodes:[node]};
        };
        const manager = new SyncManager(); manager.config = config;
        const state = freshState();
        const cover = 'photos/images/literaturecovers/mobile.jpg';
        await manager.handleRelayAction('literature','update',{id:'book',data:{coverImage:cover}},state);
        assert.equal(state.root[0].coverImage, cover);
        const refreshed = new SyncManager(); refreshed.config = config;
        assert.equal(refreshed.localPendingSessionItems.length, 0);
        const afterReload = freshState();
        await refreshed.applyPendingToState('literature',afterReload);
        assert.equal(afterReload.root[0].coverImage, cover);
        await manager.handleRelayAction('literature','update',{id:'book',data:{coverImage:null}},state);
        assert.equal(state.root[0].coverImage, null);
        await refreshed.applyPendingToState('literature',afterReload);
        assert.equal(afterReload.root[0].coverImage, null);
        """
        self.run_node_esm(body, preamble=(
            MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html', hostname='example.com', is_admin=True),
        ))

