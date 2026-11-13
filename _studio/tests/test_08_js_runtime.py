# -*- coding: utf-8 -*-
"""前端运行回归：原生 ESM 语法、卡片保存、图库、主题及 Markdown 阅读器。"""

import json

from .helpers import frontend_js_files
from .node_runtime import (
    MOCK_DOM, MOCK_LOCAL_STORAGE, MOCK_SESSION_STORAGE, MOCK_THEME_RUNTIME,
    NodeTestCase, mock_window,
)


class Test08_FrontendJsRuntimeAndE2EECrypto(NodeTestCase):
    """验证页面初始化、数据保存与阅读交互；加密和中继由独立套件覆盖。"""

    def test_empty_literature_flow_keeps_animation_safe(self):
        """空白模板及重新生成卡片期间，不访问不存在的书籍卡片。"""
        body = """
        const frames = [];
        globalThis.requestAnimationFrame = callback => { frames.push(callback); return 1; };
        const {startLoop} = await import('./custom/literature/viewer/flow/literature-flow-render.module.js');
        const engine = {isGridMode:false, books:[], realBooks:[], slotCount:8,
            state:{scrollOffset:0,autoScrollSpeed:0.6,isPaused:false}, config:{spacing:180}};
        startLoop(engine);
        frames.shift()(performance.now());
        assert.equal(frames.length,1);
        engine.realBooks = [{id:'first-book'}];
        frames.shift()(performance.now());
        assert.equal(frames.length,1);
        engine.books = [{}];
        engine.realBooks = [];
        frames.shift()(performance.now());
        assert.equal(frames.length,1);
        """
        self.run_node_esm(body,preamble=(MOCK_DOM,MOCK_LOCAL_STORAGE,mock_window('/literature.html')))

    def test_local_entry_recovers_running_operation_before_management(self):
        """重开页面先恢复任务进度，不在写锁释放前调用管理验证。"""
        body = """
        const text={set textContent(value){messages.push(value);}};
        const messages=[],calls=[];
        let removed=0;
        document.createElement=()=>({...__mockEl(),remove:()=>{removed++;},
            querySelector:selector=>selector==='.mlock-progress-text'?text:__mockEl()});
        const timer=globalThis.setTimeout;
        globalThis.setTimeout=callback=>timer(callback,0);
        const states=[{state:'ready',active:1,operation:{message:'恢复公开图片',done:2,total:5}},
            {state:'ready',active:1,operation:{message:'恢复公开图片',done:4,total:5}},
            {state:'ready',active:0}];
        globalThis.fetch=async url=>{
            calls.push(String(url));
            if(String(url).endsWith('/api/session'))return Response.json({token:'test'});
            assert.equal(url,'/api/studio/status');
            return Response.json(states.shift());
        };
        const {waitForStudioIdle}=await import('./data-manage/operation-progress.module.js');
        await waitForStudioIdle();
        assert.equal(states.length,0);
        assert.ok(messages.includes('恢复公开图片 2/5'));
        assert.ok(messages.includes('恢复公开图片 4/5'));
        assert.equal(removed,1);
        assert.ok(!calls.some(url=>url.includes('/api/crypto/')));
        """
        self.run_node_esm(body,preamble=(MOCK_DOM,mock_window('/admin-portal.html')))

    def test_public_cdn_media_uses_downloaded_cache_when_offline(self):
        """R2 三级图片离线时按完整 CDN 地址读缓存，私密网关请求不进入此回退。"""
        body = """
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        let handler, fetched, lookup, credentials, cacheMode;
        let useSnapshots = false, exactAvailable = true;
        const cached = new Response('cached-image');
        const exact = new Response('current-version');
        const original = new Response('downloaded-original');
        const canonical = 'https://www.example.com/notes.html';
        const context = {
            URL, Response, location: {origin:'https://www.example.com'},
            self: {addEventListener:(name,callback)=>{if(name==='fetch')handler=callback;}},
            fetch: async (url,options) => {
                fetched=String(url); credentials=options.credentials; cacheMode=options.cache;
                throw Error('offline');
            },
            caches: {match: async (key, options) => {
                lookup=String(key);
                if (!useSnapshots) return cached;
                assert.equal(options.ignoreSearch, undefined);
                if (exactAvailable && key===fetched && options.cacheName!=='maers-cache-offline') return exact;
                if (key===canonical && options.cacheName==='maers-cache-offline') return original;
            }}
        };
        vm.runInNewContext(fs.readFileSync('maers-version-controller.js','utf8'),context);
        for (const size of ['images','thumbnails','previews']) {
            const url=`https://images.example.com/photos/${size}/travel/photo.webp`;
            let result;
            handler({request:new Request(url,{mode:'no-cors',credentials:'include'}),respondWith:value=>{result=value;}});
            assert.equal(await result,cached);
            assert.equal(fetched,url);
            assert.equal(lookup,url);
            assert.equal(credentials,'omit','公开图片不能继承 img 请求的 include 凭据');
        }
        let local;
        handler({request:new Request('https://www.example.com/data/photos-data.json',{credentials:'include'}),
            respondWith:value=>{local=value;}});
        await local;
        assert.equal(credentials,'include','同源请求保留原有凭据');
        useSnapshots = true;
        const readOfflineNote = () => {
            let result;
            handler({request:new Request(canonical+'?openNoteId=note',{cache:'no-cache'}),
                respondWith:value=>{result=value;}});
            return result;
        };
        assert.equal(await readOfflineNote(),exact);
        assert.equal(cacheMode,'no-cache','显式刷新要求网络重新验证');
        assert.ok(new URL(fetched).searchParams.get('maers_ver'));
        exactAvailable = false;
        assert.equal(await readOfflineNote(),original,'旧包按无查询参数的真实文件回退');
        let intercepted=false;
        handler({request:new Request('https://private.example.com/private/photos/images/travel/photo.webp?t=secret'),
            respondWith:()=>{intercepted=true;}});
        assert.equal(intercepted,false);
        handler({request:new Request('https://www.example.com/data/photos-data.json',
            {headers:{'X-MAERS-Token':'test-session'}}),respondWith:()=>{intercepted=true;}});
        assert.equal(intercepted,false,'本机管理视图不可回退到公开离线快照');
        """
        self.run_node_esm(body)

    def test_card_persistence_saves_before_deleting_and_keeps_pending_edits(self):
        """列表失败保留页面和编辑；新增落盘后才上屏，已有删除标记留待批量确认。"""
        body = """
        const {Toast}=await import('./shared/toast.module.js');
        const notices=[];Toast._show=(message,type)=>notices.push([message,type]);
        const {saveCardChanges}=await import('./data-manage/admin/card-persistence.module.js');
        const {Admin}=await import('./custom/admin-portal/admin/admin-portal.module.js');
        const {BatchItemManager}=await import('./data-manage/admin/admin-manager.module.js');
        const calls=[];let failSave=true,finish,started,snapshot;
        globalThis.prompt=()=> 'old.html';
        globalThis.fetch=async(url,options={})=>{
            if(url.endsWith('/api/session'))return Response.json({token:'test'});
            if(url.endsWith('/api/studio/status'))return Response.json({state:'ready',active:0});
            if(url.endsWith('/api/crypto/local-session'))return Response.json({configured:false,keys:{}});
            calls.push(url);
            if(url.endsWith('/api/ensure_page'))return Response.json({status:'exists'});
            if(url.endsWith('/api/save_modules'))snapshot=JSON.parse(options.body);
            if(started){started();started=null;return new Promise(resolve=>{finish=resolve;});}
            return new Response('{}',{status:url.endsWith('/api/delete_page')||failSave?500:200});
        };
        const kept={title:'keep',url:'keep.html'},deleted={title:'old',url:'old.html',_deleted:true};
        await assert.rejects(saveCardChanges('/api/save_modules',[kept,deleted],'模块'));
        assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/api/save_modules'));
        failSave=false;calls.length=0;
        assert.deepEqual(await saveCardChanges('/api/save_modules',[kept,deleted],'模块'),[kept]);
        assert.ok(calls[0].endsWith('/api/save_modules'));assert.ok(calls[1].endsWith('/api/delete_page'));
        assert.ok(notices.some(([message])=>message.includes('文件删除失败')));
        assert.ok(!notices.some(([message])=>message==='HTML文件已同步删除'));
        Admin.modules=[kept,deleted];
        Admin.manager=new BatchItemManager({list:Admin.modules,autoSaveBar:false});
        const added={title:'new',url:'new.html',icon:'x'};
        const ready=new Promise(resolve=>{started=resolve;});
        const saving=Admin._saveNewModule(added);
        await ready;
        assert.equal(calls.at(-1),'/api/save_modules');
        assert.deepEqual(Admin.modules,[kept,deleted]);
        const concurrent={title:'other',url:'other.html'};Admin.modules.push(concurrent);
        finish(new Response('{}',{status:500}));
        assert.equal(await saving,false);assert.deepEqual(Admin.modules,[kept,deleted,concurrent]);

        calls.length=0;notices.length=0;
        Admin.render=()=>{throw Error('刷新失败');};
        assert.equal(await Admin._saveNewModule(added),true);
        assert.deepEqual(calls,['/api/ensure_page','/api/save_modules']);
        assert.deepEqual(snapshot,[kept,{title:'old',url:'old.html'},concurrent,added]);
        assert.equal(Admin.modules[1]._deleted,true);
        assert.equal(Admin.modules.filter(card=>card.url===added.url).length,1);
        assert.equal(Admin.manager.initialSnapshot,JSON.stringify(snapshot));
        assert.notEqual(Admin.manager.getSnapshot(),Admin.manager.initialSnapshot);
        assert.ok(notices.some(([message])=>message==='列表已保存，请手动刷新页面'));
        assert.ok(!notices.some(([,type])=>type==='error'));
        """
        self.run_node_esm(body,preamble=(MOCK_SESSION_STORAGE,MOCK_LOCAL_STORAGE,MOCK_DOM,mock_window('/admin-portal.html')))

    def test_index_card_rendering_and_save_confirmed_snapshot(self):
        """首页按文本渲染卡片字段，保存成功后才更新卡片和批量管理基线。"""
        body = """
        document.readyState='loading'; document.addEventListener=()=>{};
        document.documentElement=__mockEl();
        let accept=false, rendered=0, bodySaved;
        globalThis.fetch=async(url,options)=>{
            if(url.endsWith('/api/session'))return Response.json({token:'test'});
            if(url.endsWith('/api/studio/status'))return Response.json({state:'ready',active:0});
            if(url.endsWith('/api/crypto/local-session'))return Response.json({configured:false,has_encrypted:false});
            assert.equal(url,'/api/save_index_cards');
            bodySaved=JSON.parse(options.body);
            return Response.json({}, {status:accept?200:500});
        };
        const {Toast}=await import('./shared/toast.module.js');Toast._show=()=>{};
        const {IndexAdmin}=await import('./custom/index/admin/index-admin.module.js');
        const {BatchItemManager}=await import('./data-manage/admin/admin-manager.module.js');
        const old={id:'old',title:'<old>',url:'#',description:'a & b',bgText:'<OLD>',icon:'ui/icon.svg'};
        IndexAdmin.items=[old];
        IndexAdmin.manager=new BatchItemManager({list:IndexAdmin.items,autoSaveBar:false});
        IndexAdmin._renderAdminButtons=()=>__mockEl();
        const card=IndexAdmin._renderNormalCard(old,0,false);
        assert.match(card.innerHTML,/alt="&lt;old&gt;"/);
        assert.match(card.innerHTML,/a &amp; b/);
        assert.match(card.innerHTML,/&lt;OLD&gt;/);
        IndexAdmin.render=()=>{rendered++;};
        const item={title:'New Card',url:'https://example.org/',icon:'📝'};
        assert.equal(await IndexAdmin._saveNewCard(item),false);
        assert.deepEqual(IndexAdmin.items,[old]);assert.equal(rendered,0);
        accept=true;
        assert.equal(await IndexAdmin._saveNewCard(item),true);
        assert.deepEqual(IndexAdmin.items,[old,{...item,id:'nav-new-card'}]);
        assert.deepEqual(bodySaved,IndexAdmin.items);
        assert.equal(IndexAdmin.manager.initialSnapshot,JSON.stringify(bodySaved));
        assert.equal(rendered,1);
        """
        self.run_node_esm(body,preamble=(MOCK_SESSION_STORAGE,MOCK_LOCAL_STORAGE,MOCK_DOM,mock_window('/admin-index.html', is_admin=True)))


    def test_modal_rejects_stale_metadata_and_duplicate_submit(self):
        """抓取只更新当前网址且不覆盖手填字段，保存中重复提交只调用一次回调。"""
        body = """
        const {Toast}=await import('./shared/toast.module.js');
        const notices=[];Toast._show=(message,type)=>notices.push([message,type]);
        const {AdminModal}=await import('./data-manage/admin/admin-modal.module.js');
        const node=value=>({value,style:{},disabled:false,classList:{add(){},remove(){}}});
        const url=node(''),name=node('New Link'),icon=node(''),description=node(''),preview=node('');
        const fetchButton=node(''),submit=node(''),cancel=node(''),closeButton=node('');
        const form={values:{tags:'a， b,c'}};
        const controls={'form':form,'.btn-primary':submit,'.btn-cancel':cancel,'.btn-close-modal':closeButton,
            '.btn-fetch-meta':fetchButton,'.icon-input':icon,'.icon-preview':preview,
            'input[name="url"]':url,'input[name="name"]':name,'textarea[name="content"]':description};
        let closed=0;const modal={isConnected:true,querySelector:selector=>controls[selector]||null,
            remove(){closed++;this.isConnected=false;}};
        document.createElement=()=>modal;document.body.appendChild=()=>{modal.isConnected=true;};
        globalThis.FormData=class {constructor(element){this.element=element;}
            [Symbol.iterator](){return Object.entries(this.element.values)[Symbol.iterator]();}};
        const observers=[];
        const nextRequest=()=>new Promise(resolve=>observers.push(resolve));
        globalThis.fetch=async(path,options={})=>{
            if(path.endsWith('/api/session'))return Response.json({token:'test'});
            if(path.endsWith('/api/studio/status'))return Response.json({state:'ready',active:0});
            if(path.endsWith('/api/crypto/local-session'))return Response.json({configured:false,keys:{}});
            return new Promise(resolve=>observers.shift()({resolve,url:JSON.parse(options.body).url}));
        };
        AdminModal.open({title:'Edit',data:{name:'New Link'},onSave:async()=>true});
        url.value='https://a.example';const readyA=nextRequest(),first=fetchButton.onclick(),a=await readyA;
        url.value='https://b.example';const readyB=nextRequest(),second=fetchButton.onclick(),b=await readyB;
        name.value='手填标题';icon.value='manual.svg';description.value='手填描述';
        b.resolve(Response.json({title:'B',icon_url:'b.svg',description:'B'}));await second;
        a.resolve(Response.json({title:'A',icon_url:'a.svg',description:'A'}));await first;
        assert.equal(name.value,'手填标题');assert.equal(icon.value,'manual.svg');assert.equal(description.value,'手填描述');
        assert.equal(notices.length,1);
        url.value='https://c.example';const readyC=nextRequest(),third=fetchButton.onclick(),c=await readyC;
        cancel.onclick();c.resolve(Response.json({title:'C',icon_url:'c.svg'}));await third;
        assert.equal(icon.value,'manual.svg');assert.equal(notices.length,1);
        let saves=0,finish,values;closed=0;
        AdminModal.open({title:'Save',fields:[{name:'tags',type:'tags'}],onSave:data=>{
            saves++;values=data;return new Promise(resolve=>{finish=resolve;});}});
        const event={preventDefault(){}};
        const saving=form.onsubmit(event);await form.onsubmit(event);
        assert.equal(saves,1);assert.deepEqual(values.tags,['a','b','c']);
        finish(false);await saving;assert.equal(closed,0);assert.equal(submit.disabled,false);
        const retry=form.onsubmit(event);finish(true);await retry;assert.equal(saves,2);assert.equal(closed,1);
        """
        self.run_node_esm(body,preamble=(MOCK_SESSION_STORAGE,MOCK_LOCAL_STORAGE,MOCK_DOM,mock_window('/admin-space.html')))


    def test_music_navigation_preserves_mapping_boundaries_and_wrap(self):
        """双向切歌保留分 P 映射、合集边界、延时切层与循环队尾规则。"""
        body = """
        document.addEventListener = () => {};
        const {initControl, playNext, playPrev} = await import('./custom/music/viewer/music-control.module.js');
        const album = (bvid, pages) => ({bvid, title:bvid, total:pages.length, page_mapping:pages});
        const a=album('A',[3,7]), b=album('B',[4,1]), c=album('C',[5]), d=album('D',[6,9]);
        a.custom_parts=['首段','末段'];
        const calls=[],tips=[],nav=[],timers=[];
        const player={playTrack:(...args)=>calls.push(args),showTip:tip=>tips.push(tip)};
        const ui={currentLevel:2,currentCatIndex:0,currentColIndex:0,
            libraryData:[{name:'甲',collections:[{name:'一',albums:[a,b]},{name:'二',albums:[c]}]},
                {name:'乙',collections:[{name:'三',albums:[d]}]}, {name:'空',collections:[]}],
            renderAlbums:(...args)=>nav.push(['render',...args]),
            enterLevel1:index=>nav.push(['category',index]),
            enterLevel2:(...args)=>nav.push(['collection',...args])};
        const elements=[{},{}];
        document.getElementById=()=>({classList:{contains:()=>true},children:elements});
        globalThis.setTimeout=(fn,delay)=>{timers.push([fn,delay]);};
        initControl(player,ui);
        const check=(source,direction,target,tip,expectedNav=[])=>{
            calls.length=tips.length=nav.length=timers.length=0;
            const [catIdx,colIdx,albIdx,trackIdx]=source;
            const current=ui.libraryData[catIdx].collections[colIdx].albums[albIdx];
            player.currentPlaying={bvid:current.bvid,total:current.total,catIdx,colIdx,albIdx,trackIdx};
            (direction>0?playNext:playPrev)();
            const [bvid,page,total,cat,col,alb,part,element=null]=target;
            assert.deepEqual(calls,[[bvid,page,total,cat,col,alb,element,part]]);
            assert.deepEqual(tips,[tip]);
            for(const [fn,delay] of timers){assert.equal(delay,300);fn();}
            assert.deepEqual(nav,expectedNav);
        };
        check([0,0,0,0],1,['A',7,2,0,0,0,1,elements[1]],'⏭ 末段');
        check([0,0,0,1],-1,['A',3,2,0,0,0,0,elements[0]],'⏮ 首段');
        check([0,0,0,1],1,['B',4,2,0,0,1,0],'下一视频: B',[['render',0,0]]);
        check([0,0,1,0],-1,['A',7,2,0,0,0,1],'上一视频: A',[['render',0,0]]);
        check([0,0,1,1],1,['C',5,1,0,1,0,0],'进入合集: 二',[['collection',0,1]]);
        check([0,1,0,0],-1,['B',1,2,0,0,1,1],'上一合集: 一',[['collection',0,0]]);
        check([0,1,0,0],1,['D',6,2,1,0,0,0],'进入分类: 乙',[['category',1],['collection',1,0]]);
        check([1,0,0,0],-1,['C',5,1,0,1,0,0],'上一分类: 甲',[['category',0],['collection',0,1]]);
        check([1,0,0,1],1,['A',3,2,0,0,0,0],'循环播放: 回到开头',[['category',0],['collection',0,0]]);
        check([0,0,0,0],-1,['D',9,2,1,0,0,1],'循环播放: 跳至队尾',[['category',1],['collection',1,0]]);
        player.currentPlaying=null;playNext();assert.equal(tips.at(-1),'未播放歌曲');
        """
        self.run_node_esm(body,preamble=(MOCK_DOM,mock_window('/music.html')))

    def test_shared_filters_keep_nested_keyword_and_tag_semantics(self):
        """筛选仍遍历不匹配的父节点，保持关键词或关系及标签与、或、排除关系。"""
        body = """
        const {Search}=await import('./shared/utils.module.js');
        const tree=[{id:'parent',name:'Parent',tags:['x'],children:[
            {id:'child',title:'Child Beta',tags:['x','y']}]},
            {id:'other',name:'Beta',tags:['y']},{id:'empty',name:'Beta',tags:[]},
            {id:'missing',name:'Beta'}];
        const ids=(tags,query,mode)=>Search.filterNodes(tree,new Set(tags),query,mode).map(n=>n.id);
        assert.deepEqual(ids(['x','y'],'','AND'),['child']);
        assert.deepEqual(ids(['x','y'],'','OR'),['parent','child','other']);
        assert.deepEqual(ids(['x'],'beta','DEL'),['other','empty']);
        assert.deepEqual(ids(['y'],'PARENT，CHILD','AND'),['child']);
        assert.deepEqual(ids([],'beta','AND'),['child','other','empty','missing']);
        assert.deepEqual(ids([],'','AND'),['parent','child','other','empty','missing']);
        """
        self.run_node_esm(body)


    def test_20_theme_binds_switch_created_after_initialization(self):
        """后台先初始化主题、后注入按钮时，点击仍须应用主题并保存状态。"""
        body = """
        const fixture=await loadThemeFixture({version:2,mode:'manual'});
        const {core,classes,values,listeners,flush}=fixture;
        core.initThemeCore();
        const checkbox={checked:true,matches:selector=>selector==='.theme-switch-checkbox'};
        fixture.checkbox=checkbox;
        const click=()=>{checkbox.checked=!checkbox.checked;listeners.get('change')?.({target:checkbox});};
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
        self.run_node_esm(body, preamble=(MOCK_THEME_RUNTIME,),
                          node_args=('--experimental-vm-modules', '--no-warnings'))


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


    def test_06_markdown_preprocess_wikilinks_and_alerts(self):
        """图片相对路径归一化、[[双链]] 转换与代码块免疫保护"""
        body = """
        const { preprocessMarkdown } = await import('./custom/cms/viewer/cms-reader.module.js');
        const md = [
            '# 标题',
            '附图1：![架构图](../../photos/images/_notes/arch.avif)',
            '附图2：![预览图](/photos/previews/_notes/prev.webp)',
            '参看 [[核心架构设计]] 与 [[底层加密协议|加密规范文档]]。',
            '```mindmap-both',
            '- 中心主题',
            '  - 左分支',
            '  - 右分支',
            '```',
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
        assert.ok(out.includes('```mindmap\\n%% direction: both\\n- 中心主题'), '双向思维导图标记未归一化');
        assert.ok(out.includes('![代码块内不替换](../../photos/images/_notes/ignore.png)'), '代码块内图片路径不应被修改');
        assert.ok(out.includes('[[代码块内双链不替换]]'), '代码块内双链语法不应被修改');
        """
        self.run_node_esm(body)


    def test_09_file_watcher_discards_stale_results(self):
        """切换文档、输入编辑和关闭阅读器后，迟到的外部文件刷新不能覆盖内容"""
        body = """
        const { createReaderFileWatcher } = await import('./custom/cms/viewer/cms-reader-lifecycle.module.js');
        const events = new Map();
        window.addEventListener = (name, fn) => events.set(name, fn);
        window.removeEventListener = (name, fn) => { if (events.get(name) === fn) events.delete(name); };
        document.addEventListener = () => {}; document.removeEventListener = () => {};
        let node = { _mdPath: 'markdown/notes/a.md', _rawMd: 'a' }, dirty = false, changes = 0, resolve;
        globalThis.fetch = () => new Promise(done => { resolve = done; });
        const watcher = createReaderFileWatcher({ getNode: () => node, isDirty: () => dirty,
            isLocal: () => true, onChange: () => changes++ });
        watcher.start();
        const first = events.get('focus')();
        node = { _mdPath: 'markdown/notes/b.md', _rawMd: 'b' };
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


    def test_11_backlink_resolution_and_scroll_anchors(self):
        """链接按路径精确定位、同名歧义不误跳、加密子树不参与索引，滚动锚点忽略代码块标题"""
        body = """
        const { resolveBacklink, accessibleNotes, findLinkedNote, backlinkUrl } = await import('./custom/cms/viewer/cms-backlinks.module.js');
        const { scanScrollAnchors, interpolateScroll } = await import('./custom/cms/viewer/cms-scroll-sync.module.js');
        const a = { id: 'a', type: 'note', title: '同名', content: 'markdown/notes/a/同名.md' };
        const b = { id: 'b', type: 'note', title: '同名', content: 'markdown/notes/b/同名.md' };
        const catalogue = [a, b].map(node => ({ module: 'notes', node }));
        const source = { module: 'notes', node: { content: 'markdown/notes/index.md' } };
        assert.equal(resolveBacklink('同名.md', source, catalogue), null);
        assert.equal(resolveBacklink('b/同名.md#heading', source, catalogue).node.id, 'b');
        assert.equal(resolveBacklink('https://external.example/a.md', source, catalogue), null);
        const query = value => new URLSearchParams(value);
        assert.equal(findLinkedNote([a, b], query('openNote=同名')), null);
        assert.equal(findLinkedNote([a, b], query('openNoteId=b&openNote=旧标题')), b);
        assert.equal(findLinkedNote([a, b], query('openNoteId=deleted&openNote=同名')), null);
        assert.equal(findLinkedNote([a], query('openNote=《同名》')), a);
        assert.equal(findLinkedNote([a], query('')), null);
        assert.equal(findLinkedNote([{ id: 'folder', type: 'folder', title: '同名' }], query('openNoteId=folder')), null);
        assert.equal(resolveBacklink(backlinkUrl(catalogue[1]), source, catalogue).node, b);
        assert.equal(resolveBacklink('?openNoteId=b', source, catalogue).node, b);
        assert.equal(resolveBacklink(backlinkUrl(catalogue[1], true), source, catalogue).node, b);
        b.title = '新标题';
        assert.equal(findLinkedNote([a, b], query('openNoteId=b&openNote=旧标题')), b);
        assert.equal(new URL(backlinkUrl(catalogue[1]), 'https://maers.invalid').searchParams.has('openNote'), false);
        assert.deepEqual(accessibleNotes([{ _enc: 'secret', children: [a] }, b]).map(n => n.id), ['b']);
        const anchors = scanScrollAnchors(['# heading', '```js', '# code', '```', '## next'].join('\\n'));
        assert.deepEqual(anchors.map(a => a.kind), ['heading', 'fence', 'heading']);
        const table = scanScrollAnchors(['## 服务', '', '| 名称 | 用途 |', '| :--- | ---: |',
            '| B2 | 图片 |', '| R2 | 正文 |', '', '下一段', '', '## 后续'].join('\\n'));
        assert.deepEqual(table.map(a => a.kind), ['heading', 'table', 'heading']);
        assert.deepEqual(table[1].rows, [2, 4, 5]);
        assert.equal(table[1].end, 6);
        const quoted = scanScrollAnchors('> | A | B |\\n> | --- | --- |\\n> | 1 | 2 |');
        assert.deepEqual(quoted[0].rows, [0, 2]);
        assert.deepEqual(scanScrollAnchors('```md\\n| A | B |\\n| --- | --- |\\n```').map(a => a.kind), ['fence']);
        assert.equal(interpolateScroll([{ source: 0, preview: 0 }, { source: 100, preview: 200 }], 50, 'source', 'preview'), 100);
        """
        self.run_node_esm(body)

    def test_cms_shared_startup_waits_for_data_and_keeps_failed_saves(self):
        """公共启动等待数据与专属视图；访客不接入后台，失败保存不隐藏保存条。"""
        body = """
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        const { findLinkedNote } = await import('./custom/cms/viewer/cms-backlinks.module.js');
        for (const admin of [false, true]) {
            let start, release, save, cancel, visible = false, saved = false, tagsSaved = false, tagManager = null;
            const calls = [], notices = [];
            const note = { id: 'stable', type: 'note', title: '新标题' };
            const manager = { initialSnapshot: 'clean', getSnapshot: () => 'dirty' };
            const State = { IS_ADMIN: admin };
            const Controller = { CONFIG: { IS_ADMIN: admin }, AppState: { allNodes: [note] } };
            const View = { refreshView() {} };
            const Tags = { getManager: () => tagManager,
                toggleTagDrawer() { tagManager = manager; },
                tagPerformSave: async () => tagsSaved, tagPerformCancel: async () => calls.push('cancel-tags') };
            const Admin = { getManager: () => manager, performSave: async () => saved,
                performCancel: async () => calls.push('cancel-nodes') };
            const deps = { Controller, State, View, Tags, Admin, Drag: {}, Lightbox: {}, Search: {},
                Events: {}, Render: {}, Recent: {}, findLinkedNote,
                Reader: { open: async node => { assert.equal(node, note); calls.push('open'); } },
                bootstrap: async () => { await new Promise(resolve => { release = resolve; }); calls.push('data'); return true; },
                SaveButton: { init: (host, onSave, onCancel) => { save = onSave; cancel = onCancel; },
                    show() { visible = true; }, hide() { visible = false; } },
                Feedback: { notifySaveSuccess: () => notices.push('saved'), notifyCancel() {} },
                Toast: { error: message => { throw Error(message); } } };
            for (const name of ['initLayout', 'initTheme', 'initDrag', 'initState', 'initSearch',
                'initEvents', 'initTags', 'initRender', 'initReader', 'setupViewEventListeners', 'initRecent']) {
                deps[name] = () => {};
            }
            deps.initView = modules => assert.equal(modules.Admin, admin ? Admin : null);
            const context = vm.createContext({ console, URLSearchParams,
                window: { location: { search: '?openNoteId=stable&openNote=旧标题' } },
                document: { readyState: 'loading', body: {}, addEventListener: (name, callback) => { start = callback; } } });
            const fixture = new vm.SyntheticModule(Object.keys(deps), function () {
                for (const [name, value] of Object.entries(deps)) this.setExport(name, value);
            }, { context });
            const module = new vm.SourceTextModule(fs.readFileSync('custom/cms/viewer/cms-page.module.js', 'utf8'), { context });
            await module.link(() => fixture); await module.evaluate();
            module.namespace.initCmsPage({ onReady: async () => { await Promise.resolve(); calls.push('view'); } });
            const pending = start();
            assert.deepEqual(calls, []);
            release(); await pending;
            assert.deepEqual(calls, ['data', 'view', 'open']);
            assert.equal(Boolean(save), admin);
            if (!admin) continue;
            manager.onChange(); assert.equal(visible, true);
            assert.equal(await save(), false); assert.equal(visible, true); assert.deepEqual(notices, []);
            saved = true;
            assert.equal(await save(), false); assert.equal(visible, true); assert.deepEqual(notices, []);
            tagsSaved = true;
            await save(); assert.equal(visible, false); assert.deepEqual(notices, ['saved']);
            Tags.toggleTagDrawer(); tagManager.onChange(); assert.equal(visible, true);
            await cancel(); assert.equal(visible, false);
            assert.deepEqual(calls.slice(-2), ['cancel-nodes', 'cancel-tags']);
        }
        """
        self.run_node_esm(body, node_args=('--experimental-vm-modules',))

    def test_cms_module_metadata_is_shared_without_global_mount(self):
        """模块名称、图标和数据文件来自同一配置，新增页面仍按自身名称读取。"""
        body = """
        globalThis.window = {};
        const { ModuleConfig } = await import('./shared/module-config.module.js');
        const fs = await import('node:fs');
        for (const name of ['notes', 'record', 'literature', 'games', 'videos', 'music', 'album']) {
            const config = ModuleConfig.get(name), title = ModuleConfig.getTitle(name);
            assert.ok(fs.existsSync(config.icon)); assert.ok(fs.existsSync(config.dataFile));
            assert.ok(title.includes(config.icon)); assert.ok(title.includes(config.title));
        }
        assert.equal(ModuleConfig.get('custom').dataFile, 'data/custom-tree.json');
        assert.ok(ModuleConfig.getTitle('videos').includes('music-mode-btn'));
        assert.ok(!ModuleConfig.getTitle('videos', true).includes('music-mode-btn'));
        assert.equal(ModuleConfig.get('constructor').dataFile, 'data/constructor-tree.json');
        assert.ok(ModuleConfig.getTitle('<script>').includes('&lt;SCRIPT&gt;'));
        assert.equal(window.MAERS, undefined);
        """
        self.run_node_esm(body)

    def test_12_chart_resize_preserves_roam_and_collapse(self):
        """ECharts 原生缩放后切换尺寸，保持实际绘制位置、缩放和折叠状态。"""
        body = r"""
        const { createRequire } = await import('node:module');
        const require = createRequire(new URL('file://' + process.cwd().replaceAll('\\', '/') + '/runtime.cjs'));
        const echarts = require('./plugins/vditor-assets/dist/js/echarts/echarts.min.js');
        const { resizeDiagramChart } = await import('./custom/cms/viewer/cms-diagrams.module.js');
        const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 400 });
        try {
            chart.setOption({ animation: false, series: [{ type: 'tree', roam: true,
                left: '16%', right: '8%', top: '12%', bottom: '16%',
                data: [{ name: '根节点', children: [{ name: '分支', children: [{ name: '内容' }] }] }],
                initialTreeDepth: -1 }] });
            chart.dispatchAction({ type: 'treeExpandAndCollapse', seriesIndex: 0, dataIndex: 2 });
            const series = chart.getModel().getSeriesByIndex(0);
            // Exercise the native gesture handler: it updates the drawing group
            // as well as the model. Do not force a resize before taking a snapshot.
            const roam = (event, payload) => chart.getViewOfSeriesModel(series)._controller.trigger(event, payload);
            const rootPosition = () => {
                const data = series.getData(), root = data.tree.root.children[0];
                const matrix = data.getItemGraphicEl(root.dataIndex).getComputedTransform();
                return [matrix[4], matrix[5]];
            };
            const viewport = () => {
                const point = rootPosition();
                return [point[0] - chart.getWidth() / 2, point[1] - chart.getHeight() / 2,
                    series.coordinateSystem.getZoom()];
            };
            roam('zoom', { scale: 1.2, originX: 400, originY: 200 });
            const point = rootPosition();
            roam('pan', { dx: chart.getWidth() / 2 - point[0], dy: chart.getHeight() / 2 - point[1] });
            const expanded = series.getData().tree.root.children[0].children[0].isExpand;
            for (const [width, height] of [[520, 320], [2400, 625], [800, 400], [2400, 625], [800, 400]]) {
                const before = viewport();
                resizeDiagramChart(chart, width, height);
                viewport().forEach((value, i) => assert.ok(Math.abs(value - before[i]) < 1e-6,
                    `切换到 ${width}×${height} 须保持实际视口`));
                assert.equal(series.getData().tree.root.children[0].children[0].isExpand, expanded);
                if (width === 2400) {
                    roam('zoom', { scale: 0.3, originX: width * 0.6, originY: height * 0.3 });
                    roam('pan', { dx: 70, dy: 35 });
                }
            }
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
            export function useFixture(node, source) {
                readerState.node = node; readerState.editingId = node.id; readerState.dirty = true;
                readerState.sourceEditor = source;
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
        editor.initReader(controller); editor.useFixture(node, textarea);
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
        controller.callApi = async () => {
            calls++;
            controller.AppState.allNodes = [{ ...node, _draftContent: undefined }];
            return { success: true };
        };
        await Promise.all([editor.save(), editor.save()]);
        assert.equal(calls, 3, '并发保存相同内容不重复提交');
        assert.equal(node._originalContent, '请求期间的第二次编辑');
        assert.equal(node._draftContent, undefined);
        """
        self.run_node_esm(body, preamble=(MOCK_DOM, mock_window('/admin-cms.html', is_admin=True)),
                          node_args=('--experimental-vm-modules', '--no-warnings'))


    def test_reader_preview_reuses_instances_by_source_and_theme(self):
        """重复图表各自复用实例；改动源码、主题或已销毁的实例不复用。"""
        body = r"""
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        const update = vm.runInNewContext(fs.readFileSync(
            '_studio/tooling/vendor/vditor/patches/method-preview-content.js', 'utf8'));
        let light = false, items = [], next = [];
        const attributes = new Map();
        const container = {
            ownerDocument: { documentElement: { classList: { contains: () => light } } },
            getAttribute: key => attributes.get(key) ?? null,
            setAttribute: (key, value) => attributes.set(key, value),
            querySelectorAll(selector) {
                if (selector.startsWith('[data-processed')) return items.filter(item => item.processed);
                const classes = selector.split(',').map(value => value.trim().slice(1));
                return items.filter(item => classes.includes(`language-${item.type}`));
            },
            set innerHTML(value) { items = [...next]; }
        };
        const diagram = (type, source, processed = false) => ({
            type, source, processed, state: { zoom: 2, collapsed: true },
            classList: { contains: name => name === `language-${type}` },
            textContent: source,
            getAttribute: key => key === 'data-diagram-sig' ? `${type}:${source}` : null,
            closest: () => ({ classList: { add() {} } }),
            replaceWith(other) { items[items.indexOf(this)] = other; }
        });
        const first = diagram('echarts', 'same', true), second = diagram('echarts', 'same', true);
        const mermaid = diagram('mermaid', 'graph TD; A-->B', true);
        const flowchart = diagram('flowchart', 'st=>start: 开始', true);
        const graphviz = diagram('graphviz', 'digraph {a -> b}', true);
        const disposed = diagram('echarts', 'disposed', true);
        disposed.__diagramChart = { isDisposed: () => true };
        items = [first, second, mermaid, disposed, flowchart, graphviz];
        next = [diagram('echarts', 'same'), diagram('echarts', 'same'),
            diagram('mermaid', mermaid.source), diagram('echarts', 'changed'), diagram('echarts', 'disposed'),
            diagram('flowchart', flowchart.source), diagram('graphviz', graphviz.source)];
        update(container, 'next');
        assert.equal(items[0], first); assert.equal(items[1], second);
        assert.equal(items[2], mermaid); assert.equal(items[3], next[3]); assert.equal(items[4], next[4]);
        assert.equal(items[5], flowchart); assert.equal(items[6], graphviz);
        assert.equal(items[0].state.zoom, 2);
        light = true;
        next = [diagram('echarts', 'same'), diagram('mermaid', mermaid.source)];
        update(container, 'light');
        assert.equal(items[0], next[0]); assert.equal(items[1], next[1]);
        """
        self.run_node_esm(body)

    def test_graphviz_preview_releases_workers_and_ignores_detached_results(self):
        """Graphviz 成功、失败及关闭正文均释放线程和地址，旧结果不能回写。"""
        body = r"""
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        let starts = 0, stops = 0, revokes = 0, writes = 0, elements = [];
        const pending = [];
        const factory = vm.runInNewContext(fs.readFileSync(
            '_studio/tooling/vendor/vditor/patches/method-572.js', 'utf8'), {
            console, Blob: class {},
            Worker: class { constructor() { starts++; } terminate() { stops++; } },
            Viz: class { renderSVGElement() { return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
            document: { getElementById: () => ({ src: '/dist/viz.js' }) },
            window: { URL: { createObjectURL: () => 'blob:graphviz', revokeObjectURL() { revokes++; } } }
        });
        const dependencies = id => ({
            793: { g: { CDN: '' } }, 998: { G: async () => {} },
            781: { graphvizRenderAdapter: { getElements: () => elements, getCode: () => 'digraph {a -> b}' } }
        })[id];
        dependencies.d = (target, getters) => {
            for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
        };
        const exports = {}; factory(null, exports, dependencies);
        const element = () => {
            const attributes = new Map();
            return { isConnected: true, parentElement: { classList: { contains: () => false } },
                setAttribute: (key, value) => attributes.set(key, value),
                getAttribute: key => attributes.get(key) ?? null,
                set innerHTML(value) { writes++; } };
        };
        const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
        const complete = element(); elements = [complete]; exports.v({}); await drain();
        assert.equal(complete.getAttribute('data-processed'), 'pending');
        exports.v({}); await drain(); assert.equal(starts, 1, '渲染期间不重复启动工作线程');
        pending.shift().resolve({ outerHTML: '<svg/>' }); await drain();
        assert.equal(complete.getAttribute('data-processed'), 'true');
        assert.equal(complete.getAttribute('data-diagram-sig'), 'graphviz:digraph {a -> b}');
        assert.equal(stops, 1); assert.equal(revokes, 1); assert.equal(writes, 1);
        const removed = element(); elements = [removed]; exports.v({}); await drain();
        removed.isConnected = false; removed.__disposeDiagramDOM();
        pending.shift().resolve({ outerHTML: '<svg/>' }); await drain();
        assert.equal(stops, 2); assert.equal(revokes, 2); assert.equal(writes, 1);
        elements = [element()]; exports.v({}); await drain();
        pending.shift().reject(Error('parse failure')); await drain();
        assert.equal(stops, 3); assert.equal(revokes, 3);
        """
        self.run_node_esm(body)

    def test_reader_layout_batches_work_and_reuses_measurement_nodes(self):
        """连续尺寸通知合并执行，长源码按锚点分段且重排不重建，销毁后取消待办。"""
        body = r"""
        const timers = new Map(), frames = new Map();
        let sequence = 0, created = 0, replacements = 0, resizeCallback;
        globalThis.setTimeout = callback => { const id = ++sequence; timers.set(id, callback); return id; };
        globalThis.clearTimeout = id => timers.delete(id);
        globalThis.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
        globalThis.cancelAnimationFrame = id => frames.delete(id);
        const flush = () => {
            for (const queue of [timers, frames]) for (const [id, callback] of [...queue]) {
                if (queue.delete(id)) callback();
            }
        };
        class Element {
            constructor() {
                this.style = {}; this.children = []; this.listeners = new Map();
                this.scrollTop = 0; this.scrollHeight = 50000; this.clientHeight = 400; this.clientWidth = 500;
                this.classList = { contains: () => false, add() {} };
            }
            setAttribute() {}
            appendChild(node) { this.children.push(node); return node; }
            replaceChildren(fragment) { this.children = fragment.children; replacements++; }
            remove() {}
            addEventListener(name, callback) { this.listeners.set(name, callback); }
            removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
            getBoundingClientRect() { return { top: 0, height: 1 }; }
            closest() { return null; }
            setSelectionRange() {}
            focus() {}
        }
        globalThis.document = {
            body: new Element(),
            createElement() { created++; return new Element(); },
            createDocumentFragment: () => new Element()
        };
        globalThis.window = new Element();
        globalThis.getComputedStyle = () => ({ fontFamily: 'monospace', fontSize: '14px', lineHeight: '20px' });
        globalThis.ResizeObserver = class {
            constructor(callback) { resizeCallback = callback; }
            observe() {} disconnect() {}
        };
        const { createReaderScrollSync } = await import('./custom/cms/viewer/cms-scroll-sync.module.js');
        const preview = new Element(), content = new Element(), source = new Element(), drawer = new Element();
        source.ownerDocument = document;
        source.scrollElement = source; source.host = source;
        source.lineTop = line => line * 20;
        source.value = '# 开始\n' + '正文\n'.repeat(1798) + '## 结尾';
        content.querySelectorAll = selector => selector.startsWith('h1') ? [new Element(), new Element()] : [];
        const sync = createReaderScrollSync({ preview, content, source, drawer });
        sync.drawerChanged(0, true);
        for (let i = 0; i < 20; i++) { source.clientWidth++; resizeCallback(); }
        assert.equal(created, 0, '抽屉过渡期间不创建源码测量节点');
        drawer.listeners.get('transitionend')({ target: drawer, propertyName: 'width' });
        assert.equal(created, 0, '直接读取编辑器行位置，不创建全文镜像节点');
        assert.equal(replacements, 0);
        const allocation = created;
        for (let i = 0; i < 20; i++) { source.clientWidth++; resizeCallback(); }
        assert.equal(timers.size, 1, '连续通知只保留一次待测量任务');
        flush();
        assert.equal(created, allocation, '宽度变化复用已存在的测量节点');
        assert.equal(replacements, 0);
        sync.drawerChanged(0, false); sync.destroy();
        assert.equal(timers.size, 0); assert.equal(frames.size, 0);
        assert.equal(drawer.listeners.size, 0); assert.equal(source.listeners.size, 0);

        // 大表格后同一个标题应对齐；折行改变行高后，双向定位仍使用新坐标。
        source.value = ['## 4', '', '| A | B |', '| --- | --- |', ...Array(5).fill('| 数据 | 内容 |'),
            '', '表格后的说明', '', '## 5', '', ...Array(100).fill('后续正文')].join('\n');
        let lineHeight = 20;
        source.lineTop = line => line * lineHeight;
        source.getBoundingClientRect = () => ({top: 100, height: 400});
        const at = (top, height = 40) => Object.assign(new Element(), {
            getBoundingClientRect: () => ({top: top - preview.scrollTop, height})
        });
        const rows = [100, 300, 500, 750, 950, 1140].map(top => at(top));
        const tableElement = at(100, 1100), headings = [at(40), at(1260)];
        tableElement.querySelectorAll = () => rows;
        content.querySelectorAll = selector => selector.startsWith('h1') ? headings : selector === 'table' ? [tableElement] : [];
        const aligned = createReaderScrollSync({preview, content, source, drawer});
        source.scrollTop = source.lineTop(9);
        source.listeners.get('scroll')({currentTarget: source}); flush();
        assert.equal(headings[1].getBoundingClientRect().top, 100 + source.lineTop(12) - source.scrollTop,
            '表格之后的标题不能在两边相差一整个表格');
        lineHeight = 40;
        source.scrollTop = source.lineTop(5);
        source.listeners.get('sourcelayout')(); flush();
        assert.equal(rows[2].getBoundingClientRect().top, 100, '编辑器折行后必须丢弃旧行高缓存');
        preview.scrollTop = 850;
        preview.listeners.get('scroll')({currentTarget: preview}); flush();
        assert.equal(source.scrollTop, source.lineTop(7), '正文滚动也应按表格行反向定位');
        aligned.destroy();
        assert.equal(source.listeners.size, 0);

        const { mountDiagramFullscreenButton } = await import('./custom/cms/viewer/cms-diagrams.module.js');
        const card = new Element();
        let resizes = 0, width = 500;
        card.isConnected = true; card.tagName = 'DIV'; card.style = {};
        card.querySelector = () => null;
        card.getAttribute = () => 'true';
        card.__diagramChart = { isDisposed: () => false, getWidth: () => width, getHeight: () => 400,
            getModel: () => ({ eachSeries() {} }), resize(options) { width = options.width; resizes++; } };
        document.createElement = () => ({ ...new Element(), querySelector: () => ({ src: '' }),
            addEventListener() {}, setAttribute() {} });
        getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' });
        mountDiagramFullscreenButton(card);
        for (let i = 0; i < 20; i++) { card.clientWidth++; resizeCallback(); }
        assert.equal(resizes, 0, '连续尺寸变化期间不逐帧重绘');
        assert.equal(timers.size, 1);
        flush(); assert.equal(resizes, 1);
        resizeCallback(); card.__disposeDiagramDOM(); flush();
        assert.equal(resizes, 1, '销毁后不能执行迟到的重排');
        """
        self.run_node_esm(body)

    def test_14_initial_page_revealed_once_after_guard(self):
        """公开、受保护和离线场景分别初始化守卫，各自只揭示首屏一次。"""
        body = r"""
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        const flash = fs.readFileSync('shared/flash-guard.js', 'utf8');
        const secret = fs.readFileSync('data-manage/encrypt/secret-unlock.module.js', 'utf8');
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
        const context = vm.createContext({ document, console, Event, URL, URLSearchParams, AbortController,
            setTimeout, clearTimeout, Date, navigator: {},
            localStorage: { getItem: () => null },
            window: { location: { href: 'https://example.com/notes.html', pathname: '/notes.html', search: '', hash: '' },
                history: { state: null, replaceState() {} },
                matchMedia: () => ({ matches: false }), addEventListener() {} },
            fetch: () => new Promise((resolve, reject) => { finishFetch = scenario === 'offline' ? reject : resolve; notifyFetch(); })
        });
        vm.runInContext(flash, context);
        const module = new vm.SourceTextModule(secret, { context });
        await module.link(() => new vm.SyntheticModule(
            ['getSessionKey', 'getSessionKeysRaw', 'isEncryptedRecord', 'unwrapRecord', 'sha256Hex'], function() {
                this.setExport('getSessionKey', async () => null);
                this.setExport('getSessionKeysRaw', () => ({}));
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
        """
        for scenario in ('public', 'blocked', 'offline'):
            with self.subTest(scenario=scenario):
                self.run_node_esm(body, preamble=('const scenario = ' + json.dumps(scenario) + ';',),
                                  node_args=('--experimental-vm-modules', '--no-warnings'))

    def test_15_initial_theme_is_synchronous_without_transition(self):
        """旧配置首屏与运行期保持同一主题；初始化无动画，用户主动切换仍可过渡。"""
        body = """
        const fixture=await loadThemeFixture(configuration,'light-mode');
        const {core,classes,frames}=fixture;
        core.initThemeCore();
        assert.equal(frames.length,0);
        assert.equal(classes.has('light-mode'),true,'已有手动浅色配置不能被重置为系统模式');
        assert.equal(fixture.metas.get('theme-color')?.content,'#ffffff','浅色模式下地址栏应同步为浅色');
        assert.equal(fixture.metas.get('color-scheme')?.content,'light');
        assert.equal(fixture.transitions,0);
        core.applyTheme('dark-mode');
        assert.equal(frames.length,1);
        frames.shift()();
        assert.equal(classes.has('light-mode'),false);
        assert.equal(fixture.metas.get('theme-color')?.content,'#0a0a0c','深色模式下地址栏应同步为深色');
        assert.equal(fixture.metas.get('color-scheme')?.content,'dark');
        assert.equal(fixture.transitions,1,'只为用户主动切换保留过渡');
        """
        for configuration in ({'mode': 'manual'}, {'enabled': False}, {'version': 2, 'mode': 'manual'}):
            with self.subTest(configuration=configuration):
                self.run_node_esm(body, preamble=(MOCK_THEME_RUNTIME,
                    'const configuration = ' + json.dumps(configuration) + ';'),
                    node_args=('--experimental-vm-modules', '--no-warnings'))


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
        """正文读取失败不能覆盖原文；手机保存草稿后重新打开仍显示草稿。"""
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
        const listeners = new Map();
        const layer = {dataset:{},style:{},classList:{add(){},remove(){}},
            addEventListener:(name,handler)=>listeners.set(name,handler),querySelectorAll:()=>[]};
        const title = {value:'renamed'};
        document.getElementById = id => id === 'immersive-reader' ? layer : id === 'edit-title-input' ? title : null;
        document.querySelector = () => null;
        document.addEventListener = () => {}; document.removeEventListener = () => {};
        window.addEventListener = () => {}; window.removeEventListener = () => {};
        const node = {id:'n',type:'note',title:'original',content:'markdown/notes/important.md'};
        const sent = [];
        const controller = {AppState:{allNodes:[node]},refreshView(){},callApi:async (action,body)=>{
            sent.push(body); return {success:true};
        }};
        editor.initReader(controller);
        globalThis.fetch = async () => ({ok:false,status:503});
        await editor.open(node);
        assert.equal(node.content,'markdown/notes/important.md');
        assert.equal(node._rawMd,undefined);
        assert.equal((await editor.save()).success,false);
        assert.equal(sent.length,0);
        assert.equal((await editor.save(undefined,{titleOnly:true})).success,true);
        assert.deepEqual(sent[0].data,{title:'renamed'});

        // 手机草稿保存后关掉阅读器再打开，不能重新读取尚未发布的旧正文。
        window.location.hostname = 'phone.example.com';
        window.MAERS = { Config: { CONTENT_PUBLIC_BASE: 'https://content.example.com' } };
        const { applyCmsNodeAction } = await import('./data-manage/sync/relay-actions.module.js');
        const { sha256Hex } = await import('./data-manage/encrypt/crypto.module.js');
        let reads = 0;
        globalThis.fetch = async () => { reads++; return new Response('已发布的旧正文'); };
        controller.callApi = async (action,body) => {
            applyCmsNodeAction('notes', [node], action, body);
            return {success:true};
        };
        await editor.open(node);
        assert.equal(node._rawMd, '已发布的旧正文');
        for (const text of ['手机修改后的正文', '']) {
            assert.equal((await editor.save(text)).success, true);
            editor.close();
            delete node._sourceRevision;
            await editor.open(node);
            assert.equal(node._rawMd, text, '重新打开必须读取刚保存的草稿，包括清空正文');
            assert.equal(node._draftContent, text);
            assert.equal(node._sourceRevision, await sha256Hex(text), '草稿回读必须同时恢复版本标记');
            assert.equal(reads, 1, '草稿仍在时不读取正式桶的旧正文');
        }
        editor.close();

        const target = {id:'target',type:'note',title:'改名后的文章',content:'markdown/notes/root-renamed.md',_draftContent:'目标正文'};
        controller.CONFIG = {CURRENT_MODULE:'notes'};
        controller.AppState.allNodes.push(target);
        const click = async (href,{target='',ctrlKey=false,download=false}={}) => {
            let prevented=false;
            const link={getAttribute:key=>key==='href'?href:key==='target'?target:null,
                hasAttribute:key=>key==='download'&&download};
            await listeners.get('click')({target:{closest:()=>link},button:0,ctrlKey,
                preventDefault(){prevented=true;},stopImmediatePropagation(){}});
            return prevented;
        };
        for (const admin of [true,false]) {
            window.IS_ADMIN=admin;
            for (const href of ['/notes.html?openNoteId=target&openNote=旧标题','/notes?openNoteId=target',
                '/admin-cms.html?module=notes&openNoteId=target','?openNoteId=target','root-renamed.md']) {
                delete target._rawMd;
                assert.equal(await click(href),true);
                assert.equal(target._rawMd,'目标正文','同模块 ID 链接直接切换阅读器');
            }
        }
        for (const href of ['/games.html?openNoteId=target','https://external.example/notes.html?openNoteId=target']) {
            assert.equal(await click(href),false,'跨模块和外站保持正常页面导航');
        }
        for (const options of [{target:'_blank'},{ctrlKey:true},{download:true}]) {
            assert.equal(await click('/notes.html?openNoteId=target',options),false);
        }
        assert.equal(reads,1,'同模块切换不重新请求模块页或已发布正文');
        editor.close();
        """
        self.run_node_esm(body, preamble=(MOCK_DOM, mock_window('/admin-cms.html', is_admin=True)),
                          node_args=('--experimental-vm-modules', '--no-warnings'))


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
