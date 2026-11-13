"""图片运行回归：封面索引、原位渲染、图库筛选与灯箱异步加载。"""

from .node_runtime import MOCK_TREE_DOM, MOCK_LOCAL_STORAGE, NodeTestCase, mock_window


# 只模拟浏览器边界；渲染、筛选和灯箱仍执行真实模块。
_PHOTO_VIEW = r"""
const gallery=new Element(),lightbox=new Element(),image=new Element('img');
const previous=new Element(),next=new Element(),close=new Element(),hd=new Element(),hdLabel=new Element();
previous.className='lb-prev';next.className='lb-next';close.className='close-lightbox';
hdLabel.className='hd-text';hd.appendChild(hdLabel);
lightbox.appendChild(previous);lightbox.appendChild(next);lightbox.appendChild(close);
const sortMenu=new Element(),sortLabel=new Element(),sortButton=new Element();
const sortItems=[0,1,2].map(mode=>{const item=new Element();item.className='sort-item';
    item.dataset.mode=String(mode);sortMenu.appendChild(item);return item;});
const elements={'gallery-container':gallery,'lightbox':lightbox,'lightbox-img':image,'hd-switch':hd,
    'sort-menu':sortMenu,'sort-trigger-btn':sortButton,'sort-label':sortLabel};
document.getElementById=id=>elements[id]||null;
document.querySelectorAll=selector=>selector==='.sort-item'?sortItems:[];
const photos=[{path:'photos/images/x/a"b.png',preview:'a.avif',thumb:'a.webp',name:'A',tags:['one']},
    {path:'photos/images/x/b.png',preview:'b.avif',thumb:'b.webp',name:'B',tags:[]}];
const controller={State:{category:'x',loadedData:photos,isAdmin:true},loads:0,
    fixPath:value=>value||null,async reloadData(){this.loads++;}};
const manager={selectedIndices:[0],getItemClass:index=>index===0?'is-selected':''};
const actions=[];
const admin={getManager:()=>manager,isReordering:()=>false};
const core={AppState:{activeFilters:new Set(),searchQuery:''},Tags:{filterByTag(){}},
    AdminButtonHelper:{render:options=>{actions.push(options);const el=new Element();
        el.className='photo-admin-actions';return el;}}};
const loaders=[];
globalThis.Image=class {constructor(){loaders.push(this);}};
let configuration=[];
globalThis.fetch=async()=>Response.json(configuration);
const view=await import('./custom/photos/viewer/photos-view.module.js');
view.initView(controller,admin,core);
const initialize=async()=>{for(const listener of __domListeners.get('DOMContentLoaded')||[])await listener();};
const click={stopPropagation(){}};
"""


