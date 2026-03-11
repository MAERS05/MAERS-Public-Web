/**
 * MAERS CMS Editor & Viewer Logic (cms-editor.module.js)
 * 依赖: Vditor, marked, DOMPurify (optional), MAERS.Utils.Search, MAERS.CMS.Core
 * @version 3.0.0 - ES6 Module
 */

import { Utils } from '../../../shared/utils.module.js';

// Dependency injection
let Controller = null;

export function initEditor(controller) {
    Controller = controller;
}

let vditorInstance = null;
let currentEditingId = null;

// 打开阅读器/编辑器
export async function open(node) {
    const layer = document.getElementById('immersive-reader');
    if (!layer) return;

    // Lazy Load Content if it's a file path
    if (node.content && typeof node.content === 'string' && node.content.endsWith('.md')) {

        try {
            // Show loading state
            layer.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;color:var(--text-main);font-size:1.5rem;">⏳ Loading Content...</div>';
            layer.classList.add('active');
            document.body.style.overflow = 'hidden';

            // Allow relative path loading from data root
            const path = 'data/' + node.content;
            const res = await fetch(path + '?t=' + Date.now()); // Cache bust for safety or use versioning
            if (res.ok) {
                node.content = await res.text();
            } else {
                console.error("Failed to load md:", path);
                node.content = "> ⚠️ Error: Content file not found at " + path;
            }
        } catch (e) {
            console.error("Fetch error:", e);
            node.content = "> ⚠️ Network Error loading content.";
        }
    }

    // Admin 模式记录 ID
    if (window.IS_ADMIN) currentEditingId = node.id;

    if (window.IS_ADMIN) {
        _renderAdminEditor(layer, node);
    } else {
        _renderVisitorReader(layer, node);
    }

    layer.classList.add('active');
    document.body.style.overflow = 'hidden';
}

// 关闭
export function close() {
    const layer = document.getElementById('immersive-reader');
    if (layer) {
        layer.classList.remove('active');
    }

    if (vditorInstance) {
        vditorInstance.destroy();
        vditorInstance = null;
    }

    document.body.style.overflow = '';
}

// 保存笔记 (Admin)
export async function save() {
    if (!window.IS_ADMIN) return;

    const btn = document.querySelector('.editor-save-btn');
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

    const t = document.getElementById('edit-title-input').value;
    const c = vditorInstance ? vditorInstance.getValue() : '';

    let result = { success: false };
    if (Controller?.callApi) {
        result = await Controller.callApi('update', { id: currentEditingId, data: { title: t, content: c } });
    } else {
        console.error("[MAERS.CMS.Editor] Controller not found.");
    }

    if (btn) {
        if (result.success) {
            if (Controller?.refreshView) {
                Controller.refreshView(false, true);
            }
            btn.textContent = '✅ Saved'; btn.style.background = '#2ed573';
        }
        else { btn.textContent = '❌ Error'; btn.style.background = '#ff4757'; }
        setTimeout(() => {
            btn.textContent = '💾 Save'; btn.disabled = false;
            btn.style.background = '#2ed573';
        }, 1500);
    }
}

// --- Internal Render Helpers ---

function _renderAdminEditor(layer, node) {
    const isLight = document.documentElement.classList.contains('light-mode');
    const themeMode = isLight ? 'classic' : 'dark';
    const contentTheme = isLight ? 'light' : 'dark';

    // 样式初始化 - 移除 main-card 以免触发全局缩放
    layer.className = 'immersive-layer active admin-editor-mode';

    // 阻止编辑界面内的点击向上冒泡，防止触发“缩放视图”下的“点击外部复原”逻辑
    // 使用 addEventListener 以确保稳健性
    layer.onclick = null; // 清除可能存在的旧 handler
    layer.addEventListener('click', (e) => e.stopPropagation());

    // 构建 HTML
    layer.innerHTML = `
      <div class="editor-header">
          <div class="editor-left">
              <input type="text" value="${_escapeHtml(node.title)}" id="edit-title-input">
          </div>
          <div class="editor-right">
              <button class="editor-save-btn">💾 Save</button>
              <button class="close-btn">✕</button>
          </div>
      </div>
      <div id="vditor-container" style="flex:1; width:100%;"></div>
  `;

    // 绑定事件监听器
    const saveBtn = layer.querySelector('.editor-save-btn');
    const closeBtn = layer.querySelector('.close-btn');

    if (saveBtn) {
        saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            save();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            close();
        });
    }

    // 初始化 Vditor
    if (vditorInstance) {
        vditorInstance.destroy();
        vditorInstance = null;
    }

    vditorInstance = new Vditor('vditor-container', {
        height: 'calc(100vh - 61px)',
        mode: 'ir',
        value: node.content || '',
        theme: themeMode,
        preview: {
            theme: {
                current: contentTheme,
                path: 'plugins/vditor-assets/css/content-theme'
            }
        },
        cache: { enable: false },
        toolbar: [
            "emoji", "headings", "bold", "italic", "strike", "link", "|",
            "list", "ordered-list", "check", "outdent", "indent", "|",
            "quote", "line", "code", "inline-code", "insert-before", "insert-after", "|",
            "upload", "table", "|",
            "undo", "redo", "|",
            "edit-mode"
        ],
        upload: {
            accept: 'image/*',
            multiple: true,
            handler: async (files) => {
                return _handleImageUpload(files);
            }
        }
    });
}

