/** 无浏览器回归：源码模型、画质加载、异步组件销毁和标题搜索。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownSource } from '../../../custom/cms/viewer/cms-source-editor.module.js';
import { Search } from '../../../shared/utils.module.js';
import { PhotoLightbox, measurePhoto } from '../../../custom/photos/viewer/photos-lightbox.module.js';
import { Toast } from '../../../shared/toast.module.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('源码插入使用最新文本，销毁清除私密正文并阻止迟到挂载', async () => {
    class Host extends EventTarget { isConnected = true; setAttribute() {} removeAttribute() {} }
    const loading = deferred(), host = new Host();
    const source = new MarkdownSource(host, '第一行\r\n第二行', () => loading.promise);
    let changes = 0; host.addEventListener('sourcechange', () => changes++);
    source.replace(0, 0, '![上传中](token)\n');
    source.value += '\n用户继续输入';
    source.replaceText('![上传中](token)', '![](photos/images/a.png)');
    assert.equal(source.value, '![](photos/images/a.png)\n第一行\n第二行\n用户继续输入');
    assert.equal(changes, 2);
    const pending = source.mount(); source.destroy();
    loading.resolve({}); await pending;
    assert.equal(source.view, null); assert.equal(source.value, '');
});

test('PhotoSwipe 只接纳最新打开请求，旧关闭回调不覆盖新实例', async () => {
    const classes = new Set();
    globalThis.document = { body: { style: { overflow: 'auto' }, classList: {
        add: value => classes.add(value), remove: value => classes.delete(value) } } };
    const pending = [], instances = [];
    class Viewer {
        constructor(options) { this.options = options; this.currIndex = options.index; this.events = new Map(); instances.push(this); }
        on(name, callback) { this.events.set(name, callback); }
        addFilter() {}
        init() { this.events.get('change')?.(); }
        destroy() { /* 故意推迟回调，模拟旧实例的关闭收尾。 */ }
        refreshSlideContent() { this.events.get('change')?.(); }
    }
    const photos = [{ path: 'original-a', preview: 'preview-a' }, { path: 'original-b', preview: 'preview-b' }];
    const lightbox = new PhotoLightbox({ getItems: () => photos, fixPath: value => value,
        load: async () => ({ default: Viewer }), measure: src => {
            const task = deferred(); pending.push({ src, ...task }); return task.promise;
        } });
    const first = lightbox.open('original-a'), second = lightbox.open('original-b');
    pending[1].resolve({ src: 'preview-b', width: 800, height: 600 }); await second;
    pending[0].resolve({ src: 'preview-a', width: 200, height: 400 }); await first;
    assert.equal(instances.length, 1); assert.equal(instances[0].options.index, 1);
    assert.equal(instances[0].options.dataSource[1].width, 800);
    const old = instances[0]; lightbox.close();
    assert.equal(document.body.style.overflow, 'auto');
    const third = lightbox.open('original-a');
    pending.at(-1).resolve({ src: 'preview-a', width: 200, height: 400 }); await third;
    old.events.get('destroy')();
    assert.equal(lightbox.viewer, instances[1]); assert.equal(document.body.style.overflow, 'hidden');
    lightbox.close(); assert.equal(document.body.style.overflow, 'auto');
    assert.deepEqual(photos, [{ path: 'original-a', preview: 'preview-a' }, { path: 'original-b', preview: 'preview-b' }]);
    delete globalThis.document;
});

test('图片测量超时提示后继续加载，中止时解绑回调和定时器', async () => {
    let image;
    globalThis.Image = class { constructor() { image = this; } };
    try {
        const warning = deferred();
        const loading = measurePhoto('slow-url', undefined, { warningDelay: 0, onSlow: warning.resolve });
        await warning.promise;
        assert.equal(image.src, 'slow-url');
        image.naturalWidth = 800;
        image.naturalHeight = 600;
        image.onload();
        assert.deepEqual(await loading, { src: 'slow-url', width: 800, height: 600 });

        const abort = new AbortController();
        let warned = false;
        const pending = measurePhoto('private-url', abort.signal, { warningDelay: 0, onSlow: () => { warned = true; } });
        abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(image.onload, null); assert.equal(image.onerror, null); assert.equal(image.src, '');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(warned, false);
    } finally { delete globalThis.Image; }
});