class Test08_PhotosRuntime(NodeTestCase):
    """在独立 Node 进程核对图片路径、节点身份和迟到的加载回调。"""

    def run_view(self, body):
        self.run_node_esm(body, preamble=(MOCK_TREE_DOM, mock_window('/admin-photos.html'), _PHOTO_VIEW))

    def test_album_delete_choices_cancel_before_any_write_and_use_real_identity(self):
        """批量删除任一选择取消时零写入，明确选择时使用原记录 ID，无须用户输入。"""
        body = """
        document.readyState='loading';document.documentElement=new Element();
        const grid=new Element();document.getElementById=id=>id==='category-grid'?grid:null;
        const {SaveButton,Feedback,AdminButtonHelper}=await import('./data-manage/admin/admin-base.module.js');
        const {AdminModal}=await import('./data-manage/admin/admin-modal.module.js');
        let save;SaveButton.init=(_body,callback)=>{save=callback;};SaveButton.show=()=>{};SaveButton.hide=()=>{};
        for(const name of Object.keys(Feedback))if(typeof Feedback[name]==='function')Feedback[name]=()=>{};
        AdminButtonHelper.render=()=>new Element();
        globalThis.prompt=()=>assert.fail('不能再要求输入内部 ID');
        const original=[{id:'album_a1b2c3d4',title:'其它'},{id:'album_d4c3b2a1',title:'待定'},{id:'nature',title:'自然'}];
        let posts=[];
        globalThis.fetch=async(url,options={})=>{
            if(String(url).endsWith('/api/session'))return Response.json({token:'test'});
            if(options.method!=='POST')return Response.json(original);
            posts.push({url,body:JSON.parse(options.body)});return Response.json({status:'success'});
        };
        const {AlbumAdmin}=await import('./custom/album/admin/album-admin.module.js');
        for(const answers of [[null],['entry',null],['entry','physical']]) {
            posts=[];let asked=0;await AlbumAdmin.init();
            AlbumAdmin.uiToggleDelete({stopPropagation(){}},0);AlbumAdmin.uiToggleDelete({stopPropagation(){}},1);
            AdminModal.choose=async options=>{
                assert.equal(posts.length,0,'先取得全部选择，再开始删除');
                assert.ok(options.title.includes(original[asked].title));
                assert.equal(options.primary.value,'entry');assert.equal(options.secondary.value,'physical');
                assert.ok(!options.message.includes(original[asked].id));
                return answers[asked++];
            };
            assert.equal(await save(),answers.length===2&&answers[1]==='physical');
            if(answers[answers.length-1]===null)assert.deepEqual(posts,[]);
            else {
                assert.deepEqual(posts.slice(0,2).map(row=>row.body),[
                    {id:original[0].id,delete_physical:false},{id:original[1].id,delete_physical:true}]);
                assert.deepEqual(posts[posts.length-1].body,['nature']);
            }
        }
        """
        self.run_node_esm(body, preamble=(MOCK_TREE_DOM, MOCK_LOCAL_STORAGE, mock_window('/album.html', is_admin=False)))

    def test_gallery_binds_real_admin_tag_events_after_attaching_chips(self):
        """执行真实标签绑定器，首次加载和重绘时标签均已具有父节点。"""
        self.run_view("""
        const {Admin}=await import('./custom/photos/admin/photos-admin.module.js');
        admin.bindTagEvents=Admin.bindTagEvents;
        await initialize();
        const first=gallery.children[0],originalImage=first.children[0];
        let tags=first.querySelector('.photo-tags');
        assert.ok(tags);assert.equal(tags.dataset.tagSetup,'true');
        assert.equal(tags.children[0].parentNode,tags);
        assert.ok(tags.listeners.has('contextmenu'));assert.ok(tags.listeners.has('click'));
        photos[0].tags.push('two');view.render();
        tags=first.querySelector('.photo-tags');
        assert.deepEqual(tags.children.map(chip=>chip.textContent),['one','two']);
        assert.equal(tags.dataset.tagSetup,'true');assert.ok(tags.listeners.has('contextmenu'));
        assert.equal(first.children[0],originalImage);
        """)

    def test_gallery_initialization_failure_reports_through_real_toast_api(self):
        """初始化异常只显示一次错误提示，不在错误处理器内再次抛出异常。"""
        self.run_view("""
        const {Toast}=await import('./shared/toast.module.js');
        const notices=[],errors=[];
        Toast._show=(message,type)=>notices.push([message,type]);
        console.error=(...args)=>errors.push(args);
        controller.reloadData=async()=>{throw Error('test initialization failure');};
        await assert.doesNotReject(initialize);
        assert.deepEqual(notices,[['图库加载失败，请刷新重试','error']]);
        assert.equal(errors.length,1);assert.match(errors[0][0],/图库初始化失败/);
        """)

    def test_gallery_reuses_images_and_resets_filter_order(self):
        """筛选复用图片节点、清除旧排序角标，缩略图失败后回退原图。"""
        self.run_view("""
        await initialize();const first=gallery.children[0],thumbnail=first.children[0];
        assert.equal(thumbnail.loading,'eager');assert.equal(thumbnail.fetchPriority,'high');
        assert.equal(gallery.children[1].children[0].loading,'lazy');assert.equal(thumbnail.src,'a.webp');
        assert.equal(first.getAttribute('data-order-num'),'1');
        core.AppState.searchQuery='filter';photos[1]._deleted=true;
        view.render([photos[1],photos[0]]);
        assert.equal(gallery.children[1],first);assert.equal(first.children[0],thumbnail);
        assert.equal(first.getAttribute('data-order-num'),null);
        assert.equal(actions.at(-1).onSort,null);
        thumbnail.onerror();assert.equal(thumbnail.src,photos[0].path);assert.equal(thumbnail.onerror,null);
        view.render([]);assert.equal(gallery.children.length,0);
        """)

    def test_invalid_category_config_does_not_stop_gallery_and_sort_keeps_original_order(self):
        """分类配置无效仍加载图片，几种文件时间格式可排序并恢复默认顺序。"""
        self.run_view("""
        const errors=[];console.error=(...args)=>errors.push(args);
        configuration={invalid:true};
        controller.State.loadedData=[{path:'one.png',name:'20260115_184233_72'},
            {path:'two.png',name:'IMG_20250108_175319'},
            {path:'three.png',name:'20260115184233'},
            {path:'four.png',name:'bad_20269999_999999'}];
        await initialize();assert.equal(controller.loads,1);assert.equal(gallery.children.length,4);
        assert.equal(errors.length,1);
        sortItems[1].onclick(click);
        assert.deepEqual(controller.State.loadedData.map(item=>item.path),['one.png','three.png','two.png','four.png']);
        sortItems[2].onclick(click);
        assert.deepEqual(controller.State.loadedData.map(item=>item.path),['four.png','two.png','three.png','one.png']);
        sortItems[0].onclick(click);
        assert.deepEqual(controller.State.loadedData.map(item=>item.path),['one.png','two.png','three.png','four.png']);
        """)

    def test_cms_grid_keeps_pending_and_fallback_cover_nodes(self):
        """原位刷新复用未加载及已回退封面，换封面后仍有原图回退。"""
        body = """
        const grid=new Element();
        document.getElementById=id=>id==='grid-container'?grid:null;
        document.createElement=tag=>new Element(tag);
        document.createDocumentFragment=()=>new Element('fragment');
        const observed=[];
        globalThis.IntersectionObserver=class {observe(image){observed.push(image);}};
        window.IntersectionObserver=IntersectionObserver;
        const {DataProvider,publicMediaUrl}=await import('./data-manage/data-provider.module.js');
        const {initGrid,renderGrid}=await import('./custom/cms/viewer/render/cms-render-grid.module.js');
        const state={IS_ADMIN:false,AppState:{activeFilters:new Set(),lockedNodes:[]},
            currentRenderTask:0,incrementRenderTask(){return ++this.currentRenderTask;}};
        initGrid({State:state,Controller:{CONFIG:{CURRENT_MODULE:'games'}}});
        const node={id:'game',type:'note',title:'A',tags:[],coverImage:'photos/images/games/a.png',
            coverThumb:'photos/thumbnails/games/a.webp',coverPreview:'photos/previews/games/a.avif'};
        renderGrid([node]);
        const card=grid.children[0],image=card.querySelector('.item-cover-img');
        assert.ok(image.dataset.src);renderGrid([node]);
        assert.equal(grid.children[0],card);assert.equal(card.querySelector('.item-cover-img'),image);
        assert.equal(image.dataset.src,node.coverThumb);
        image.onerror();assert.equal(image.src,node.coverPreview);
        image.onerror();assert.equal(image.src,publicMediaUrl(node.coverImage));
        renderGrid([{...node,title:'B'}]);assert.equal(card.querySelector('.item-cover-img'),image);
        assert.equal(card.querySelector('.item-title').textContent,'B');
        node.coverThumb='photos/thumbnails/games/changed.webp';
        node.coverImage='photos/images/games/changed.png';renderGrid([node]);
        const changed=card.querySelector('.item-cover-img');assert.notEqual(changed,image);
        assert.equal(changed.dataset.src,DataProvider.getCoverUrl(node,'thumb'));
        changed.onerror();assert.equal(changed.src,node.coverPreview);
        changed.onerror();assert.equal(changed.src,publicMediaUrl(node.coverImage));
        changed.onerror();assert.equal(changed.style.display,'none');
        assert.equal(observed.length,2);
        """
        self.run_node_esm(body,preamble=(MOCK_TREE_DOM,mock_window('/games.html')))


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
        const [ready, photos] = await Promise.all([DataProvider.loadCoverIndex(), DataProvider.getGalleryData('gamecovers')]);
        assert.equal(ready, true);
        assert.equal(requests, 2, '封面和图库共用一次索引请求');
        photos[0].thumb = 'draft.webp';
        assert.equal((await DataProvider.getGalleryData('gamecovers'))[0].thumb, rows[0].thumb);
        assert.equal(requests, 2, '同页重读复用已解析的公开数据');
        assert.equal(DataProvider.getCoverUrl(node), rows[0].preview);
        window.MAERS = {Config:{MEDIA_PUBLIC_BASE:'https://cdn.example'}};
        assert.equal(DataProvider.getCoverUrl(node), rows[0].preview, '本机合并后的封面可在 Git 发布前读取');
        assert.equal(DataProvider.getCoverUrl(node, 'preview', {local:false}), 'https://cdn.example/' + rows[0].preview);
        delete window.MAERS;
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