function _renderVisitorReader(layer, node) {
    layer.className = 'immersive-layer';
    layer.style = '';
    const safeTitle = _escapeHtml(node.title);

    layer.innerHTML = `
  <div class="reader-toolbar">
      <div class="reader-meta"><span class="reader-title">${safeTitle}</span></div>
      <div class="reader-actions"><button class="close-btn">✕</button></div>
  </div>
  <div class="reader-scroll-area">
      <div class="vditor-reset paper-sheet" id="reader-content" style="padding: 24px;"></div>
  </div>
  `;

    // 绑定关闭按钮事件
    const closeBtn = layer.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', close);
    }

    // 调用 Vditor 的 preview 功能来进行带主题和样式的渲染
    const readerContent = layer.querySelector('#reader-content');
    if (window.Vditor) {
        const isLight = document.documentElement.classList.contains('light-mode');
        const contentTheme = isLight ? 'light' : 'dark';

        // 显示一个短暂的加载提示（可选）
        readerContent.innerHTML = '<div style="text-align:center; color:gray;">⏳ Rendering...</div>';

        Vditor.preview(readerContent, node.content || "> No content.", {
            mode: contentTheme,
            theme: {
                current: contentTheme,
                path: 'plugins/vditor-assets/css/content-theme'
            }
            // 不设置 cdn：让 Vditor 自动使用与自身相同的 CDN（unpkg）去加载 lute.min.js 等动态 JS 资源
            // 本地的 plugins/vditor-assets 只用于 CSS 主题（通过 theme.path 已单独配置）
        });
    } else if (window.marked) {
        // 作为 Vditor 未加载成功时的 Fallback
        let htmlContent = marked.parse(node.content || "> No content.", { breaks: true });
        if (window.DOMPurify) {
            htmlContent = DOMPurify.sanitize(htmlContent, { USE_PROFILES: { html: true } });
        }
        readerContent.innerHTML = htmlContent;
    }
}

async function _handleImageUpload(files) {
    if (!Controller?.uploadImage) return 'Upload Failed';

    for (const file of files) {
        const now = new Date();
        const YYYY = now.getFullYear();
        const MM = String(now.getMonth() + 1).padStart(2, '0');
        const DD = String(now.getDate()).padStart(2, '0');
        const HH = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const suffix = String(Math.floor(Math.random() * 99) + 1).padStart(2, '0');
        const placeholder = `placeholder_${YYYY}${MM}${DD}_${HH}${mm}${ss}_${suffix}`;

        vditorInstance.insertValue(`![Uploading...](${placeholder})\n`);

        const res = await Controller.uploadImage(file);
        if (res.success) {
            const content = vditorInstance.getValue();
            vditorInstance.setValue(content.replace(`![Uploading...](${placeholder})`, `![](${res.path})`));
        } else {
            const content = vditorInstance.getValue();
            vditorInstance.setValue(content.replace(`![Uploading...](${placeholder})`, `> ⚠️ Upload failed: ${file.name}`));
        }
    }
    return null;
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

export const Editor = {
    open,
    close,
    save,
    get vditorInstance() { return vditorInstance; },
    get currentEditingId() { return currentEditingId; }
};
