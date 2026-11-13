/** PhotoSwipe 图库适配：按需加载、预览/原图切换与私密地址沿用现有控制器。 */
import { Toast } from '../../../shared/toast.module.js';
import { loadLocalAsset } from '../../../shared/utils.module.js';

const loadViewer = async () => {
    const before = document.querySelector('link[href$="custom/photos/viewer/photos-viewer.css"]');
    const [module] = await Promise.all([
        import('../../../plugins/ui-components/photoswipe.module.js'),
        loadLocalAsset('plugins/ui-components/photoswipe.css', { stylesheet: true, before })
    ]);
    return module;
};
const PREVIEW_WARNING_MS = 15000;
const ORIGINAL_WARNING_MS = 30000;

/** 只在内存测量实际图片尺寸，不把临时私密地址写入图库索引。 */
export function measurePhoto(src, signal, { warningDelay = PREVIEW_WARNING_MS, onSlow } = {}) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const finish = (error) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            image.onload = image.onerror = null;
            if (error) { image.src = ''; reject(error); }
            else resolve({ src, width: image.naturalWidth, height: image.naturalHeight });
        };
        const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
        const timer = onSlow && setTimeout(onSlow, warningDelay);
        image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? finish() : finish(Error('图片尺寸无效'));
        image.onerror = () => finish(Error('图片加载失败'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else image.src = src;
    });
}

export class PhotoLightbox {
    constructor({ getItems, fixPath, getThumbnail = () => null, load = loadViewer, measure = measurePhoto }) {
        this.getItems = getItems;
        this.fixPath = fixPath;
        this.getThumbnail = getThumbnail;
        this.load = load;
        this.measure = measure;
        this.generation = 0;
        this.viewer = null;
        this.abort = null;
        this.qualityAbort = null;
    }

