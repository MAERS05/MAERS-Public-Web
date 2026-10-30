# -*- coding: utf-8 -*-
"""套件 08：基于 Node.js 原生 ESM 与 WebCrypto 的前端语法校验、E2EE、脱敏、中继同步与 Markdown 管线实测"""

import json

from .helpers import frontend_js_files
from .node_runtime import (
    MOCK_DOM, MOCK_LOCAL_STORAGE, MOCK_SESSION_STORAGE, NodeTestCase, mock_window,
)


class Test08_FrontendJsRuntimeAndE2EECrypto(NodeTestCase):
    """基于 Node.js 原生 ESM 与 WebCrypto 对全站 JS 语法、E2EE 密钥环、CMS 脱敏与同步队列进行真实运行时验证"""

    def test_30_photo_cloud_git_only_prompts_local_processing_and_keeps_queue(self):
        """图片和混合草稿仅提示电脑本地 Git，不发请求、不清理队列，原有文字提交仍可使用。"""
        body = """
        const { GitCommitManager } = await import('./data-manage/sync/git-commit.module.js');
        const { githubSync } = await import('./data-manage/sync/github-sync.module.js');
        const manager = new GitCommitManager();
        manager.githubConfig = {token:'fake',repo:'owner/repo',branch:'main'};
        let commits = 0, requests = 0;
        githubSync.commitFiles = async () => {commits++; return {success:true,commitSha:'abc1234'}};
        globalThis.fetch = async () => {requests++; throw Error('图片草稿不能触发云端写入或清理')};
        const photo = {module:'photos',action:'upload',data:{category:'travel',path:'photos/images/travel/a.jpg'}};
        const note = {key:'note',data:{module:'notes',action:'update',data:{id:'n',data:{title:'Entry',content:'body'}}}};
        const queue = [{key:'photo',data:photo},note];
        const saved = JSON.stringify(queue);
        for (const items of [queue,[{key:'photo',data:photo}],[photo]]) {
            const result = await manager.commitDraftsViaGitHub({items,relayConfig:{endpoint:'https://relay.example',secret:'fake'},
                currentModuleName:'notes',currentModuleTree:[{id:'n',type:'note',title:'Entry',content:'notes/Entry.md'}]});
            assert.equal(result.success,false);
            assert.match(result.msg,/图片请在电脑本地 Git/);
            assert.match(result.msg,/WebP\\/AVIF/);
        }
        manager.githubConfig.token = '';
        assert.match((await manager.commitDraftsViaGitHub({items:queue})).msg,/图片请在电脑本地 Git/);
        assert.equal(commits,0); assert.equal(requests,0); assert.equal(JSON.stringify(queue),saved);
        manager.githubConfig.token = 'fake';
        assert.equal((await manager.commitDraftsViaGitHub({items:[note]})).success,true);
        assert.equal(commits,1); assert.equal(requests,0);
        """
        self.run_node_esm(body, preamble=(MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-photos.html', hostname='maersy.com')))

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
            MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html', hostname='maersy.com', is_admin=True),
        ))

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
        globalThis.fetch = async url => {
            assert.equal(url, 'https://relay.example/api/pull');
            return {ok:true, json:async()=>({items:queue.map((data,i)=>({key:String(i),data}))})};
        };
        assert.equal(syncManager.localPendingSessionItems.length, 0, '模拟刷新后的全新页面');
        const fresh = await reloadData();
        assert.deepEqual(fresh.map(row=>row.name || row.id), ['b.jpg','a.jpg','published']);
        assert.equal(fresh[0].thumb, 'photos/images/travel/b.jpg', '未合并前直接使用原图');
        assert.equal(fixPath(fresh[0].preview), 'https://cdn.example/photos/images/travel/b.jpg');
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
        globalThis.fetch = async()=>{visitorPulls++; return {ok:true,json:async()=>({items:[]})}};
        assert.equal((await reloadData()).length, 2);
        assert.equal(visitorPulls, 0, '访客不应拉取管理队列');
        """
        self.run_node_esm(body, preamble=(
            MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-photos.html', hostname='maersy.com', is_admin=True),
        ))

    def test_23_cover_index_real_paths_private_urls_refresh_and_retry(self):
        """封面索引支持 CDN URL，保留私密凭证；未登记时使用原图，刷新与失败重试有效。"""
        body = """
        const { DataProvider } = await import('./data-manage/data-provider.module.js');
        let requests = 0, unavailable = true;
        let rows = [{ path:'photos/images/gamecovers/a.png', thumb:'photos/thumbnails/gamecovers/hash.webp',
            preview:'photos/previews/gamecovers/hash.avif' },
            {path:'photos/images/gamecovers/literal .png',thumb:'space.webp'},
            {path:'photos/images/gamecovers/literal%20.png',thumb:'percent.webp'}];
        globalThis.fetch = async () => {
            requests++;
            if (unavailable) throw new Error('offline');
            return {ok:true,json:async()=>({gamecovers: rows})};
        };
        const node = {coverImage:'photos/images/gamecovers/a.png'};
        assert.equal(await DataProvider.loadCoverIndex(), false);
        assert.equal(DataProvider.getCoverUrl(node), node.coverImage);
        unavailable = false;
        await Promise.all([DataProvider.loadCoverIndex(), DataProvider.loadCoverIndex()]);
        assert.equal(requests, 2, '并发消费者共用一次索引请求');
        assert.equal(DataProvider.getCoverUrl(node), rows[0].preview);
        assert.equal(DataProvider.getCoverUrl({coverImage:'https://cdn.example/'+node.coverImage+'?v=1'}, 'thumb'), rows[0].thumb);
        assert.equal(DataProvider.getCoverUrl({coverImage:'https://cdn.example/photos/images/gamecovers/literal%20.png'}), 'space.webp');
        assert.equal(DataProvider.getCoverUrl({coverImage:'https://cdn.example/photos/images/gamecovers/literal%2520.png'}), 'percent.webp');
        assert.equal(DataProvider.getCoverUrl({coverImage:'photos/images/gamecovers/literal%20.png'}), 'percent.webp');
        const privateNode = {...node, coverThumb:'https://private.example/thumb?t=secret', coverPreview:'https://private.example/preview?t=secret'};
        assert.equal(DataProvider.getCoverUrl(privateNode, 'thumb'), privateNode.coverThumb);
        assert.equal(DataProvider.getCoverUrl(privateNode), privateNode.coverPreview);
        assert.equal(DataProvider.getCoverUrl({...node,coverPreview:privateNode.coverPreview},'thumb'), privateNode.coverPreview);
        const external = {coverImage:'https://external.example/unregistered.png'};
        assert.equal(DataProvider.getCoverUrl(external), external.coverImage);
        assert.equal(DataProvider.getCoverUrl({}), null);
        assert.deepEqual(node, {coverImage:'photos/images/gamecovers/a.png'}, '展示不能把衍生路径写入正文数据');
        rows = [{...rows[0], preview:'photos/previews/gamecovers/refreshed.avif'}];
        await DataProvider.loadCoverIndex({refresh:true});
        assert.equal(requests, 3);
        assert.equal(DataProvider.getCoverUrl(node), rows[0].preview);
        """
        self.run_node_esm(body, preamble=(mock_window('/games.html'),))

    def test_22_worker_upload_uuids_survive_same_second_and_random_number(self):
        """固定时钟和旧随机源，并发上传同名及混合格式图片，公私桶文件均不能重名。"""
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
        const publicObjects = new Map(), privateObjects = new Map();
        const bucket = objects => ({ async put(key, bytes, metadata) {
            objects.set(key, { bytes: new Uint8Array(bytes), metadata });
        } });
        const env = { SECRET_KEY: 'test', PUBLIC_PHOTOS_BUCKET: bucket(publicObjects),
            PRIVATE_PHOTOS_BUCKET: bucket(privateObjects), PUBLIC_CUSTOM_DOMAIN: 'https://cdn.example' };
        const upload = async (index, scope = 'public') => {
            const extension = index % 2 ? 'jpg' : 'png';
            const form = new FormData();
            form.set('file', new File([`image-${index}`], `same.${extension}`, { type: `image/${extension}` }));
            form.set('category', 'travel'); form.set('scope', scope);
            const response = await worker.fetch(new Request('https://worker.example/api/upload', {
                method: 'POST', headers: { 'x-sync-key': 'test' }, body: form }), env, {});
            assert.equal(response.status, 200);
            const result = await response.json();
            assert.match(result.name, new RegExp(`^[0-9]{8}_[0-9]{6}_[a-f0-9]{32}\\\\.${extension}$`));
            const stored = (scope === 'public' ? publicObjects : privateObjects).get(result.relPath);
            assert.equal(new TextDecoder().decode(stored.bytes), `image-${index}`);
            assert.equal(stored.metadata.httpMetadata.contentType, `image/${extension}`);
            return result;
        };
        const results = await Promise.all(Array.from({ length: 40 }, (_, index) => upload(index)));
        assert.equal(new Set(results.map(result => result.relPath)).size, 40);
        assert.equal(new Set(results.map(result => result.name.split('.')[0])).size, 40);
        assert.equal(publicObjects.size, 40);
        for (const result of results) {
            assert.equal(result.path, `https://cdn.example/${result.relPath}`);
        }
        const privateResult = await upload(41, 'private');
        assert.equal(privateResult.isPrivate, true);
        assert.ok(privateResult.path.startsWith('/api/private-file?key='));
        assert.equal(privateObjects.size, 1);
        """
        self.run_node_esm(body)

    def test_18_inline_media_manifest_and_private_reader_urls(self):
        """正文插图清单加密保存，解密阅读使用私有地址；缺图时阻止加锁。"""
        body = """
        const { randomBytes, setSessionKeyRaw, getSessionKey, unwrapRecord } = await import('./data-manage/encrypt/crypto.module.js');
        const { packCmsNodeForLock, collectCmsPrivateCoverKeys } = await import('./data-manage/encrypt/admin-lock.module.js');
        const { unpackRevealedNode } = await import('./data-manage/encrypt/private-media.module.js');
        setSessionKeyRaw(randomBytes(32));
        const row = { id:'img', path:'photos/images/_notes/a.png', thumb:'photos/thumbnails/_notes/a.webp', preview:'photos/previews/_notes/a.avif' };
        globalThis.fetch = async () => ({ok:true,json:async()=>({_notes:[row]})});
        const md = '![inline](../'+row.thumb+') <img src="https://media.example.com/'+row.path+'">';
        const packed = await packCmsNodeForLock({id:'n',type:'note',title:'私密',content:md});
        assert.deepEqual(packed.covers,[row.path]);
        const tree = await unwrapRecord({_enc:packed.enc},await getSessionKey());
        assert.deepEqual(tree.mediaRows.map(r=>r.path),[row.path]);
        assert.equal(tree.md,md);
        const revealed = unpackRevealedNode(tree,k=>'https://private.example/'+k+'?t=token');
        assert.ok(revealed.content.includes('https://private.example/'+row.thumb+'?t=token'));
        assert.ok(!revealed.content.includes('media.example.com'));
        assert.ok(!unpackRevealedNode(tree).content.includes('media.example.com'));
        assert.deepEqual((await collectCmsPrivateCoverKeys({_enc:packed.enc})).sort(),[row.path,row.thumb,row.preview].sort());
        await assert.rejects(packCmsNodeForLock({id:'missing',type:'note',content:'![x](photos/images/_notes/missing.png)'}),/正文图片/);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_DOM, mock_window('/admin-cms.html')))

    def test_19_relay_refresh_reuses_backend_receipt_after_ack_failure(self):
        """确认失败后重建页面管理器，携带同一回执身份，避免重放已入库的新增。"""
        body = """
        const {SyncManager}=await import('./data-manage/sync/sync-manager.module.js');
        let ackOk=false, applied=0;
        const receipts=new Set();
        let queue=[{key:'sync_1',data:{module:'notes',action:'add',data:{id:'n',title:'草稿'},timestamp:1}}];
        globalThis.fetch=async(url,options={})=>{
            const ok=data=>({ok:true,json:async()=>data});
            if(url.endsWith('/api/crypto/admin-status'))return ok({has_encrypted:false});
            if(url.endsWith('/api/session'))return ok({token:'session'});
            if(url.endsWith('/pull'))return ok({items:queue});
            if(url.endsWith('/ack')){if(ackOk)queue=[];return {ok:ackOk};}
            const body=JSON.parse(options.body);
            assert.deepEqual(body._relay,{source:'https://relay.example',key:'sync_1'});
            const identity=JSON.stringify(body._relay);
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

    def test_20_theme_binds_switch_created_after_initialization(self):
        """后台先初始化主题、后注入按钮时，点击仍须应用主题并保存状态。"""
        body = r"""
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        const classes = new Set(), frames = [], listeners = new Map();
        const values = new Map([['theme','dark-mode'], ['autoThemeConfig',JSON.stringify({version:2,mode:'manual'})]]);
        let checkbox = null;
        const context = vm.createContext({ console, setTimeout, clearTimeout,
            requestAnimationFrame: callback => frames.push(callback),
            localStorage: {getItem:key=>values.get(key)??null, setItem:(key,value)=>values.set(key,value)},
            document: {querySelector:()=>checkbox,getElementById:()=>null,
                addEventListener:(name,callback)=>listeners.set(name,callback),
                documentElement:{offsetWidth:100,style:{removeProperty(){}},classList:{
                    contains:name=>classes.has(name),add:name=>classes.add(name),
                    remove:(...names)=>names.forEach(name=>classes.delete(name)),
                    toggle:(name,on)=>on?classes.add(name):classes.delete(name)}}},
            window:{matchMedia:()=>({matches:false,addEventListener(){}})}
        });
        const module = new vm.SourceTextModule(fs.readFileSync('shared/theme/theme-core.module.js','utf8'),{context});
        await module.link(()=>{throw Error('unexpected import');});
        await module.evaluate();
        module.namespace.initThemeCore();
        checkbox={checked:true,matches:selector=>selector==='.theme-switch-checkbox'};
        const click=()=>{checkbox.checked=!checkbox.checked;listeners.get('change')?.({target:checkbox});};
        const flush=()=>{while(frames.length)frames.shift()();};
        click();flush();
        assert.equal(classes.has('light-mode'),true,'按钮后注入也必须切换整页主题');
        assert.equal(values.get('theme'),'light-mode');
        assert.equal(checkbox.checked,false);
        click();flush();
        assert.equal(classes.has('light-mode'),false);
        click();click();flush();
        assert.equal(classes.has('light-mode'),false,'连续点击的目标状态不能丢失');
        assert.equal(checkbox.checked,true);
        """
        self.run_node_esm(body, node_args=('--experimental-vm-modules', '--no-warnings'))

    def test_21_navigation_request_shared_and_retryable(self):
        """导航消费者复用并发请求、互不修改卡片，失败后可重试。"""
        body = """
        const { getNavData } = await import('./shared/spatial-nav.module.js');
        let requests = 0;
        globalThis.fetch = async () => {
            requests++;
            if (requests === 1) return Response.json({}, { status: 503 });
            if (requests === 2) return Response.json({ invalid: true });
            return Response.json([{ id: 'notes', title: '笔记', url: 'notes.html' }]);
        };
        await assert.rejects(getNavData(), /503/);
        await assert.rejects(getNavData(), /数组/);
        const [home, spatial] = await Promise.all([getNavData(), getNavData()]);
        assert.equal(requests, 3);
        home[0].title = '已修改';
        home.push({ id: 'new' });
        assert.equal(spatial[0].title, '笔记');
        assert.equal(spatial.length, 1);
        assert.equal((await getNavData())[0].title, '笔记');
        assert.equal(requests, 3);
        """
        self.run_node_esm(body)

    def test_01_all_js_modules_syntax_valid(self):
        """全站 custom/、shared/、data-manage/ 与 Service Worker 全部 JS 通过 V8 模块语法编译"""
        js_files = list(frontend_js_files()) + ['maers-version-controller.js']
        body = f"""
        const fs = (await import('node:fs')).default;
        const vm = (await import('node:vm')).default;
        assert.equal(typeof vm.SourceTextModule, 'function', 'vm.SourceTextModule 不可用，无法进行语法校验');
        const errors = [];
        for (const rel of {json.dumps(js_files)}) {{
            try {{
                new vm.SourceTextModule(fs.readFileSync(rel, 'utf8'), {{ identifier: rel }});
            }} catch (e) {{
                errors.push(rel + ': ' + e.message);
            }}
        }}
        assert.deepEqual(errors, [], 'JS 语法错误:\\n' + errors.join('\\n'));
        """
        self.run_node_esm(body, node_args=('--experimental-vm-modules', '--no-warnings'))

    def test_02_webcrypto_aes_gcm_and_keyring_lifecycle(self):
        """AES-256-GCM 加解密、双层密钥环派生、改密不改 DEK、恢复码重置与错误口令拒绝"""
        body = """
        const {
            ENC_FIELD, importDataKey, wrapRecord, unwrapRecord, isEncryptedString, isEncryptedRecord,
            setSessionKeyRaw, getSessionKey, getSessionKeyRaw, clearSessionKey,
            getAccessToken, getAccessTokenHash
        } = await import('./data-manage/encrypt/crypto.module.js');
        const {
            isValidKeyring, createKeyring, unlockWithPassword, unlockWithRecovery,
            rewrapPassword, regenerateRecovery
        } = await import('./data-manage/encrypt/keyring.module.js');

        // 1. 创建双层密钥环并校验结构
        const { keyring, recoveryCode, dekRaw } = await createKeyring('MasterPass#2026', 'https://worker.example.com/');
        assert.equal(isValidKeyring(keyring), true);
        const publicRing = { v: keyring.v, dek_id: keyring.dek_id, pw: keyring.pw, media_base: keyring.media_base };
        assert.equal(isValidKeyring(publicRing), true);
        assert.deepEqual(await unlockWithPassword(publicRing, 'MasterPass#2026'), dekRaw);
        assert.equal(keyring.dek_id.length, 16);

        // 2. 主密码与（小写、空格分隔的）恢复码均解出同一 DEK，错误口令返回 null
        assert.deepEqual(await unlockWithPassword(keyring, 'MasterPass#2026'), dekRaw);
        assert.deepEqual(await unlockWithRecovery(keyring, recoveryCode.toLowerCase().replace(/-/g, ' ')), dekRaw);
        assert.equal(await unlockWithPassword(keyring, 'WrongPassword!'), null);
        assert.equal(await unlockWithRecovery(keyring, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH'), null);

        // 3. 会话密钥存取与访问令牌派生（同一 DEK 派生结果稳定）
        setSessionKeyRaw(dekRaw);
        const sessionKey = await getSessionKey();
        assert.ok(sessionKey);
        assert.deepEqual(getSessionKeyRaw(), dekRaw);
        const token = await getAccessToken();
        assert.equal(token.length, 64);
        assert.equal((await getAccessTokenHash()).length, 64);
        assert.equal(await getAccessToken(), token);

        // 4. 记录级加密往返；两次加密同一明文必须产生不同密文（随机 IV）
        const sample = { id: 'n_1', title: '绝密设计稿', tags: ['E2EE', 'AES-GCM'], nested: { count: 42 } };
        const wrapped = await wrapRecord(sample, sessionKey);
        assert.equal(isEncryptedRecord(wrapped), true);
        assert.equal(isEncryptedString(wrapped[ENC_FIELD]), true);
        assert.ok(!wrapped[ENC_FIELD].includes('绝密'));
        assert.notEqual((await wrapRecord(sample, sessionKey))[ENC_FIELD], wrapped[ENC_FIELD]);
        assert.deepEqual(await unwrapRecord(wrapped, sessionKey), sample);

        // 5. 改密后 dek_id 不变、旧密码失效、旧密文仍可解
        const rotated = await rewrapPassword(keyring, dekRaw, 'NewMasterPass#9999');
        assert.equal(rotated.dek_id, keyring.dek_id);
        assert.equal(await unlockWithPassword(rotated, 'MasterPass#2026'), null);
        const byNewPw = await unlockWithPassword(rotated, 'NewMasterPass#9999');
        assert.deepEqual(byNewPw, dekRaw);
        assert.deepEqual(await unwrapRecord(wrapped, await importDataKey(byNewPw)), sample);

        // 6. 重新生成恢复码后旧码立即失效
        const { keyring: regen, recoveryCode: newRc } = await regenerateRecovery(rotated, dekRaw);
        assert.equal(await unlockWithRecovery(regen, recoveryCode), null);
        assert.deepEqual(await unlockWithRecovery(regen, newRc), dekRaw);

        clearSessionKey();
        assert.equal(await getSessionKey(), null);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE,))

    def test_03_cms_node_pack_unpack_and_lock_tree_state(self):
        """packCmsNodeForLock 打包 -> unpackRevealedNode 还原 -> extractLockedNodes / applyLockActionLocally 状态机"""
        fetch_mock = """
        globalThis.fetch = async (url) => {
            if (url === 'data/photos-data.json') {
                return { ok: true, json: async () => ({ _notes: [{
                    id: 'p_cov1', name: 'c1.avif',
                    path: 'photos/images/_notes/c1.avif',
                    thumb: 'photos/thumbnails/_notes/c1.webp',
                    preview: 'photos/previews/_notes/c1.avif'
                }] }) };
            }
            if (url === 'data/notes/child.md') {
                return { ok: true, text: async () => '# 子笔记正文\\n内容引用末尾.md' };
            }
            return { ok: false, status: 404 };
        };
        """
        body = """
        const { randomBytes, setSessionKeyRaw, getSessionKey, unwrapRecord } = await import('./data-manage/encrypt/crypto.module.js');
        const { packCmsNodeForLock, collectCmsPrivateCoverKeys } = await import('./data-manage/encrypt/admin-lock.module.js');
        const { unpackRevealedNode, extractLockedNodes, applyLockActionLocally } = await import('./data-manage/encrypt/private-media.module.js');

        setSessionKeyRaw(randomBytes(32));
        const key = await getSessionKey();

        // 1. 打包含封面、子笔记及已加密兄弟节点的文件夹
        const folderNode = {
            id: 'f_sec', type: 'folder', title: '私密目录', tags: ['归档'],
            coverImage: 'https://media.example.com/photos/images/_notes/c1.avif',
            children: [{ id: 'n_sub', type: 'note', title: '子笔记', tags: ['A'], content: 'notes/child.md', coverImage: null }]
        };
        const existingLocked = [{ id: 'n_already_locked', parentId: 'f_sec', index: 0, _enc: 'enc:iv0.ct0' }];
        const packed = await packCmsNodeForLock(folderNode, existingLocked);
        assert.ok(packed && packed.enc.startsWith('enc:'));
        assert.ok(!packed.enc.includes('私密目录'), '密文中不得出现明文标题');
        assert.deepEqual(packed.covers, ['photos/images/_notes/c1.avif']);

        // 2. 提取三尺寸私有桶 Key
        assert.deepEqual(await collectCmsPrivateCoverKeys({ id: 'f_sec', _enc: packed.enc }), [
            'photos/images/_notes/c1.avif',
            'photos/thumbnails/_notes/c1.webp',
            'photos/previews/_notes/c1.avif'
        ]);

        // 3. 解包并转换为私有桶签名 URL
        const tree = await unwrapRecord({ _enc: packed.enc }, key);
        const revealed = unpackRevealedNode(tree, (k) => `https://worker.dev/private/${k}?t=tok123`);
        assert.equal(revealed.coverImage, 'https://worker.dev/private/photos/images/_notes/c1.avif?t=tok123');
        assert.equal(revealed.coverThumb, 'https://worker.dev/private/photos/thumbnails/_notes/c1.webp?t=tok123');
        assert.equal(revealed.children.length, 2);
        assert.equal(revealed.children[0].id, 'n_already_locked');
        assert.equal(revealed.children[0]._enc, 'enc:iv0.ct0');
        // 以 .md 结尾的正文应追加换行，防止被误判为路径
        assert.equal(revealed.children[1].content, '# 子笔记正文\\n内容引用末尾.md\\n');

        // 4. 内存锁定状态机
        const state = {
            root: [{ id: 'n_pub', type: 'note', title: '公开' }, { id: 'n_lock1', type: 'locked', _enc: 'enc:iv1.ct1' }],
            lockedNodes: [], allNodes: []
        };
        const flatten = (list) => list.forEach(n => { state.allNodes.push(n); if (n.children) flatten(n.children); });
        extractLockedNodes(state.root, state.lockedNodes);
        assert.equal(state.root.length, 1);
        assert.deepEqual(state.lockedNodes.map(n => [n.id, n.index]), [['n_lock1', 1]]);

        applyLockActionLocally(state, flatten, 'lock', { id: 'n_pub', enc: 'enc:iv_pub.ct_pub' });
        assert.equal(state.root.length, 0);
        assert.equal(state.lockedNodes.length, 2);

        applyLockActionLocally(state, flatten, 'unlock', {
            id: 'n_pub', tree: { id: 'n_pub', type: 'note', title: '公开还原', md: '还原正文' }
        });
        assert.equal(state.root.length, 1);
        assert.equal(state.root[0].title, '公开还原');
        assert.equal(state.root[0]._draftContent, '还原正文');
        assert.equal(state.root[0]._pendingRelay, true);

        applyLockActionLocally(state, flatten, 'delete', { id: 'n_lock1' });
        assert.equal(state.lockedNodes.length, 0);
        """
        self.run_node_esm(body, preamble=(
            MOCK_SESSION_STORAGE, MOCK_DOM, mock_window('/admin-cms.html', is_admin=True), fetch_mock,
        ))

    def test_04_secret_unlock_reveal_in_place_and_page_guard(self):
        """lockIndexCardRecord 生成 _guard；revealInPlace 访客态递归还原、管理态严格跳过"""
        body = """
        const { randomBytes, setSessionKeyRaw, getSessionKey, wrapRecord } = await import('./data-manage/encrypt/crypto.module.js');
        const { lockIndexCardRecord } = await import('./data-manage/encrypt/admin-lock.module.js');
        const { revealInPlace, pageGuardHash } = await import('./data-manage/encrypt/secret-unlock.module.js');

        setSessionKeyRaw(randomBytes(32));
        const key = await getSessionKey();

        // 1. 首页卡片加锁生成页面守卫哈希
        const lockedCard = await lockIndexCardRecord({ id: 'card_lit', title: '文学', url: 'literature.html' });
        assert.ok(lockedCard._enc);
        assert.equal(lockedCard._guard, await pageGuardHash('literature.html'));

        // 2. 管理态不得原地解密（防止明文被误保存回仓库）
        globalThis.window.IS_ADMIN = true;
        const adminList = [{ ...lockedCard }];
        assert.equal(await revealInPlace(adminList), 0);
        assert.ok(adminList[0]._enc);

        // 3. 访客态递归还原父子密文
        globalThis.window.IS_ADMIN = false;
        const encChild = await wrapRecord({ id: 'c_1', title: '子项' }, key);
        const visitorList = [await wrapRecord({ id: 'p_1', title: '父项', children: [encChild] }, key)];
        assert.equal(await revealInPlace(visitorList, { getChildren: (r) => r.children }), 2);
        assert.equal(visitorList[0].title, '父项');
        assert.equal(visitorList[0].children[0].title, '子项');
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, mock_window('/index.html', is_admin=False)))

    def test_05_sync_manager_relay_queue_and_state_replay(self):
        """SyncManager 草稿入队、云端/本地队列去重合并、按时间戳回放及图库批量直传"""
        fetch_mock = """
        const pushedPayloads = [];
        globalThis.fetch = async (url, opts = {}) => {
            const ok = (data) => ({ ok: true, json: async () => data });
            if (url.endsWith('/push')) {
                pushedPayloads.push(JSON.parse(opts.body));
                return ok({ success: true, key: 'k_' + pushedPayloads.length });
            }
            if (url.endsWith('/pull')) {
                return ok({ success: true, items: [
                    ...pushedPayloads.map((d, i) => ({ key: 'k_' + i, data: d })),
                    { key: 'k_remote_lock', data: {
                        module: 'notes', action: 'lock',
                        data: { id: 'n_remote_1', enc: 'enc:iv_r.ct_r' }, timestamp: Date.now() + 50
                    } }
                ] });
            }
            if (url.includes('/upload')) {
                return ok({ success: true, name: 'r2_1.jpg',
                            url: 'https://media.example.com/photos/images/travel/r2_1.jpg',
                            key: 'photos/images/travel/r2_1.jpg' });
            }
            return ok({ success: true });
        };
        """
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

        // 3. 图库批量直传
        const loaded = [];
        const file = new Blob(['IMG_BYTES'], { type: 'image/jpeg' });
        file.name = 'shot.jpg';
        const batch = await sm.uploadPhotosBatch([file], 'travel', loaded);
        assert.equal(batch.success, true);
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0]._pendingRelay, true);
        assert.ok(pushedPayloads.some(p => p.module === 'photos' && p.action === 'upload'));
        """
        self.run_node_esm(body, preamble=(
            MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html', hostname='example.com'), fetch_mock,
        ))

    def test_06_markdown_preprocess_wikilinks_and_alerts(self):
        """图片相对路径归一化、[[双链]] 转换与代码块免疫保护"""
        body = """
        const { preprocessMarkdown } = await import('./custom/cms/viewer/cms-reader.module.js');
        const md = [
            '# 标题',
            '附图1：![架构图](../../photos/images/_notes/arch.avif)',
            '附图2：![预览图](/photos/previews/_notes/prev.webp)',
            '参看 [[核心架构设计]] 与 [[底层加密协议|加密规范文档]]。',
            '```markdown',
            '![代码块内不替换](../../photos/images/_notes/ignore.png)',
            '[[代码块内双链不替换]]',
            '```'
        ].join('\\n');
        const out = preprocessMarkdown(md);
        assert.ok(out.includes('![架构图](photos/images/_notes/arch.avif)'), '未将 ../../photos/ 归一化');
        assert.ok(out.includes('![预览图](photos/previews/_notes/prev.webp)'), '未将 /photos/ 归一化');
        assert.ok(out.includes('<a href="核心架构设计.md" class="cms-wikilink">核心架构设计</a>'), '基础双链转换错误');
        assert.ok(out.includes('<a href="底层加密协议.md" class="cms-wikilink">加密规范文档</a>'), '带别名双链转换错误');
        assert.ok(out.includes('![代码块内不替换](../../photos/images/_notes/ignore.png)'), '代码块内图片路径不应被修改');
        assert.ok(out.includes('[[代码块内双链不替换]]'), '代码块内双链语法不应被修改');
        """
        self.run_node_esm(body)


    def test_07_sync_failures_and_ordered_retry(self):
        """失败入队不改本地状态；失败回放停止后续操作；确认重试不重复入库"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const sm = new SyncManager();
        sm.saveConfig({ mode: 'relay', relay: { endpoint: 'https://relay.example.com', secret: 'test' } });
        sm.Controller = { loadData: async () => {}, refreshView() {} };
        let acceptPush = false, pushes = 0, ackOk = false, rejectUpdate = true, applied = [];
        let queue = ['add', 'update', 'delete'].map((action, i) => ({ key: String(i), data: {
            module: 'notes', action, data: { id: 'n1' }, timestamp: i
        } }));
        globalThis.fetch = async (url, opts = {}) => {
            const ok = data => ({ ok: true, json: async () => data });
            if (url.endsWith('/api/crypto/admin-status')) return ok({has_encrypted:false});
            if (url.endsWith('/api/session')) return ok({ token: 'test-session' });
            if (url.endsWith('/push')) {
                pushes++; await Promise.resolve();
                return acceptPush ? ok({ id: 'p1' }) : { ok: false, status: 503, text: async () => 'offline' };
            }
            if (url.endsWith('/pull')) return ok({ items: queue });
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
        """本地模式有云端草稿时顶栏须显示“待合并”，且与待 Git 数同时可见。"""
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
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html')))

    def test_08_photo_registration_retry_and_private_routing(self):
        """登记失败不显示上传成功；重试复用文件；私有文件不会落入公开上传接口"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const sm = new SyncManager();
        sm.saveConfig({ mode: 'local', relay: { endpoint: 'https://relay.example.com', secret: 'test' } });
        let uploads = 0, acceptPush = false, privateScope = null;
        globalThis.fetch = async (url, opts = {}) => {
            if (url.endsWith('/api/crypto/admin-status')) return {ok:true,json:async()=>({has_encrypted:false})};
            if (url.endsWith('/api/session')) return { ok: true, json: async () => ({ token: 'test-session' }) };
            if (url.endsWith('/pull')) return { ok: true, json: async () => ({ items: [] }) };
            if (url.endsWith('/push')) return acceptPush
                ? { ok: true, json: async () => ({ id: 'k1' }) }
                : { ok: false, status: 503, text: async () => 'retry' };
            uploads++;
            if (url.startsWith('https://relay.example.com')) privateScope = opts.body.get('scope');
            else assert.ok(url.includes('category=travel'));
            return { ok: true, json: async () => ({ path: 'photos/images/travel/a.jpg', url: 'private/a', key: 'private/a', name: 'a.jpg' }) };
        };
        const file = new Blob(['abc']); file.name = 'a.jpg';
        const loaded = [];
        const failed = await sm.uploadPhotosBatch([file], 'travel', loaded);
        assert.equal(failed.success, false); assert.equal(loaded.length, 0);
        acceptPush = true;
        assert.equal((await sm.uploadPhotosBatch([file], 'travel', loaded)).success, true);
        assert.equal(uploads, 1); assert.equal(loaded.length, 1);
        await sm.uploadFile(file, 'secret', 'private');
        assert.equal(privateScope, 'private');
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html')))

    def test_09_file_watcher_discards_stale_results(self):
        """切换文档、输入编辑和关闭阅读器后，迟到的外部文件刷新不能覆盖内容"""
        body = """
        const { createReaderFileWatcher } = await import('./custom/cms/viewer/cms-reader-lifecycle.module.js');
        const events = new Map();
        window.addEventListener = (name, fn) => events.set(name, fn);
        window.removeEventListener = (name, fn) => { if (events.get(name) === fn) events.delete(name); };
        document.addEventListener = () => {}; document.removeEventListener = () => {};
        let node = { _mdPath: 'notes/a.md', _rawMd: 'a' }, dirty = false, changes = 0, resolve;
        globalThis.fetch = () => new Promise(done => { resolve = done; });
        const watcher = createReaderFileWatcher({ getNode: () => node, isDirty: () => dirty,
            isLocal: () => true, onChange: () => changes++ });
        watcher.start();
        const first = events.get('focus')();
        node = { _mdPath: 'notes/b.md', _rawMd: 'b' };
        watcher.start(); resolve({ ok: true, text: async () => 'old A' }); await first;
        assert.equal(node._rawMd, 'b'); assert.equal(changes, 0);
        const second = events.get('focus')(); dirty = true;
        resolve({ ok: true, text: async () => 'disk B' }); await second;
        assert.equal(node._rawMd, 'b'); assert.equal(changes, 0);
        dirty = false; const third = events.get('focus')();
        watcher.stop(); resolve({ ok: true, text: async () => 'late B' }); await third;
        assert.equal(changes, 0); assert.equal(events.size, 0);
        """
        self.run_node_esm(body, preamble=(MOCK_DOM, mock_window('/admin-cms.html')))

    def test_10_lock_pack_preserves_nested_ciphertext_and_inline_markdown(self):
        """嵌套密文与内联正文不丢失，封面索引读取失败会阻止迁移"""
        body = """
        const { setSessionKeyRaw, getSessionKey, unwrapRecord } = await import('./data-manage/encrypt/crypto.module.js');
        const { packCmsNodeForLock } = await import('./data-manage/encrypt/admin-lock.module.js');
        setSessionKeyRaw(crypto.getRandomValues(new Uint8Array(32)));
        const node = { id: 'folder', type: 'folder', children: [
            { id: 'locked', _enc: 'enc:keep-ciphertext' },
            { id: 'inline', type: 'note', content: '# Inline', title: '内联' }
        ] };
        globalThis.fetch = async () => { throw Error('offline'); };
        const packed = await packCmsNodeForLock(node);
        const result = await unwrapRecord({ _enc: packed.enc }, await getSessionKey());
        assert.equal(result.children[0]._enc, 'enc:keep-ciphertext');
        assert.equal(result.children[1].md, '# Inline');
        await assert.rejects(packCmsNodeForLock({ id: 'cover', type: 'note', content: '# test',
            coverImage: 'photos/images/_notes/secret.avif' }), /封面索引/);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html')))

    def test_11_backlink_resolution_and_scroll_anchors(self):
        """链接按路径精确定位、同名歧义不误跳、加密子树不参与索引，滚动锚点忽略代码块标题"""
        body = """
        const { resolveBacklink, accessibleNotes } = await import('./custom/cms/viewer/cms-backlinks.module.js');
        const { scanScrollAnchors, interpolateScroll } = await import('./custom/cms/viewer/cms-scroll-sync.module.js');
        const a = { id: 'a', type: 'note', title: '同名', content: 'notes/a/同名.md' };
        const b = { id: 'b', type: 'note', title: '同名', content: 'notes/b/同名.md' };
        const catalogue = [a, b].map(node => ({ module: 'notes', node }));
        const source = { module: 'notes', node: { content: 'notes/index.md' } };
        assert.equal(resolveBacklink('同名.md', source, catalogue), null);
        assert.equal(resolveBacklink('b/同名.md#heading', source, catalogue).node.id, 'b');
        assert.equal(resolveBacklink('https://external.example/a.md', source, catalogue), null);
        assert.deepEqual(accessibleNotes([{ _enc: 'secret', children: [a] }, b]).map(n => n.id), ['b']);
        const anchors = scanScrollAnchors(['# heading', '```js', '# code', '```', '## next'].join('\\n'));
        assert.deepEqual(anchors.map(a => a.kind), ['heading', 'fence', 'heading']);
        assert.equal(interpolateScroll([{ source: 0, preview: 0 }, { source: 100, preview: 200 }], 50, 'source', 'preview'), 100);
        """
        self.run_node_esm(body)

    def test_12_chart_resize_preserves_roam_and_collapse(self):
        """ECharts 图表切换视口尺寸时保留平移、缩放和折叠状态；导图渲染在浏览器中验证。"""
        body = r"""
        const { createRequire } = await import('node:module');
        const require = createRequire(new URL('file://' + process.cwd().replaceAll('\\', '/') + '/runtime.cjs'));
        const echarts = require('./plugins/vditor-assets/dist/js/echarts/echarts.min.js');
        const { resizeDiagramChart } = await import('./custom/cms/viewer/cms-diagrams.module.js');
        const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 400 });
        try {
            chart.setOption({ animation: false, series: [{ type: 'tree', roam: true,
                data: [{ name: '根节点', children: [{ name: '分支', children: [{ name: '内容' }] }] }],
                initialTreeDepth: -1 }] });
            chart.dispatchAction({ type: 'treeExpandAndCollapse', seriesIndex: 0, dataIndex: 2 });
            chart.dispatchAction({ type: 'treeRoam', seriesIndex: 0, dx: 70, dy: 35 });
            chart.dispatchAction({ type: 'treeRoam', seriesIndex: 0, zoom: 1.2, originX: 400, originY: 200 });
            const series = chart.getModel().getSeriesByIndex(0);
            const relative = () => {
                const coord = series.coordinateSystem, box = coord.getBoundingRect(), center = coord.getCenter();
                return [(center[0] - box.x) / box.width, (center[1] - box.y) / box.height, coord.getZoom()];
            };
            const before = relative();
            const expanded = series.getData().tree.root.children[0].children[0].isExpand;
            for (const [width, height] of [[520, 320], [1280, 720], [800, 400]]) resizeDiagramChart(chart, width, height);
            relative().forEach((value, i) => assert.ok(Math.abs(value - before[i]) < 1e-6));
            assert.equal(series.getData().tree.root.children[0].children[0].isExpand, expanded);
        } finally { chart.dispose(); }
        """
        self.run_node_esm(body)


    def test_13_reader_save_race_and_reused_diagram_lifetime(self):
        """保存失败保留草稿、保存中输入不丢失；预览复用的图表不提前销毁"""
        body = r"""
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        const { pathToFileURL } = await import('node:url');
        const file = 'custom/cms/viewer/cms-reader.module.js';
        const identifier = pathToFileURL(process.cwd() + '/' + file).href;
        // 仅测试编译单元开放状态注入；生产模块保持原有门面。
        const hooks = `
            export { _renderMarkdownBody as renderFixture };
            export function useFixture(node) {
                readerState.node = node; readerState.editingId = node.id; readerState.dirty = true;
            }
        `;
        const module = new vm.SourceTextModule(fs.readFileSync(file, 'utf8') + hooks, { identifier });
        await module.link(async (specifier, parent) => {
            const real = await import(new URL(specifier, parent.identifier));
            return new vm.SyntheticModule(Object.keys(real), function() {
                for (const key of Object.keys(real)) this.setExport(key, real[key]);
            });
        });
        await module.evaluate();
        const editor = module.namespace;
        let disposed = 0, reused = true;
        const diagram = { matches: () => true, querySelectorAll: () => [],
            __diagramChart: { isDisposed: () => disposed > 0, dispose: () => disposed++ } };
        const content = { isConnected: true, style: {}, offsetHeight: 0,
            querySelectorAll: () => [diagram], contains: () => reused };
        document.documentElement = { classList: { contains: () => false } };
        window.Vditor = { preview: async () => {} };
        await editor.renderFixture(content, '# one', { id: 'fixture' });
        assert.equal(disposed, 0, '相同图表签名复用时不能销毁画布');
        reused = false;
        await editor.renderFixture(content, '# two', { id: 'fixture' });
        assert.equal(disposed, 1, '移除的图表必须释放');
        const node = { id: 'fixture', title: '草稿', content: '旧正文', _rawMd: '旧正文', _originalContent: '旧正文' };
        const textarea = { value: '第一次编辑' }, title = { value: '草稿' };
        document.getElementById = id => id === 'cms-source-textarea' ? textarea : id === 'edit-title-input' ? title : null;
        document.querySelector = () => null;
        let calls = 0, finish;
        const controller = { AppState: { allNodes: [node] }, refreshView() {},
            callApi: async () => { calls++; return { success: false }; } };
        editor.initReader(controller); editor.useFixture(node);
        assert.equal((await editor.save()).success, false);
        assert.equal(node._originalContent, '旧正文');
        assert.equal(textarea.value, '第一次编辑');
        controller.callApi = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
        const pending = editor.save();
        textarea.value = '请求期间的第二次编辑'; finish({ success: true });
        await pending;
        assert.equal(node._originalContent, '第一次编辑');
        assert.equal(node._draftContent, '请求期间的第二次编辑');
        assert.equal(textarea.value, '请求期间的第二次编辑');
        controller.callApi = async () => { calls++; return { success: true }; };
        await Promise.all([editor.save(), editor.save()]);
        assert.equal(calls, 3, '并发保存相同内容不重复提交');
        assert.equal(node._originalContent, '请求期间的第二次编辑');
        assert.equal(node._draftContent, undefined);
        """
        self.run_node_esm(body, preamble=(MOCK_DOM, mock_window('/admin-cms.html', is_admin=True)),
                          node_args=('--experimental-vm-modules', '--no-warnings'))


    def test_14_initial_page_revealed_once_after_guard(self):
        """页面守卫在首个异步步骤前阻止揭示，DOM 就绪后不会先显示再隐藏；异常仍能结束等待"""
        body = r"""
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        const flash = fs.readFileSync('shared/flash-guard.js', 'utf8');
        const secret = fs.readFileSync('data-manage/encrypt/secret-unlock.module.js', 'utf8');
        for (const scenario of ['public', 'blocked', 'offline']) {
            const listeners = new Map(), elements = new Map(), classes = new Set();
            let visibilityWrites = 0, reveals = 0, finishFetch, notifyFetch;
            const fetchStarted = new Promise(resolve => { notifyFetch = resolve; });
            const style = new Proxy({ removeProperty() {} }, { set(target, key, value) {
                if (key === 'visibility') visibilityWrites++;
                target[key] = value; return true;
            } });
            const root = { style, classList: {
                add: name => classes.add(name),
                remove: name => { if (name === 'js-loading' && classes.has(name)) reveals++; classes.delete(name); },
                toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
                contains: name => classes.has(name)
            } };
            const document = { documentElement: root, readyState: 'loading',
                head: { appendChild(el) { if (el.id) elements.set(el.id, el); } },
                body: { appendChild(el) { if (el.id) elements.set(el.id, el); } },
                getElementById: id => elements.get(id), querySelector: () => null,
                createElement: () => ({ style: {}, remove() {} }),
                addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
                dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); }
            };
            const context = vm.createContext({ document, console, Event, URLSearchParams, AbortController,
                setTimeout, clearTimeout, Date, navigator: {},
                localStorage: { getItem: () => null },
                window: { location: { pathname: '/notes.html', search: '' },
                    matchMedia: () => ({ matches: false }), addEventListener() {} },
                fetch: () => new Promise((resolve, reject) => { finishFetch = scenario === 'offline' ? reject : resolve; notifyFetch(); })
            });
            vm.runInContext(flash, context);
            const module = new vm.SourceTextModule(secret, { context });
            await module.link(() => new vm.SyntheticModule(
                ['getSessionKey', 'isEncryptedRecord', 'unwrapRecord', 'sha256Hex'], function() {
                    this.setExport('getSessionKey', async () => null);
                    this.setExport('isEncryptedRecord', () => false);
                    this.setExport('unwrapRecord', async () => null);
                    this.setExport('sha256Hex', async () => 'page-hash');
                }, { context }));
            await module.evaluate();
            const guard = module.namespace.guardCurrentPage();
            assert.equal(module.namespace.guardCurrentPage(), guard, '重复初始化应共用同一次守卫检查');
            document.dispatchEvent(new Event('DOMContentLoaded'));
            assert.equal(classes.has('js-loading'), true, '守卫未完成前不能提前揭示首屏');
            assert.equal(reveals, 0);
            await fetchStarted;
            if (scenario === 'offline') finishFetch(new Error('offline'));
            else finishFetch({ ok: true, json: async () => scenario === 'blocked' ? [{ _guard: 'page-hash' }] : [] });
            await guard;
            assert.equal(classes.has('js-loading'), false);
            assert.equal(reveals, 1);
            assert.equal(visibilityWrites, 0, '不再异步隐藏整页 html');
            assert.equal(elements.has('maers-404'), scenario === 'blocked', '受保护页面仍需显示 404');
            assert.ok(!elements.get('global-theme-guard-style').textContent.includes('position: fixed'));
        }
        """
        self.run_node_esm(body, node_args=('--experimental-vm-modules', '--no-warnings'))

    def test_15_initial_theme_is_synchronous_without_transition(self):
        """旧配置首屏与运行期保持同一主题；初始化无动画，用户主动切换仍可过渡"""
        body = r"""
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        for (const configuration of [{ mode: 'manual' }, { enabled: false }, { version: 2, mode: 'manual' }]) {
            const classes = new Set(['light-mode']), frames = [];
            const storage = new Map([['theme', 'light-mode'], ['autoThemeConfig', JSON.stringify(configuration)]]);
            let transitions = 0;
            const context = vm.createContext({ console, setTimeout, clearTimeout,
                requestAnimationFrame: fn => frames.push(fn),
                localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
                document: { addEventListener() {}, querySelector: () => null, getElementById: () => null,
                    documentElement: { offsetWidth: 100, style: { removeProperty() {} }, classList: {
                        contains: name => classes.has(name), add: name => classes.add(name),
                        remove: (...names) => names.forEach(name => classes.delete(name)),
                        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
                    } },
                    startViewTransition(fn) { transitions++; fn(); return { finished: Promise.resolve(), skipTransition() {} }; }
                },
                window: { matchMedia: () => ({ matches: false, addEventListener() {} }) }
            });
            const module = new vm.SourceTextModule(fs.readFileSync('shared/theme/theme-core.module.js', 'utf8'), { context });
            await module.link(() => { throw new Error('主题核心不应有额外依赖'); });
            await module.evaluate();
            module.namespace.initThemeCore();
            assert.equal(frames.length, 0);
            assert.equal(classes.has('light-mode'), true, '已有手动浅色配置不能被重置为系统模式');
            assert.equal(transitions, 0);
            module.namespace.applyTheme('dark-mode');
            assert.equal(frames.length, 1);
            frames.shift()();
            assert.equal(classes.has('light-mode'), false);
            assert.equal(transitions, 1, '只为用户主动切换保留过渡');
        }
        """
        self.run_node_esm(body, node_args=('--experimental-vm-modules', '--no-warnings'))


    def test_16_local_session_token_and_refresh(self):
        """本地写请求共享令牌；重启后刷新；拒绝与网络故障不重复执行操作。"""
        body = """
        const { localFetch } = await import('./data-manage/api-client.module.js');
        let token = 'first', sessions = 0, writes = 0, applied = 0, mode = 'ok';
        const payload = new Blob(['image-bytes'], { type: 'image/png' });
        globalThis.fetch = async (url, options = {}) => {
            if (url.endsWith('/api/session')) {
                sessions++;
                assert.equal(options.headers['X-MAERS-Client'], 'studio');
                assert.equal(options.cache, 'no-store');
                assert.equal(options.redirect, 'error');
                await Promise.resolve();
                return Response.json({ token });
            }
            writes++;
            assert.equal(options.redirect, 'error');
            if (options.headers.get('X-MAERS-Token') !== token)
                return Response.json({ code: 'invalid_session' }, { status: 403 });
            if (mode === 'denied') return Response.json({ error: 'Untrusted Origin' }, { status: 403 });
            if (mode === 'network') throw new Error('connection lost');
            if (mode === 'expired') return Response.json({ code: 'invalid_session' }, { status: 403 });
            assert.equal(options.headers.get('X-Test'), 'keep');
            assert.equal(options.body, payload);
            applied++;
            return Response.json({ success: true });
        };
        const options = { method: 'POST', headers: new Headers({ 'X-Test': 'keep' }), body: payload };
        await Promise.all([localFetch('/upload', options), localFetch('/upload', options)]);
        assert.equal(sessions, 1); assert.equal(applied, 2);
        assert.equal(options.headers.has('X-MAERS-Token'), false, '不能修改调用者的 headers');
        token = 'second';
        await Promise.all([localFetch('/upload', options), localFetch('/upload', options)]);
        assert.equal(sessions, 2); assert.equal(applied, 4);
        mode = 'denied';
        const before = writes;
        assert.equal((await localFetch('/upload', options)).status, 403);
        assert.equal(writes, before + 1); assert.equal(sessions, 2);
        mode = 'network';
        await assert.rejects(localFetch('/upload', options), /connection lost/);
        assert.equal(writes, before + 2); assert.equal(sessions, 2);
        mode = 'expired';
        assert.equal((await localFetch('/upload', options)).status, 403);
        assert.equal(writes, before + 4, '过期只重试一次');
        """
        self.run_node_esm(body, preamble=(mock_window('/index.html'),))

    def test_24_failed_body_load_cannot_be_saved_and_title_only_omits_content(self):
        """正文 503 后禁止正文保存；只改标题不得携带占位正文。"""
        body = r"""
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        const { pathToFileURL } = await import('node:url');
        const file = 'custom/cms/viewer/cms-reader.module.js';
        const identifier = pathToFileURL(process.cwd() + '/' + file).href;
        const module = new vm.SourceTextModule(fs.readFileSync(file, 'utf8') +
            '\nexport function skipUi() { _renderUnifiedReader = () => {}; }', {identifier});
        await module.link(async (specifier, parent) => {
            const real = await import(new URL(specifier, parent.identifier));
            return new vm.SyntheticModule(Object.keys(real), function() {
                for (const key of Object.keys(real)) this.setExport(key, real[key]);
            });
        });
        await module.evaluate();
        const editor = module.namespace;
        editor.skipUi();
        const layer = {dataset:{},style:{},classList:{add(){},remove(){}},addEventListener(){},querySelectorAll:()=>[]};
        const title = {value:'renamed'};
        document.getElementById = id => id === 'immersive-reader' ? layer : id === 'edit-title-input' ? title : null;
        document.querySelector = () => null;
        document.addEventListener = () => {}; document.removeEventListener = () => {};
        window.addEventListener = () => {}; window.removeEventListener = () => {};
        const node = {id:'n',type:'note',title:'original',content:'notes/important.md'};
        const sent = [];
        editor.initReader({AppState:{allNodes:[node]},refreshView(){},callApi:async (action,body)=>{
            sent.push(body); return {success:true};
        }});
        globalThis.fetch = async () => ({ok:false,status:503});
        await editor.open(node);
        assert.equal(node.content,'notes/important.md');
        assert.equal(node._rawMd,undefined);
        assert.equal((await editor.save()).success,false);
        assert.equal(sent.length,0);
        assert.equal((await editor.save(undefined,{titleOnly:true})).success,true);
        assert.deepEqual(sent[0].data,{title:'renamed'});
        """
        self.run_node_esm(body, preamble=(MOCK_DOM, mock_window('/admin-cms.html', is_admin=True)),
                          node_args=('--experimental-vm-modules', '--no-warnings'))

    def test_25_nested_rotation_changes_data_key_and_preserves_all_plaintext(self):
        """轮换包含嵌套密文；旧 DEK 无法读取新密文，损坏记录阻断整批迁移。"""
        body = """
        const C = await import('./data-manage/encrypt/crypto.module.js');
        const {rotateSnapshots} = await import('./data-manage/encrypt/key-rotation.module.js');
        const oldKey = await C.importDataKey(C.randomBytes(32)), newKey = await C.importDataKey(C.randomBytes(32));
        const child = await C.wrapRecord({title:'private child',md:'body'},oldKey);
        const parent = await C.wrapRecord({title:'private folder',children:[child]},oldKey);
        const input = [{path:'notes-tree.json',revision:'unchanged',data:{root:[{id:'n',...parent}],public:'keep'}}];
        const output = await rotateSnapshots(input,oldKey,newKey);
        assert.equal(output[0].data.public,'keep');
        assert.equal(input[0].data.root[0]._enc,parent._enc);
        assert.equal(await C.unwrapRecord(output[0].data.root[0],oldKey),null);
        const plain = await C.unwrapRecord(output[0].data.root[0],newKey);
        assert.equal(plain.title,'private folder');
        assert.deepEqual(await C.unwrapRecord(plain.children[0],newKey),{title:'private child',md:'body'});
        await assert.rejects(rotateSnapshots([{data:{_enc:'enc:broken'}}],oldKey,newKey));
        """
        self.run_node_esm(body, preamble=(MOCK_DOM,))

    def test_26_private_titles_do_not_enter_persistent_history(self):
        """访客解密节点传播私密标记，历史只记录公开文章。"""
        body = """
        const C = await import('./data-manage/encrypt/crypto.module.js');
        const {revealInPlace} = await import('./data-manage/encrypt/secret-unlock.module.js');
        const {addToHistory} = await import('./custom/cms/viewer/cms-recent.module.js');
        C.setSessionKeyRaw(C.randomBytes(32));
        const key = await C.getSessionKey();
        const records = [await C.wrapRecord({id:'private',type:'note',title:'PRIVATE TITLE'},key)];
        await revealInPlace(records);
        assert.equal(records[0]._private,true);
        addToHistory(records[0]);
        addToHistory({id:'public',type:'note',title:'PUBLIC TITLE'});
        C.clearSessionKey();
        const history = localStorage.getItem('maers_cms_recent_files_default');
        assert.ok(history.includes('PUBLIC TITLE'));
        assert.ok(!history.includes('PRIVATE TITLE'));
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM,
                                        mock_window('/notes.html', hostname='example.com', is_admin=False)))

    def test_27_media_entry_can_switch_to_other_host_or_same_site(self):
        """切换图片入口不修改文件键；私密带令牌 URL 不会被公开入口改写。"""
        body = """
        const {publicMediaUrl} = await import('./data-manage/data-provider.module.js');
        window.MAERS = {Config:{MEDIA_PUBLIC_BASE:'https://other.example/assets'}};
        const key = 'photos/images/travel/图片 #1.png';
        assert.equal(publicMediaUrl(key),'https://other.example/assets/photos/images/travel/%E5%9B%BE%E7%89%87%20%231.png');
        const privateUrl = 'https://private.example/private/a?t=secret';
        assert.equal(publicMediaUrl(privateUrl),privateUrl);
        window.MAERS.Config.MEDIA_PUBLIC_BASE = '';
        assert.equal(publicMediaUrl(key),'photos/images/travel/%E5%9B%BE%E7%89%87%20%231.png');
        const C = await import('./data-manage/encrypt/crypto.module.js');
        C.setSessionKeyRaw(C.randomBytes(32));
        const row = {path:key,thumb:'thumb.webp',preview:'preview.avif'};
        globalThis.fetch = async () => ({ok:true,json:async()=>({travel:[row]})});
        const {DataProvider} = await import('./data-manage/data-provider.module.js');
        await DataProvider.loadCoverIndex();
        const cover = 'https://other.example/assets/' + key.split('/').map(encodeURIComponent).join('/');
        assert.equal(DataProvider.getCoverUrl({coverImage:cover},'thumb'),row.thumb);
        const {packCmsNodeForLock} = await import('./data-manage/encrypt/admin-lock.module.js');
        const packed = await packCmsNodeForLock({id:'n',type:'note',title:'test',content:'body',coverImage:cover});
        assert.deepEqual(packed.covers,[key]);
        """
        self.run_node_esm(body,preamble=(MOCK_SESSION_STORAGE,MOCK_DOM,mock_window('/admin-cms.html',is_admin=True)))

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
        """手机上传和私密读取可通过通用网关，环境无需绑定 R2。"""
        body = """
        const {File} = await import('node:buffer'); globalThis.File = File;
        const {default:worker} = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push({url,options});
            assert.equal(options.headers.Authorization,'Bearer gateway-key');
            return new Response(options.method === 'PUT' ? null : 'image',{status:200,headers:{'Content-Type':'image/png'}});
        };
        const env = {SECRET_KEY:'admin',MEDIA_GATEWAY_URL:'https://storage.example',
            MEDIA_GATEWAY_TOKEN:'gateway-key',MEDIA_PUBLIC_BASE:'https://cdn.example'};
        const form = new FormData(); form.set('file',new File(['IMAGE'],'a.png',{type:'image/png'}));
        form.set('category','travel');form.set('scope','public');
        const response = await worker.fetch(new Request('https://relay.example/api/upload',{
            method:'POST',headers:{'x-sync-key':'admin'},body:form}),env,{});
        assert.equal(response.status,200);
        const result = await response.json();
        assert.ok(result.path.startsWith('https://cdn.example/photos/images/travel/'));
        assert.ok(calls[0].url.startsWith('https://storage.example/objects/public/photos/images/travel/'));
        const token = 'private-token';
        env.PRIVATE_TOKEN_HASH = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))))
            .map(v=>v.toString(16).padStart(2,'0')).join('');
        const image = await worker.fetch(new Request('https://relay.example/private/photos/images/secret/a.png?t='+token),env,{});
        assert.equal(image.status,200);
        assert.equal(calls.at(-1).url,'https://storage.example/objects/private/photos/images/secret/a.png');
        assert.equal(image.headers.get('Cache-Control'),'no-store');
        """
        self.run_node_esm(body)

    def test_17_local_session_isolation_and_bootstrap_failure(self):
        """读取和外部云请求不携带本地令牌；会话获取失败不发起写入且可以恢复。"""
        body = """
        const { localFetch, api } = await import('./data-manage/api-client.module.js');
        let sessions = 0, fail = true, posts = 0;
        const requests = [];
        globalThis.fetch = async (url, options = {}) => {
            requests.push([url, options]);
            if (url.endsWith('/api/session')) {
                sessions++;
                if (fail) return Response.json({ error: 'offline' }, { status: 503 });
                return Response.json({ token: new URL(url).hostname });
            }
            if (options.method === 'POST') posts++;
            return Response.json({ ok: true });
        };
        await localFetch('/api/modules');
        const cloudOptions = { method: 'POST', headers: { 'x-sync-key': 'cloud-secret' }, body: '{}' };
        await localFetch('https://relay.example.com/api/push', cloudOptions);
        assert.equal(requests[1][1], cloudOptions);
        assert.equal(sessions, 0);
        await assert.rejects(localFetch('/api/save_modules', { method: 'POST', body: '[]' }));
        assert.equal(posts, 1, '会话获取失败不能继续本地写入');
        fail = false;
        await api.post('/api/save_modules', []);
        const last = requests.at(-1)[1];
        assert.equal(last.headers.get('X-MAERS-Token'), 'localhost');
        assert.equal(last.headers.get('Content-Type'), 'application/json');
        assert.equal(last.body, '[]');
        const alternate = window.location.origin.replace('localhost', '127.0.0.1');
        await localFetch(alternate + '/upload', { method: 'POST', body: new Blob(['a']) });
        assert.equal(requests.at(-1)[1].headers.get('X-MAERS-Token'), '127.0.0.1');
        assert.equal(sessions, 3, '不同本地来源分别获取令牌');
        """
        self.run_node_esm(body, preamble=(mock_window('/index.html'),))
