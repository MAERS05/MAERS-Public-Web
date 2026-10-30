/**
 * MAERS CMS 纯粹阅读器与跨端源码协同模块 (cms-reader.module.js)
 * 职责：
 * 1. 前后台统一高保真沉浸式阅读器（基于 Vditor.preview 渲染内核，缺失时安全降级为纯文本）
 * 2. Markdown 扩展语法预处理（站内 [[双链]]、图片相对路径归一化）与 GitHub Alerts 高亮提示卡渲染
 * 3. 当前文章与异步渲染生命周期、窗口焦点恢复热刷新
 * 4. 通过显式状态和回调接入 cms-reader-editor 的编辑、保存与上传能力
 * @version 4.0.0 - Unified Pure Reader Architecture
 */

import { sha256Hex } from '../../../data-manage/encrypt/crypto.module.js';
import { localFetch } from '../../../data-manage/api-client.module.js';
import { cmsMediaReferences } from '../../../data-manage/encrypt/private-media.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { disposeReaderDiagrams, exitReaderDiagramFullscreen } from './cms-diagrams.module.js';
import { preprocessMarkdown, enhanceGitHubAlerts, enhanceReaderElements, bindInteractiveTasks, bindReaderFragmentNavigation } from './cms-reader-content.module.js';
import { bindOutlineToggle, generateOutline, resetReaderOutline, createReaderFileWatcher } from './cms-reader-lifecycle.module.js';
export { preprocessMarkdown, enhanceGitHubAlerts, enhanceReaderElements };

import { Utils } from '../../../shared/utils.module.js';
import { createReaderEditor } from './cms-reader-editor.module.js';
import { mountBacklinks, backlinkUrl, resolveBacklink } from './cms-backlinks.module.js';

// 依赖注入控制器引用
let Controller = null;

export function initReader(controller) {
    Controller = controller;
}


const readerState = { editingId: null, node: null, generation: 0,
    dirty: false, previewTimer: null, saveTimer: null, scrollSync: null };
const editor = createReaderEditor({ state: readerState, getController: () => Controller,
    renderMarkdown: _renderMarkdownBody, refreshBacklinks: () => _backlinksView?.refresh() });
export const save = editor.save;
export const openExternal = editor.openExternal;

// 阅读视图与请求生命周期
let _backlinksView = null;
let _openAbort = null;
const _renderJobs = new WeakMap();
const _renderVersions = new WeakMap();

/**
 * 判断当前是否处于本地服务环境（localhost / 127.0.0.1）
 * @returns {boolean}
 */
function _isLocalEnv() {
    if (typeof window === 'undefined' || !window.location) return false;
    const host = window.location.hostname || '';
    return ['localhost', '127.0.0.1', '[::1]', ''].includes(host);
}

/**
 * 统一消息提示辅助函数
 * @param {string} msg - 提示文本
 * @param {'success'|'error'|'info'} [type='info'] - 提示类型
 */
const _notify = (message, type = 'info') => (Toast[type] || Toast.info).call(Toast, message);

const _fileWatcher = createReaderFileWatcher({
    getNode: () => readerState.node,
    isDirty: () => readerState.dirty,
    isLocal: _isLocalEnv,
    onChange(node, text) {
        const textarea = document.getElementById('cms-source-textarea');
        if (textarea) textarea.value = text;
        const content = document.getElementById('reader-content');
        const scroll = document.querySelector('#immersive-reader .reader-scroll-area');
        if (content) _renderMarkdownBody(content, text, node, scroll?.scrollTop || 0);
    }
});