test('图库从真实缩略图展开，切图后缩回当前图，关闭动画期间保持页面锁定', async () => {
    const oldDocument = globalThis.document;
    const classes = new Set();
    globalThis.document = { body: { style: { overflow: 'auto' }, classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)) } } };
    const first = { isConnected: true, currentSrc: 'private-thumbnail-a' };
    const second = { isConnected: true, currentSrc: 'private-thumbnail-b' };
    const thumbnails = new Map([['a', first], ['b', second]]);
    const photos = [{ path: 'a', preview: 'preview-a', name: '<照片一>' },
        { path: 'b', preview: 'preview-b', name: '照片二' }];
    let viewer, caption;
    class Viewer {
        constructor(options) {
            viewer = this; this.options = options; this.currIndex = options.index;
            this.events = new Map(); this.filters = new Map();
            this.ui = { registerElement: config => {
                const element = { setAttribute() {} }; config.onInit(element);
                if (config.name === 'caption') caption = element;
            } };
        }
        on(name, callback) { this.events.set(name, callback); }
        addFilter(name, callback) { this.filters.set(name, callback); }
        init() { this.events.get('uiRegister')(); this.events.get('change')(); }
        refreshSlideContent() { this.events.get('change')(); }
        close() { this.events.get('close')(); }
        destroy() { this.events.get('destroy')(); }
    }
    const lightbox = new PhotoLightbox({ getItems: () => photos, fixPath: value => value,
        getThumbnail: path => thumbnails.get(path), load: async () => ({ default: Viewer }),
        measure: async src => ({ src, width: 900, height: 1200 }) });
    try {
        await lightbox.open('a');
        assert.equal(viewer.options.showHideAnimationType, 'zoom');
        assert.equal(viewer.options.dataSource[0].msrc, 'private-thumbnail-a');
        assert.equal(viewer.options.dataSource[0].thumbCropped, true);
        const thumbnail = index => viewer.filters.get('thumbEl')(null, null, index);
        assert.equal(thumbnail(0), first);
        assert.equal(caption.textContent, '<照片一>');
        viewer.currIndex = 1; viewer.events.get('change')();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(caption.textContent, '照片二');
        assert.equal(thumbnail(viewer.currIndex), second);
        second.isConnected = false;
        assert.equal(thumbnail(1), null, '原缩略图已移除时不向过期坐标缩回');
        viewer.close();
        assert.equal(document.body.style.overflow, 'hidden');
        assert.equal(classes.has('is-photo-viewing'), true);
        viewer.destroy();
        assert.equal(document.body.style.overflow, 'auto');
        assert.equal(classes.has('is-photo-viewing'), false);
        assert.equal(photos[0].thumbCropped, undefined, '显示状态不写回图片索引');
    } finally { lightbox.close(); globalThis.document = oldDocument; }
});