    async open(path) {
        const items = this.getItems();
        const index = items.findIndex(photo => photo.path === path);
        if (index < 0) return;
        this.close();
        const generation = this.generation;
        const abort = this.abort = new AbortController();
        const dimensions = new Map();
        const sourceFor = (photo, hd) => hd ? this.fixPath(photo.path) :
            this.fixPath(photo.preview, null, 'previews') || this.fixPath(photo.path);
        const prepare = async (photo, hd, signal = abort.signal) => {
            const original = this.fixPath(photo.path);
            const src = sourceFor(photo, hd);
            const measure = async source => {
                if (dimensions.has(source)) return dimensions.get(source);
                const data = await this.measure(source, signal, {
                    warningDelay: source === original ? ORIGINAL_WARNING_MS : PREVIEW_WARNING_MS,
                    onSlow: () => Toast.warning('网站认为加载超时，但可继续等待')
                });
                if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
                dimensions.set(source, data);
                return data;
            };
            let data;
            try { data = await measure(src); }
            catch (error) {
                if (error.name === 'AbortError' || src === original) throw error;
                data = await measure(original);
            }
            return { ...data, _hd: data.src === original };
        };
        try {
            const [{ default: PhotoSwipe }, first] = await Promise.all([this.load(), prepare(items[index], false)]);
            if (generation !== this.generation) return;
            const slides = items.map(photo => ({ src: sourceFor(photo, false),
                width: Number(photo.width) || 1600, height: Number(photo.height) || 1000,
                alt: photo.name || '照片', thumbCropped: true }));
            Object.assign(slides[index], first);
            const thumbnail = this.getThumbnail(items[index].path);
            slides[index].msrc = thumbnail?.currentSrc || thumbnail?.src;
            const viewer = this.viewer = new PhotoSwipe({ dataSource: slides, index,
                mainClass: 'maers-photoswipe', bgOpacity: 0.9, showHideAnimationType: 'zoom',
                showAnimationDuration: 320, hideAnimationDuration: 260,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                // 图像与底部标题、序号和切图按钮分区，窄屏也留出完整操作区。
                paddingFn: viewport => ({ top: 56, bottom: 156,
                    left: Math.max(16, Math.round(viewport.x * 0.05)), right: Math.max(16, Math.round(viewport.x * 0.05)) }),
                zoom: false, wheelToZoom: true, errorMsg: '图片加载失败，请重试',
                closeTitle: '关闭', arrowPrevTitle: '上一张', arrowNextTitle: '下一张' });
            // 关闭时重新定位当前图片的缩略图；已翻页或节点移除时由组件退回淡出。
            viewer.addFilter('thumbEl', (_element, _data, selected) => {
                const image = this.getThumbnail(items[selected].path);
                return image?.isConnected ? image : null;
            });
            let hd = first._hd, qualityRequest = 0, qualityButton, caption, activeJob = null, failure = null;
            let currentIndex = index;
            const updateButton = () => {
                if (!qualityButton) return;
                const current = slides[viewer.currIndex] || slides[index];
                const isHD = Boolean(current._hd);
                const retry = failure?.index === viewer.currIndex;
                qualityButton.disabled = Boolean(activeJob);
                qualityButton.textContent = activeJob ? (activeJob.hd ? '原图加载中…' : '预览加载中…') :
                    `${isHD ? 'Ori' : 'Pre'}${retry ? ' · 重试' : ''}`;
                qualityButton.setAttribute('aria-pressed', String(isHD));
                qualityButton.setAttribute('aria-busy', String(Boolean(activeJob)));
                qualityButton.setAttribute('data-load-state', activeJob ? 'loading' : retry ? 'error' : 'ready');
                const title = activeJob ? '正在切换画质，可关闭灯箱或切换图片取消' :
                    retry ? `切换失败，当前仍为${isHD ? '原图' : '预览图'}，点击重试` :
                        `当前为${isHD ? '原图，点击切换预览' : '预览图，点击加载原图'}`;
                qualityButton.title = title;
                qualityButton.setAttribute('aria-label', title);
            };
            const refresh = async targetHD => {
                this.qualityAbort?.abort();
                const controller = this.qualityAbort = new AbortController();
                const request = ++qualityRequest, selected = viewer.currIndex;
                const current = () => generation === this.generation && request === qualityRequest &&
                    selected === viewer.currIndex && !controller.signal.aborted;
                activeJob = { index: selected, hd: targetHD };
                failure = null;
                updateButton();
                try {
                    const data = await prepare(items[selected], targetHD, controller.signal);
                    if (!current()) return;
                    hd = data._hd;
                    const slide = slides[selected];
                    const changed = slide.src !== data.src || slide.width !== data.width || slide.height !== data.height;
                    Object.assign(slide, data);
                    activeJob = null;
                    if (changed) {
                        viewer.refreshSlideContent(selected);
                    }
                } catch (error) {
                    // 旧图片或已取消任务的失败不能再弹提示，也不能改变新图片的画质状态。
                    if (!current() || error.name === 'AbortError') return;
                    failure = { index: selected, hd: targetHD };
                    Toast.error(`${targetHD ? '原图' : '预览图'}加载失败，已保留当前图片，可重试`);
                } finally {
                    if (current()) {
                        activeJob = null;
                        updateButton();
                    }
                }
            };
            viewer.on('uiRegister', () => {
                viewer.ui.registerElement({ name: 'caption', appendTo: 'root',
                    className: 'maers-photo-caption pswp__hide-on-close',
                    onInit: element => {
                        caption = element;
                        caption.setAttribute('aria-live', 'polite');
                        caption.textContent = slides[viewer.currIndex].alt;
                    } });
                viewer.ui.registerElement({ name: 'quality', order: 9,
                    isButton: true, title: '切换预览/原图', html: 'Pre',
                    onInit: element => { qualityButton = element; updateButton(); },
                    onClick: () => {
                        if (activeJob) return;
                        return refresh(failure?.index === viewer.currIndex ? failure.hd : !slides[viewer.currIndex]._hd);
                    } });
            });
            viewer.on('change', () => {
                if (caption) caption.textContent = slides[viewer.currIndex].alt;
                if (viewer.currIndex === currentIndex) { updateButton(); return; }
                currentIndex = viewer.currIndex;
                refresh(hd);
            });
            viewer.on('close', () => {
                qualityRequest++;
                if (this.viewer === viewer) this.qualityAbort?.abort();
                abort.abort();
            });
            viewer.on('destroy', () => {
                abort.abort(); dimensions.clear();
                if (this.viewer !== viewer) return;
                this.generation++;
                this.qualityAbort?.abort();
                this.viewer = null;
                document.body.style.overflow = this.previousOverflow;
                document.body.classList.remove('is-viewing', 'is-photo-viewing');
            });
            this.previousOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            document.body.classList.add('is-viewing', 'is-photo-viewing');
            viewer.init();
        } catch (error) {
            if (generation === this.generation) {
                this.close();
                if (error.name !== 'AbortError') Toast.error(error.message || '灯箱加载失败');
            }
        }
    }

    close() {
        this.generation++;
        this.abort?.abort();
        this.qualityAbort?.abort();
        // destroy 立即释放旧实例，避免开新图时关闭动画回调覆盖新状态。
        const viewer = this.viewer;
        this.viewer = null;
        if (viewer) {
            document.body.style.overflow = this.previousOverflow;
            document.body.classList.remove('is-viewing', 'is-photo-viewing');
            viewer.destroy();
        }
    }
}