// ─── 内部链接拦截（前后台共用逻辑）───
function _interceptMdLinks(container) {
    if (!container || container.dataset.linkIntercepted === 'true') return;
    container.dataset.linkIntercepted = 'true';
    container.addEventListener('click', async event => {
        if (event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        const link = event.target.closest('a[href]');
        const href = link?.getAttribute('href') || '';
        if (!/\.md(?:[?#]|$)/i.test(href) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const module = Controller?.CONFIG?.CURRENT_MODULE || 'notes';
        const catalogue = (Controller?.AppState?.allNodes || [])
            .filter(node => node.type === 'note' && !node._enc).map(node => ({ module, node }));
        const origin = window.location.origin === 'null' ? 'https://maers.invalid' : window.location.origin;
        const target = resolveBacklink(href, { module, node: readerState.node || {} }, catalogue, origin);
        if (!target) { _notify('未找到唯一的目标笔记，请检查链接路径', 'error'); return; }
        if (window.IS_ADMIN && readerState.dirty && confirm('有未保存的源码更改，是否先保存再跳转？')) {
            const result = await save();
            if (!result?.success) return;
        }
        await open(target.node);
        const content = document.getElementById('reader-content');
        await _renderJobs.get(content);
        if (readerState.node?.id !== target.node.id || !href.includes('#')) return;
        try {
            const id = decodeURIComponent(href.slice(href.indexOf('#') + 1));
            Array.from(content?.querySelectorAll('[id]') || []).find(el => el.id === id)?.scrollIntoView({ block: 'start' });
        } catch { /* 无效编码不影响已经完成的文档跳转。 */ }
    }, true);
}

// ─── 打开沉浸式阅读器（前后台统一入口）───
export async function open(node) {
    const layer = document.getElementById('immersive-reader');
    if (!layer || !node) return;
    const generation = ++readerState.generation;
    _openAbort?.abort();
    const abort = new AbortController();
    _openAbort = abort;
    clearTimeout(readerState.previewTimer); clearTimeout(readerState.saveTimer);
    _backlinksView?.destroy(); _backlinksView = null;
    readerState.scrollSync?.destroy(); readerState.scrollSync = null;
    disposeReaderDiagrams(layer);
    _fileWatcher.stop(); resetReaderOutline();
    readerState.dirty = false;
    readerState.node = node;
    readerState.editingId = window.IS_ADMIN ? node.id : null;
    const current = () => generation === readerState.generation && !abort.signal.aborted;
    if (typeof node.content === 'string' && node.content.endsWith('.md')) node._mdPath = node.content;
    _interceptMdLinks(layer);
    if (node._draftContent !== undefined) {
        node.content = node._rawMd = node._draftContent;
    } else if (node._mdPath) {
        layer.innerHTML = '<div class="reader-loading">⏳ 正在加载文档...</div>';
        layer.classList.add('active'); document.body.style.overflow = 'hidden';
        try {
            const path = 'data/' + node._mdPath.split('/').map(encodeURIComponent).join('/');
            const response = await (node._private ? localFetch : fetch)(path, { cache: 'no-cache', signal: abort.signal });
            const text = response.ok ? await response.text() : null;
            if (!current()) return;
            if (text !== null) {
                const revision = await sha256Hex(text);
                if (!current()) return;
                node.content = node._rawMd = node._originalContent = text;
                node._sourceRevision = revision;
                node._loadFailed = false;
            } else if (node._pendingRelay) {
                node.content = node._rawMd = node._originalContent = '';
                node._loadFailed = false;
            }
            else throw new Error(`文档读取失败 (${response.status})`);
        } catch (error) {
            if (!current() || error.name === 'AbortError') return;
            console.error('[MAERS.CMS] 读取文档失败:', error);
            node._loadFailed = true;
        }
    } else node._rawMd = typeof node.content === 'string' ? node.content : '';
    if (!current()) return;
    _openAbort = null;
    _renderUnifiedReader(layer, node);
    layer.classList.add('active'); document.body.style.overflow = 'hidden';
    if (window.IS_ADMIN && _isLocalEnv() && node._mdPath) _fileWatcher.start();
}

// ─── 关闭阅读器 ───
export function close() {
    readerState.generation++;
    _openAbort?.abort(); _openAbort = null;
    clearTimeout(readerState.saveTimer);
    resetReaderOutline();
    disposeReaderDiagrams(document.getElementById('immersive-reader'));
    readerState.node = null; readerState.editingId = null;
    _backlinksView?.destroy();
    _backlinksView = null;
    readerState.scrollSync?.destroy();
    readerState.scrollSync = null;
    exitReaderDiagramFullscreen();
    _fileWatcher.stop();
    readerState.dirty = false;
    clearTimeout(readerState.previewTimer);

    const layer = document.getElementById('immersive-reader');
    if (layer) {
        layer.classList.remove('active', 'admin-editor-mode');
    }


    document.body.style.overflow = '';
}

// ─── 阅读器骨架 ───
function _renderUnifiedReader(layer, node) {
    const isAdmin = Boolean(window.IS_ADMIN);
    const isLocal = _isLocalEnv();
    const safeTitle = _escapeHtml(node.title || 'Untitled');
    const rawMd = node._loadFailed ? '> [!WARNING]\n> 文档加载失败，请重新打开；正文保存已禁用。' : (node._rawMd ?? node.content ?? '');

    layer.className = isAdmin
        ? 'immersive-layer active admin-editor-mode'
        : 'immersive-layer active';
    layer.style = '';
    layer.onclick = null;
    layer.addEventListener('click', (e) => e.stopPropagation());

    const metaLeftHtml = isAdmin
        ? `<button class="outline-btn" title="切换目录大纲">☰</button>
           <input type="text" value="${safeTitle}" id="edit-title-input" class="reader-title-input" placeholder="输入笔记标题..." title="修改标题后按回车或点击保存生效">`
        : `<button class="outline-btn" title="切换目录大纲">☰</button>
           <span class="reader-title">${safeTitle}</span>`;

    const actionsRightHtml = isAdmin
        ? `${isLocal && node._mdPath ? `<button type="button" class="reader-admin-btn" id="btn-open-external" title="${node._private ? '在浏览器内编辑私密正文' : '使用系统默认软件（如 Typora / Obsidian）直接打开原文件'}"><span class="btn-label">编辑</span></button>` : ''}
           <button type="button" class="reader-admin-btn" id="btn-toggle-source" title="展开/收起 Markdown 源码抽屉"><span class="btn-label">源码</span></button>
           <button type="button" class="close-btn" title="关闭阅读器">✕</button>`
        : `<button type="button" class="close-btn" title="关闭阅读器">✕</button>`;

    const sourceDrawerHtml = isAdmin
        ? `<aside class="cms-source-drawer collapsed" id="cms-source-drawer">
               <div class="cms-source-drawer-header">
                   <span class="cms-source-drawer-title">Markdown 源码</span>
                   <div class="cms-source-drawer-actions">
                       <button type="button" class="reader-admin-btn" id="btn-upload-md-img" title="上传图片并在光标处插入相对路径">上传图片</button>
                       <input type="file" id="cms-md-img-input" accept="image/*" multiple style="display:none">
                       <button type="button" class="reader-admin-btn primary editor-save-btn" id="btn-save-source">保存更改</button>
                       <button type="button" class="cms-source-close-btn" id="btn-close-source" title="收起源码抽屉">✕</button>
                   </div>
               </div>
               <textarea id="cms-source-textarea" class="cms-source-textarea" spellcheck="false" placeholder="在此输入或粘贴 Markdown 源码..."></textarea>
           </aside>`
        : '';

    layer.innerHTML = `
        <div class="reader-toolbar">
            <div class="reader-meta">
                ${metaLeftHtml}
            </div>
            <div class="reader-actions">
                ${actionsRightHtml}
            </div>
        </div>
        <div class="reader-body-layout">
            <div class="reader-outline-panel collapsed" id="reader-outline"></div>
            <div class="reader-scroll-area">
                <div class="markdown-body paper-sheet" id="reader-content">
                    <div style="display:flex;justify-content:center;align-items:center;height:100%;color:var(--text-main);font-size:1.5rem;">加载中...</div>
                </div>
                <section class="cms-backlinks paper-sheet" id="reader-backlinks" aria-label="反向引用"></section>
            </div>
            ${sourceDrawerHtml}
        </div>
    `;

    const contentDiv = layer.querySelector('#reader-content');
    const closeBtn = layer.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            close();
        });
    }

    if (isAdmin) {
        editor.bind(layer, node, rawMd);
    }

    _renderMarkdownBody(contentDiv, rawMd, node, null);
}

/**
 * 渲染 Markdown 正文至指定容器，并支持保持滚动条位置
 * @param {HTMLElement} contentDiv - #reader-content 容器
 * @param {string} rawMd - 原始 Markdown 源码
 * @param {Object} node - 当前节点对象
 * @param {number|null} preserveScrollTop - 若不为 null，渲染后恢复该滚动高度
 */
function _renderMarkdownBody(contentDiv, rawMd, node, preserveScrollTop = null) {
    if (!contentDiv) return Promise.resolve();
    const generation = readerState.generation;
    const version = (_renderVersions.get(contentDiv) || 0) + 1;
    _renderVersions.set(contentDiv, version);
    const current = () => contentDiv.isConnected && generation === readerState.generation && version === _renderVersions.get(contentDiv);
    const job = Promise.resolve(_renderJobs.get(contentDiv)).catch(() => {}).then(async () => {
        if (!current()) return;
        exitReaderDiagramFullscreen();
        const previousDiagrams = Array.from(contentDiv.querySelectorAll('.cms-diagram-card'));

        const layer = document.getElementById('immersive-reader');
        const scrollArea = layer?.querySelector('.reader-scroll-area');
        if (preserveScrollTop !== null && contentDiv.offsetHeight > 0) {
            // 锁定最小高度，防止异步渲染期间容器高度塌陷导致滚动条归零
            contentDiv.style.minHeight = `${contentDiv.offsetHeight}px`;
        }

        try {
            const isLight = document.documentElement.classList.contains('light-mode');
            const contentTheme = isLight ? 'light' : 'dark';
            let previewMd = rawMd || '> 暂无内容';
            if (node._private && window.IS_ADMIN && _isLocalEnv()) {
                for (const { source, key } of cmsMediaReferences(previewMd)) {
                    const url = '/api/private/media/' + key.split('/').map(encodeURIComponent).join('/');
                    previewMd = previewMd.split(source).join(url);
                }
            }
            const processedMd = preprocessMarkdown(previewMd);

            const finalizeRender = () => {
                if (!current()) return;
                if (preserveScrollTop === null) contentDiv.style.minHeight = '';
                enhanceGitHubAlerts(contentDiv);
                enhanceReaderElements(contentDiv);
                _interceptMdLinks(contentDiv, node);
                bindOutlineToggle();
                generateOutline();
                bindReaderFragmentNavigation(contentDiv);
                bindInteractiveTasks(contentDiv, node, Controller?.CONFIG?.CURRENT_MODULE || 'notes');
                readerState.scrollSync?.refresh(contentDiv, rawMd);
                const backlinkHost = layer?.querySelector('#reader-backlinks');
                if (!_backlinksView && backlinkHost && readerState.node?.id === node.id) {
                    _backlinksView = mountBacklinks({
                        host: backlinkHost,
                        module: Controller?.CONFIG?.CURRENT_MODULE || 'notes',
                        getTarget: () => readerState.node,
                        getNotes: () => Controller?.AppState?.allNodes || [],
                        preprocess: preprocessMarkdown,
                        navigate: async item => {
                            if (readerState.dirty && confirm('有未保存的源码更改，是否先保存再跳转？\n确定：保存后跳转；取消：丢弃更改并跳转。')) {
                                const result = await save();
                                if (!result?.success) return;
                            }
                            if (item.module === Controller?.CONFIG?.CURRENT_MODULE) {
                                const target = Controller.AppState.allNodes.find(n => n.id === item.node.id && n.type === 'note');
                                if (target) open(target);
                                else _notify('该引用来源已被删除或锁定，请刷新列表', 'info');
                            } else {
                                window.location.href = backlinkUrl(item, window.IS_ADMIN === true);
                            }
                        }
                    });
                }

                if (preserveScrollTop !== null && scrollArea) {
                    scrollArea.scrollTop = preserveScrollTop;
                    if (typeof requestAnimationFrame === 'function') {
                        requestAnimationFrame(() => {
                            if (!current()) return;
                            scrollArea.scrollTop = preserveScrollTop;
                            contentDiv.style.minHeight = '';
                        });
                    } else {
                        contentDiv.style.minHeight = '';
                    }
                }
            };

            if (typeof window !== 'undefined' && window.Vditor && typeof window.Vditor.preview === 'function') {
                await window.Vditor.preview(contentDiv, processedMd, {
                    mode: isLight ? 'light' : 'dark',
                    markdown: { mark: true, toc: true },
                    theme: {
                        current: contentTheme,
                        path: 'plugins/vditor-assets/dist/css/content-theme'
                    },
                    hljs: {
                        enable: true,
                        lineNumber: false,
                        style: isLight ? 'github' : 'dracula'
                    },
                    cdn: 'plugins/vditor-assets',
                    after: finalizeRender
                });
            } else {
                // 降级不插入未经净化的 Markdown HTML，缺少渲染依赖时保留可读源码。
                const source = document.createElement('pre');
                source.textContent = rawMd || '暂无内容';
                contentDiv.replaceChildren(source);
                finalizeRender();
            }

        } finally {
            previousDiagrams.forEach(diagram => {
                if (!contentDiv.isConnected || !contentDiv.contains(diagram)) disposeReaderDiagrams(diagram);
            });
        }
    }).catch(error => {
        if (current()) { contentDiv.style.minHeight = ''; _notify('文档渲染失败，请重试', 'error'); }
        console.error('[MAERS.CMS] 预览失败:', error);
    });
    _renderJobs.set(contentDiv, job);
    return job;
}

function _escapeHtml(input) {
    if (Utils?.escapeHtml) return Utils.escapeHtml(input);
    return String(input ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export const Reader = {
    open,
    close,
    save,
    openExternal,
    preprocessMarkdown,
    enhanceGitHubAlerts,
    enhanceReaderElements,
    get currentEditingId() { return readerState.editingId; }
};
