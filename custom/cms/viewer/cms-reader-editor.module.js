/** 阅读器后台保存：并发去重、修订冲突保护与编辑状态回写，源码交互交由独立模块。 */
import { sha256Hex } from '../../../data-manage/encrypt/crypto.module.js';
import { isLocalOnlyUnavailable } from '../../../data-manage/admin/local-only.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { createReaderSource } from './cms-reader-source.module.js';

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
        if (isLocalOnlyUnavailable()) return { success: false };

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
        const textarea = readerState.sourceEditor;
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
                _saveTitleOnly(name, node, reloaded, previousPath);
                return result;
            }
            await _saveFullContent({ name, text, node, reloaded, previousPath, current, title, textarea });
        } catch (error) {
            console.error('[MAERS.CMS] 保存失败:', error);
            if (current()) _notify('保存失败，请重试；当前编辑内容仍保留', 'error');
            result = { success: false, msg: error.message };
        } finally {
            _updateSaveButton(button, result, current);
        }
        return result;
    }

    /** 仅保存标题：同步 node 与 reloaded 的标题和路径 */
    function _saveTitleOnly(name, node, reloaded, previousPath) {
        const savedPath = (!reloaded._private || previousPath) && typeof reloaded.content === 'string' && reloaded.content.endsWith('.md')
            ? reloaded.content : previousPath;
        for (const item of new Set([node, reloaded])) {
            if (!item) continue;
            item.title = name;
            if (savedPath) item._mdPath = savedPath;
        }
        getController().refreshView?.(false, true);
    }

    /** 保存完整正文：计算修订哈希、同步节点状态、刷新预览 */
    async function _saveFullContent({ name, text, node, reloaded, previousPath, current, title, textarea }) {
        const revision = await sha256Hex(text);
        const edited = current() && ((textarea && textarea.value !== text) || (title && title.value.trim() !== name));
        // 中继确认的是草稿，正式 Markdown 尚未更新，重新打开时仍须优先读取草稿。
        const hasDraft = reloaded._draftContent !== undefined;
        for (const item of new Set([node, reloaded])) {
            if (!item) continue;
            if ((!item._private || previousPath) && typeof item.content === 'string' && item.content.endsWith('.md')) item._mdPath = item.content;
            else if (previousPath) item._mdPath = previousPath;
            item._originalContent = text;
            item._sourceRevision = revision;
            item.title = edited && title ? title.value : name;
            item.content = item._rawMd = edited && textarea ? textarea.value : text;
            if (edited || hasDraft || item._private && !previousPath) item._draftContent = item._rawMd;
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
    }

    /** 保存完成后更新按钮文本与禁用状态 */
    function _updateSaveButton(button, result, current) {
        if (!current() || !button?.isConnected) return;
        button.disabled = false;
        button.textContent = result?.success ? (readerState.dirty ? '保存更改' : '已保存') : '保存失败';
        readerState.saveTimer = setTimeout(() => {
            if (current() && button.isConnected) button.textContent = '保存更改';
        }, 1500);
    }

    const source = createReaderSource({ state: readerState, getController, save, openExternal, renderMarkdown });
    return { save, openExternal, bind: source.bind };
}
