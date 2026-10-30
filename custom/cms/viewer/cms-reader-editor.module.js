/** 阅读器后台编辑：保存与冲突保护、源码抽屉交互、图片上传。 */
import { sha256Hex } from '../../../data-manage/encrypt/crypto.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { createReaderScrollSync } from './cms-scroll-sync.module.js';

/** 状态由阅读器生命周期持有；异步保存与上传沿用同一代次，避免写入已切换的文章。 */
export function createReaderEditor({ state: readerState, getController, renderMarkdown, refreshBacklinks }) {
    const _saveRequests = new Map();
    const _notify = (message, type = 'info') => (Toast[type] || Toast.info).call(Toast, message);

    // ─── 唤醒系统默认外部 Markdown 软件 (Typora / Obsidian) ───
    async function openExternal(nodeId = null) {
        const targetId = nodeId || readerState.editingId || readerState.node?.id;
        if (!targetId || !getController()?.callApi) return { success: false };
        const target = getController().AppState?.allNodes?.find(node => node.id === targetId);
        if (target?._private) {
            document.getElementById('btn-toggle-source')?.click();
            return { success: true };
        }

        const btn = document.getElementById('btn-open-external');
        if (btn) btn.disabled = true;

        try {
            const res = await getController().callApi('open_external', { id: targetId });
            if (res?.success) {
                _notify('已唤醒外部编辑器，保存后切回网页将自动刷新', 'success');
            }
            return res;
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ─── 保存笔记标题与正文 (兼容本地落盘与云端 Worker 中继暂存) ───
    async function save(customContent = undefined, options = {}) {
        const id = readerState.editingId || readerState.node?.id;
        if (!window.IS_ADMIN || !id || !getController()?.callApi) return { success: false };
        const generation = readerState.generation;
        if (_saveRequests.has(id)) {
            const result = await _saveRequests.get(id);
            if (!result?.success || generation !== readerState.generation || !readerState.dirty) return result;
            return save(customContent, options);
        }
        const pending = _persistNote(id, customContent, options).finally(() => _saveRequests.delete(id));
        _saveRequests.set(id, pending);
        return pending;
    }

    async function _persistNote(id, customContent, options) {
        const generation = readerState.generation;
        const node = readerState.node;
        const button = document.querySelector('.editor-save-btn');
        const title = document.getElementById('edit-title-input');
        const textarea = document.getElementById('cms-source-textarea');
        const name = (title?.value || node?.title || 'Untitled').trim() || 'Untitled';
        const text = customContent !== undefined ? String(customContent) : (textarea?.value ?? node?._rawMd ?? '');
        if (node?._loadFailed && !options.titleOnly) {
            _notify('正文尚未成功读取，请重新打开后再保存；原文未改动', 'error');
            return { success: false, msg: 'content_not_loaded' };
        }
        const previousPath = node?._mdPath;
        const current = () => generation === readerState.generation && readerState.node?.id === id;
        clearTimeout(readerState.saveTimer);
        if (button) { button.disabled = true; button.textContent = '保存中...'; }
        let result = { success: false };
        try {
            const data = options.titleOnly ? { title: name } : { title: name, content: text,
                ...(node?._sourceRevision ? { expectedRevision: node._sourceRevision } : {}) };
            result = await getController().callApi('update', { id, data });
            if (!result?.success) return result;
            const reloaded = getController().AppState?.allNodes?.find(item => item.id === id) || node;
            if (options.titleOnly) {
                const savedPath = typeof reloaded.content === 'string' && reloaded.content.endsWith('.md')
                    ? reloaded.content : previousPath;
                for (const item of new Set([node, reloaded])) {
                    if (!item) continue;
                    item.title = name;
                    if (savedPath) item._mdPath = savedPath;
                }
                getController().refreshView?.(false, true);
                return result;
            }
            const revision = await sha256Hex(text);
            const edited = current() && ((textarea && textarea.value !== text) || (title && title.value.trim() !== name));
            for (const item of new Set([node, reloaded])) {
                if (!item) continue;
                if (typeof item.content === 'string' && item.content.endsWith('.md')) item._mdPath = item.content;
                else if (previousPath) item._mdPath = previousPath;
                item._originalContent = text;
                item._sourceRevision = revision;
                item.title = edited && title ? title.value : name;
                item.content = item._rawMd = edited && textarea ? textarea.value : text;
                if (edited) item._draftContent = item._rawMd;
                else delete item._draftContent;
            }
            if (current()) {
                readerState.node = reloaded;
                readerState.dirty = Boolean(edited);
                if (textarea && !edited) textarea.value = text;
                const content = document.getElementById('reader-content');
                const scroll = document.querySelector('#immersive-reader .reader-scroll-area');
                if (content) renderMarkdown(content, reloaded._rawMd, reloaded, scroll?.scrollTop || 0);
                refreshBacklinks();
            }
            getController().refreshView?.(false, true);
        } catch (error) {
            console.error('[MAERS.CMS] 保存失败:', error);
            if (current()) _notify('保存失败，请重试；当前编辑内容仍保留', 'error');
            result = { success: false, msg: error.message };
        } finally {
            if (current() && button?.isConnected) {
                button.disabled = false;
                button.textContent = result?.success ? (readerState.dirty ? '保存更改' : '已保存') : '保存失败';
                readerState.saveTimer = setTimeout(() => {
                    if (current() && button.isConnected) button.textContent = '保存更改';
                }, 1500);
            }
        }
        return result;
    }

    // ─── 绑定管理端顶栏与源码抽屉交互事件 ───
    function bind(layer, node, initialMd) {
        const titleInput = layer.querySelector('#edit-title-input');
        const openExtBtn = layer.querySelector('#btn-open-external');
        const toggleSourceBtn = layer.querySelector('#btn-toggle-source');
        const sourceDrawer = layer.querySelector('#cms-source-drawer');
        const sourceTextarea = layer.querySelector('#cms-source-textarea');
        const closeSourceBtn = layer.querySelector('#btn-close-source');
        const saveSourceBtn = layer.querySelector('#btn-save-source');
        const uploadImgBtn = layer.querySelector('#btn-upload-md-img');
        const imgFileInput = layer.querySelector('#cms-md-img-input');

        if (sourceTextarea) {
            sourceTextarea.value = initialMd || '';
            readerState.scrollSync = createReaderScrollSync({
                preview: layer.querySelector('.reader-scroll-area'),
                content: layer.querySelector('#reader-content'),
                source: sourceTextarea, drawer: sourceDrawer
            });
        }

        // 1. 顶栏标题直改：回车或失焦变更时自动保存重命名
        if (titleInput) {
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
                        _notify('标题已更新', 'success');
                    }
                }
            });
        }

        // 2. 外部软件打开按钮
        if (openExtBtn) {
            openExtBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openExternal(node.id);
            });
        }

        // 3. 展开 / 收起源码抽屉
        const toggleDrawer = (forceOpen = null) => {
            if (!sourceDrawer) return;
            const line = readerState.scrollSync?.capture() ?? 0;
            const willOpen = forceOpen !== null ? forceOpen : sourceDrawer.classList.contains('collapsed');
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

        // 5. 源码抽屉编辑实时预览与 Ctrl+S 快捷保存
        if (sourceTextarea) {
            let isImeComposing = false;

            const scheduleLivePreview = () => {
                clearTimeout(readerState.previewTimer);
                // 检测当前光标是否处于思维导图/流程图代码块内，导图块内编辑采用 1200ms 停顿防抖，避免每打一个符号都触发重绘
                const cursorPos = sourceTextarea.selectionStart || 0;
                const beforeCursor = sourceTextarea.value.slice(0, cursorPos);
                const openFenceMatch = beforeCursor.match(/```(\w*)\s*\n(?![\s\S]*?```)/g);
                const lastFence = openFenceMatch ? openFenceMatch[openFenceMatch.length - 1] : '';
                const isEditingDiagram = /```(?:mindmap|markmap|mermaid|echarts|flowchart|graphviz)/i.test(lastFence);
                const delayMs = isEditingDiagram ? 1200 : 600;

                readerState.previewTimer = setTimeout(() => {
                    const contentDiv = document.getElementById('reader-content');
                    const scrollArea = layer.querySelector('.reader-scroll-area');
                    if (contentDiv && readerState.node) {
                        const savedScroll = scrollArea ? scrollArea.scrollTop : 0;
                        renderMarkdown(contentDiv, sourceTextarea.value, readerState.node, savedScroll);
                    }
                }, delayMs);
            };

            sourceTextarea.addEventListener('compositionstart', () => {
                isImeComposing = true;
                clearTimeout(readerState.previewTimer);
            });

            sourceTextarea.addEventListener('compositionend', () => {
                isImeComposing = false;
                readerState.dirty = true;
                scheduleLivePreview();
            });

            sourceTextarea.addEventListener('input', (e) => {
                readerState.dirty = true;
                if (isImeComposing || e.isComposing) return;
                scheduleLivePreview();
            });

            sourceTextarea.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    save(sourceTextarea.value);
                }
            });

            // 支持在源码框中直接粘贴剪贴板图片自动上传
            sourceTextarea.addEventListener('paste', (e) => {
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
            });
        }

        // 6. 源码抽屉保存按钮
        if (saveSourceBtn) {
            saveSourceBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                save(sourceTextarea ? sourceTextarea.value : undefined);
            });
        }

        // 7. 源码抽屉图片上传按钮
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
            _notify('上传组件未就绪', 'error');
            return null;
        }

        const textarea = document.getElementById('cms-source-textarea');
        if (!textarea) return null;

        const generation = readerState.generation;
        const uploadNode = readerState.node;
        for (const file of files) {
            if (generation !== readerState.generation || !textarea.isConnected) break;
            const now = new Date();
            const stamp = [
                now.getFullYear(),
                String(now.getMonth() + 1).padStart(2, '0'),
                String(now.getDate()).padStart(2, '0'),
                String(now.getHours()).padStart(2, '0'),
                String(now.getMinutes()).padStart(2, '0'),
                String(now.getSeconds()).padStart(2, '0'),
                String(Math.floor(Math.random() * 99) + 1).padStart(2, '0')
            ].join('');
            const placeholder = `![上传中...](placeholder_${stamp})`;

            // 在光标位置插入上传占位符
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? textarea.value.length;
            const before = textarea.value.slice(0, start);
            const after = textarea.value.slice(end);
            const prefix = before && !before.endsWith('\n') ? '\n' : '';
            const insertText = `${prefix}${placeholder}\n`;
            textarea.value = before + insertText + after;
            readerState.dirty = true;

            let res;
            try { res = await getController().uploadImage(file, uploadNode?.id); }
            catch (error) { res = { success: false, msg: error.message }; }
            if (generation !== readerState.generation || uploadNode !== readerState.node || !textarea.isConnected) break;
            if (res?.success) {
                const rawPath = res.relPath || res.path || '';
                const normPath = rawPath.replace(/^(?:\.\.\/)+/, '').replace(/^\//, '');
                textarea.value = textarea.value.replace(placeholder, `![](${normPath})`);
            } else {
                textarea.value = textarea.value.replace(placeholder, `> [!WARNING]\n> 图片上传失败: ${file.name}`);
            }

            // 实时刷新左侧阅读器预览
            const contentDiv = document.getElementById('reader-content');
            const layer = document.getElementById('immersive-reader');
            const scrollArea = layer?.querySelector('.reader-scroll-area');
            if (contentDiv && readerState.node) {
                const savedScroll = scrollArea ? scrollArea.scrollTop : 0;
                renderMarkdown(contentDiv, textarea.value, readerState.node, savedScroll);
            }
        }
        return null;
    }

    return { save, openExternal, bind };
}