test('画质失败不提交状态，可重试；切图取消旧任务且迟到错误不再通知', async () => {
    const oldDocument = globalThis.document, oldNotice = Toast.error;
    globalThis.document = { body: { style: {}, classList: { add() {}, remove() {} } } };
    const notices = [], requests = [];
    Toast.error = message => notices.push(message);
    let viewer, quality;
    class Viewer {
        constructor(options) {
            this.options = options; this.currIndex = options.index; this.events = new Map(); viewer = this;
            this.ui = { registerElement: config => {
                quality = config; config.onInit({ setAttribute() {} });
            } };
        }
        on(name, callback) { this.events.set(name, callback); }
        addFilter() {}
        init() { this.events.get('uiRegister')(); this.events.get('change')(); }
        refreshSlideContent() { this.events.get('change')(); }
        destroy() { this.events.get('close')(); this.events.get('destroy')(); }
    }
    const lightbox = new PhotoLightbox({
        getItems: () => [{path: 'original-a', preview: 'preview-a'}, {path: 'original-b', preview: 'preview-b'}],
        fixPath: value => value, load: async () => ({default: Viewer}),
        measure: (src, signal, options) => {
            if (src.startsWith('preview')) {
                assert.equal(options.warningDelay, 15000);
                return Promise.resolve({src, width: 800, height: 600});
            }
            const pending = deferred(); requests.push({src, signal, options, ...pending}); return pending.promise;
        }
    });
    try {
        await lightbox.open('original-a');
        const failed = quality.onClick();
        quality.onClick(); assert.equal(requests.length, 1, '同一请求未结束时不重复排队');
        assert.equal(requests[0].options.warningDelay, 30000);
        requests[0].reject(Error('图片加载失败')); await failed;
        assert.equal(viewer.options.dataSource[0].src, 'preview-a');
        const retried = quality.onClick();
        assert.equal(requests[1].src, 'original-a');
        requests[1].resolve({src: 'original-a', width: 2400, height: 1800}); await retried;
        assert.equal(viewer.options.dataSource[0].src, 'original-a');
        // 已成功的原图选择会沿用到下一张；离开后旧失败不再打断当前图片。
        viewer.currIndex = 1; viewer.events.get('change')();
        assert.equal(requests[2].src, 'original-b');
        viewer.currIndex = 0; viewer.events.get('change')();
        assert.equal(requests[2].signal.aborted, true);
        requests[2].reject(Error('迟到的网络错误'));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(notices.length, 1);
        assert.equal(viewer.options.dataSource[0].src, 'original-a');
    } finally {
        lightbox.close(); Toast.error = oldNotice; globalThis.document = oldDocument;
    }
});

test('本地图库使用本机文件，线上继续使用 CDN，私密与外部地址保留', async () => {
    const previous = globalThis.window;
    globalThis.window = {location: {hostname: 'localhost', search: '?id=nature'},
        MAERS: {Config: {MEDIA_PUBLIC_BASE: 'https://cdn.example'}}};
    try {
        const controller = await import('../../../custom/photos/admin/photos-controller.module.js');
        const provider = {isLocal: true}; controller.initController(provider);
        assert.equal(controller.fixPath('photos/images/nature/a b.png'), '/photos/images/nature/a%20b.png');
        assert.equal(controller.fixPath('/photos/images/nature/a b.png'), '/photos/images/nature/a%20b.png');
        assert.equal(controller.fixPath('x.avif', null, 'previews'), '/photos/previews/nature/x.avif');
        assert.equal(controller.fixPath('/api/private/media/photos/images/x.png'), '/api/private/media/photos/images/x.png');
        assert.equal(controller.fixPath('https://outside.example/a.png'), 'https://outside.example/a.png');
        provider.isLocal = false;
        assert.equal(controller.fixPath('photos/images/nature/a b.png'), 'https://cdn.example/photos/images/nature/a%20b.png');
    } finally { globalThis.window = previous; }
});

test('标题与拼音查询遵循标签筛选，密文子树不参与搜索', () => {
    const note = { id: 'public', title: '普通标题', tags: ['公开'] };
    const child = { id: 'child', title: '子标题', tags: ['公开'] };
    const tree = [note, { id: 'folder', title: '组', children: [child] },
        { id: 'locked', _enc: 'enc:cipher', children: [{ id: 'leak', title: '隐藏' }] }];
    assert.deepEqual(Search.filterNodes(tree, new Set(['公开']), '普通'), [note]);
    assert.deepEqual(Search.filterNodes(tree, new Set(['其他']), '普通'), []);
    assert.deepEqual(Search.filterNodes(tree, new Set(), 'ptbt'), [note]);
    assert.deepEqual(Search.filterNodes(tree, new Set(), '隐藏'), []);
    assert.deepEqual(Search.filterNodes(tree, new Set(), '普通，子标题'), [note, child]);
});
