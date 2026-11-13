/** 阅读器源码交互：抽屉、输入预览、快捷保存与图片上传，沿用文章代次保护。 */
import { Toast } from '../../../shared/toast.module.js';
import { disableAdminControl, isLocalOnlyUnavailable } from '../../../data-manage/admin/local-only.module.js';
import { createReaderScrollSync } from './cms-scroll-sync.module.js';
import { MarkdownSource } from './cms-source-editor.module.js';

function notify(message, type = 'info') {
    (Toast[type] || Toast.info).call(Toast, message);
}

export function createReaderSource({ state: readerState, getController, save, openExternal, renderMarkdown }) {
    // ─── 绑定管理端顶栏与源码抽屉交互事件 ───
    function bind(layer, node, initialMd) {
        const host = layer.querySelector('#cms-source-editor');
        const sourceTextarea = host ? new MarkdownSource(host, initialMd) : null;
        readerState.sourceEditor = sourceTextarea;
        _bindTitleInput(layer.querySelector('#edit-title-input'));
        _bindExternalButton(layer.querySelector('#btn-open-external'), node);
        _bindSourceDrawer(layer, sourceTextarea);
        _bindSourceEditing(layer, sourceTextarea);
        _bindSourceActions(layer, sourceTextarea);
    }

    /** 标题回车失焦时保存重命名，正文读取失败时仍可单独改标题。 */
    function _bindTitleInput(titleInput) {
        if (!titleInput) return;
        titleInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                titleInput.blur();
            }
        });
        titleInput.addEventListener('change', async () => {
            const nextTitle = titleInput.value.trim();
            if (nextTitle && nextTitle !== readerState.node?.title) {
                const res = await save(undefined, { titleOnly: true });
                if (res?.success) {
                    notify('标题已更新', 'success');
                }
            }
        });
    }

    /** 云端禁用外部软件入口，本地沿用文章 ID 打开原文件。 */
    function _bindExternalButton(button, node) {
        if (!button) return;
        if (!node._private && isLocalOnlyUnavailable()) {
            disableAdminControl(button, '外部编辑器仅限电脑本地后台，可使用源码编辑');
            return;
        }
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            openExternal(node.id);
        });
    }

    /** 源码抽屉展开前捕获阅读位置，展开后交给滚动同步器恢复。 */
    function _bindSourceDrawer(layer, sourceTextarea) {
        const sourceDrawer = layer.querySelector('#cms-source-drawer');
        const toggleSourceBtn = layer.querySelector('#btn-toggle-source');
        const closeSourceBtn = layer.querySelector('#btn-close-source');
        let toggling = false;
        const toggleDrawer = async (forceOpen = null) => {
            if (!sourceDrawer) return;
            if (toggling) return;
            const willOpen = forceOpen !== null ? forceOpen : sourceDrawer.classList.contains('collapsed');
            if (willOpen && sourceTextarea) {
                toggling = true;
                try {
                    await sourceTextarea.mount();
                    if (!sourceTextarea.isConnected) return;
                    if (!readerState.scrollSync) readerState.scrollSync = createReaderScrollSync({
                        preview: layer.querySelector('.reader-scroll-area'), content: layer.querySelector('#reader-content'),
                        source: sourceTextarea, drawer: sourceDrawer
                    });
                } catch (error) {
                    console.error('[MAERS.CMS] 源码编辑器加载失败', error);
                    notify('源码编辑器加载失败，请重试', 'error'); return;
                } finally { toggling = false; }
            }
            const line = readerState.scrollSync?.capture() ?? 0;
            sourceDrawer.classList.toggle('collapsed', !willOpen);
            toggleSourceBtn?.classList.toggle('active', willOpen);
            if (willOpen && sourceTextarea) {
                if (!readerState.dirty) {
                    sourceTextarea.value = readerState.node?._rawMd ?? readerState.node?.content ?? '';
                }
            }
            readerState.scrollSync?.drawerChanged(line, willOpen);
        };

        if (toggleSourceBtn) {
            toggleSourceBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDrawer();
            });
        }
        if (closeSourceBtn) {
            closeSourceBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDrawer(false);
            });
        }
    }

    /** 输入法组合完成后才刷新预览，支持快捷保存及粘贴图片。 */
    function _bindSourceEditing(layer, sourceTextarea) {
        if (!sourceTextarea) return;
        let isImeComposing = false;

        const host = sourceTextarea.host;
        host.addEventListener('compositionstart', () => {
            isImeComposing = true;
            clearTimeout(readerState.previewTimer);
        });

        host.addEventListener('compositionend', () => {
            isImeComposing = false;
            readerState.dirty = true;
            _scheduleSourcePreview(layer, sourceTextarea);
        });

        host.addEventListener('sourcechange', (e) => {
            readerState.dirty = true;
            if (isImeComposing || e.isComposing) return;
            _scheduleSourcePreview(layer, sourceTextarea);
        });

        host.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                save(sourceTextarea.value);
            }
        }, true);

        // 支持在源码框中直接粘贴剪贴板图片自动上传
        host.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            const imageFiles = [];
            for (const item of items) {
                if (item.type && item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) imageFiles.push(file);
                }
            }
            if (imageFiles.length > 0) {
                e.preventDefault();
                _handleImageUpload(imageFiles);
            }
        }, true);
    }

    /** 图表代码块沿用较长的预览防抖，避免逐字重绘。 */
    function _scheduleSourcePreview(layer, textarea) {
        clearTimeout(readerState.previewTimer);
        readerState.previewTimer = setTimeout(() => {
            // 完成一轮输入后才读取全文，输入事件本身只负责重置计时器。
            const beforeCursor = textarea.value.slice(0, textarea.selectionStart || 0);
            const fences = beforeCursor.match(/^\s*```[^\n]*/gm) || [];
            const diagram = fences.length % 2 && /```(?:mindmap|markmap|mermaid|echarts|flowchart|graphviz)/i.test(fences.at(-1));
            if (diagram) readerState.previewTimer = setTimeout(() => _renderSourcePreview(layer, textarea), 600);
            else _renderSourcePreview(layer, textarea);
        }, 600);
    }

    /** 源码输入与图片上传共用预览刷新，并保留当前滚动位置。 */
    function _renderSourcePreview(layer, textarea) {
        const content = document.getElementById('reader-content');
        if (!content || !readerState.node) return;
        const scroll = layer?.querySelector('.reader-scroll-area');
        renderMarkdown(content, textarea.value, readerState.node, scroll ? scroll.scrollTop : 0);
    }

    /** 绑定源码保存与文件选择，上传流程继续复用同一入口。 */
    function _bindSourceActions(layer, sourceTextarea) {
        const saveSourceBtn = layer.querySelector('#btn-save-source');
        const uploadImgBtn = layer.querySelector('#btn-upload-md-img');
        const imgFileInput = layer.querySelector('#cms-md-img-input');
        if (saveSourceBtn) {
            saveSourceBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                save(sourceTextarea ? sourceTextarea.value : undefined);
            });
        }

        if (uploadImgBtn && imgFileInput) {
            uploadImgBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                imgFileInput.value = '';
                imgFileInput.click();
            });
            imgFileInput.addEventListener('change', () => {
                if (imgFileInput.files && imgFileInput.files.length > 0) {
                    _handleImageUpload(Array.from(imgFileInput.files));
                }
            });
        }
    }

    // ─── 源码抽屉图片上传并插入光标处 ───
    async function _handleImageUpload(files) {
        if (!getController()?.uploadImage) {
            notify('上传组件未就绪', 'error');
            return null;
        }

        const textarea = readerState.sourceEditor;
        if (!textarea) return null;

        const generation = readerState.generation;
        const uploadNode = readerState.node;
        for (const file of files) {
            if (generation !== readerState.generation || !textarea.isConnected) break;
            const placeholder = `![上传中...](placeholder_${crypto.randomUUID()})`;

            // 在光标位置插入上传占位符
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? textarea.value.length;
            const before = textarea.value.slice(0, start);
            const selected = textarea.value.slice(start, end);
            const prefix = before && !before.endsWith('\n') ? '\n' : '';
            const insertText = `${prefix}${placeholder}\n`;
            textarea.replace(start, end, insertText);
            readerState.dirty = true;

            let res;
            try { res = await getController().uploadImage(file, uploadNode?.id); }
            catch (error) { res = { success: false, msg: error.message }; }
            if (generation !== readerState.generation || uploadNode !== readerState.node || !textarea.isConnected) break;
            if (res?.success) {
                const rawPath = res.relPath || res.path || '';
                const normPath = rawPath.replace(/^(?:\.\.\/)+/, '').replace(/^\//, '');
                textarea.replaceText(placeholder, `![](${normPath})`);
            } else {
                const pendingText = textarea.value.includes(insertText) ? insertText : placeholder;
                textarea.replaceText(pendingText, selected);
                notify(res?.msg || '图片上传失败', 'error');
            }

            // 实时刷新左侧阅读器预览
            const layer = document.getElementById('immersive-reader');
            _renderSourcePreview(layer, textarea);
        }
        return null;
    }

    return { bind };
}
