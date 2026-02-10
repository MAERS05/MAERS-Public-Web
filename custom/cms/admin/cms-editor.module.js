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
export function open(node) {
    const layer = document.getElementById('immersive-reader');
    if (!layer) return;

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
        if (result.success) { btn.textContent = '✅ Saved'; btn.style.background = '#2ed573'; }
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
        height: '100%',
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
            multiple: false,
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

    let htmlContent = "> No content.";
    if (window.marked) {
        htmlContent = marked.parse(node.content || "> No content.");
    }

    if (window.DOMPurify) {
        htmlContent = DOMPurify.sanitize(htmlContent, { USE_PROFILES: { html: true } });
    }

    layer.innerHTML = `
  <div class="reader-toolbar">
      <div class="reader-meta"><span class="reader-title">${safeTitle}</span></div>
      <div class="reader-actions"><button class="close-btn">✕</button></div>
  </div>
  <div class="reader-scroll-area">
      <div class="markdown-body paper-sheet" id="reader-content">${htmlContent}</div>
  </div>
  `;

    // 绑定关闭按钮事件
    const closeBtn = layer.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', close);
    }
}

async function _handleImageUpload(files) {
    const file = files[0];
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const suffix = String(Math.floor(Math.random() * 99) + 1).padStart(2, '0');
    const newFileName = `${YYYY}${MM}${DD}_${HH}${mm}${ss}_${suffix}.avif`;

    vditorInstance.insertValue(`![Uploading...](${newFileName})`);

    if (Controller?.uploadImage) {
        const res = await Controller.uploadImage(file);
        if (res.success) {
            const content = vditorInstance.getValue();
            vditorInstance.setValue(content.replace(`![Uploading...](${newFileName})`, `![](${res.path})`));
            return null;
        }
    }
    return "Upload Failed";
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
