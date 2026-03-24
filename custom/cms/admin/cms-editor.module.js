/**
 * MAERS CMS Editor & Viewer Logic (cms-editor.module.js)
 * 依赖: Vditor, marked, DOMPurify (optional), MAERS.Utils.Search, MAERS.CMS.Core
 * @version 3.1.0 - ES6 Module + Internal Link Interception
 */

import { Utils } from '../../../shared/utils.module.js';

// Dependency injection
let Controller = null;

export function initEditor(controller) {
    Controller = controller;
}

let vditorInstance = null;
let currentEditingId = null;

// ─── 内部链接拦截（共用逻辑）───
function _interceptMdLinks(container, currentNode) {
    if (!container) return;
    // 每次重新绑定，先移除旧的（通过替换同名函数引用实现——直接重新 addEventListener 即可，capture 不会重复）
    container.dataset.linkIntercepted = "true";

    container.addEventListener('click', (e) => {
        // 1. 标准 <a> 标签
        const a = e.target.closest('a');
        let href = null;

        if (a) {
            href = a.getAttribute('href');
        } else {
            // 2. Vditor IR 模式中的 span.vditor-ir__link
            const linkSpan = e.target.closest('.vditor-ir__link');
            if (linkSpan) {
                href = linkSpan.textContent;
            }
        }

        if (!href || !href.endsWith('.md') || href.startsWith('http')) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const decoded = decodeURIComponent(href);
        const filename = decoded.split('/').pop().replace('.md', '');
        const allNodes = Controller?.AppState?.allNodes || [];
        const targetNode = allNodes.find(n =>
            n.type === 'note' &&
            (n.title === filename || (n.content && n.content.endsWith(decoded)))
        );

        if (targetNode) {
            // Admin 模式下提示保存
            if (window.IS_ADMIN && vditorInstance && currentNode) {
                const current = vditorInstance.getValue();
                const original = currentNode._originalContent ?? currentNode.content ?? '';
                if (current !== original) {
                    if (confirm('您有未保存的更改，跳转前是否需要保存？\n【确定】先保存再跳转\n【取消】直接丢弃更改跳转')) {
                        save().then(() => open(targetNode));
                        return;
                    }
                }
            }
            open(targetNode);
        } else {
            console.warn("[MAERS.CMS] Note not found for link:", decoded);
            if (window.MAERS?.Toast?.show) {
                window.MAERS.Toast.show('未找到链接的笔记: ' + filename, 'error');
            } else {
                alert('未找到链接的笔记: ' + filename);
            }
        }
    }, true); // capture phase — 在 Vditor 的默认行为之前拦截
}

// ─── 打开阅读器/编辑器 ───
export async function open(node) {
    const layer = document.getElementById('immersive-reader');
    if (!layer) return;

    // 在 layer 上做一次性链接拦截（覆盖 visitor reader 视图）
    _interceptMdLinks(layer, node);

    // Lazy Load Content if it's a file path
    if (node.content && typeof node.content === 'string' && node.content.endsWith('.md')) {
        try {
            layer.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;color:var(--text-main);font-size:1.5rem;">⏳ Loading Content...</div>';
            layer.classList.add('active');
            document.body.style.overflow = 'hidden';

            const path = 'data/' + node.content;
            const res = await fetch(path + '?t=' + Date.now());
            if (res.ok) {
                node._originalContent = await res.text();
                node.content = node._originalContent;
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

// ─── 关闭 ───
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

// ─── 保存笔记 (Admin) ───
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

// ─── Internal Render Helpers ───

function _renderAdminEditor(layer, node) {
    const isLight = document.documentElement.classList.contains('light-mode');
    const themeMode = isLight ? 'classic' : 'dark';
    const contentTheme = isLight ? 'light' : 'dark';

    layer.className = 'immersive-layer active admin-editor-mode';

    layer.onclick = null;
    layer.addEventListener('click', (e) => e.stopPropagation());

    layer.innerHTML = `
      <div class="editor-header">
          <div class="editor-left">
              <button class="outline-btn" title="Toggle Outline">☰</button>
              <input type="text" value="${_escapeHtml(node.title)}" id="edit-title-input">
          </div>
          <div class="editor-right">
              <button class="editor-save-btn">💾 Save</button>
              <button class="close-btn">✕</button>
          </div>
      </div>
      <div class="reader-body-layout">
          <div class="reader-outline-panel collapsed" id="reader-outline"></div>
          <div id="vditor-container" style="flex:1; min-width:0;"></div>
      </div>
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
        cdn: 'plugins/vditor-assets',
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
        },
        input: () => {
            clearTimeout(window._adminOutlineTimer);
            window._adminOutlineTimer = setTimeout(() => {
                _generateOutline();
            }, 800);
        },
        after: () => {
            const vditorEl = document.getElementById('vditor-container');
            _interceptMdLinks(vditorEl, node);
            _bindOutlineToggle();
            _generateOutline();
        }
    });
}

function _renderVisitorReader(layer, node) {
    layer.className = 'immersive-layer';
    layer.style = '';
    const safeTitle = _escapeHtml(node.title);

    layer.innerHTML = `
  <div class="reader-toolbar">
      <div class="reader-meta">
          <button class="outline-btn" title="Toggle Outline">☰</button>
          <span class="reader-title">${safeTitle}</span>
      </div>
      <div class="reader-actions">
          <button class="close-btn">✕</button>
      </div>
  </div>
  <div class="reader-body-layout">
      <div class="reader-outline-panel collapsed" id="reader-outline"></div>
      <div class="reader-scroll-area">
          <div class="markdown-body paper-sheet" id="reader-content"><div style="display:flex;justify-content:center;align-items:center;height:100%;color:var(--text-main);font-size:1.5rem;">加载中...</div></div>
      </div>
  </div>
  `;

    const contentDiv = layer.querySelector('#reader-content');
    const isLight = document.documentElement.classList.contains('light-mode');
    const contentTheme = isLight ? 'light' : 'dark';

    if (window.Vditor) {
        Vditor.preview(contentDiv, node.content || "> No content.", {
            mode: isLight ? 'light' : 'dark',
            theme: {
                current: contentTheme,
                path: 'plugins/vditor-assets/css/content-theme'
            },
            cdn: 'plugins/vditor-assets',
            after: () => {
                // Fix: 在 Vditor 异步渲染完成后再绑定链接拦截器
                _interceptMdLinks(contentDiv, node);
                _bindOutlineToggle();
                _generateOutline();
            }
        });
    } else {
        let htmlContent = "> No content.";
        if (window.marked) {
            htmlContent = marked.parse(node.content || "> No content.", { breaks: true });
        }
        if (window.DOMPurify) {
            htmlContent = DOMPurify.sanitize(htmlContent, { USE_PROFILES: { html: true } });
        }
        contentDiv.innerHTML = htmlContent;
        // 非 Vditor 渲染时同步绑定
        _interceptMdLinks(contentDiv, node);
        _bindOutlineToggle();
        _generateOutline();
    }

    // 绑定关闭按钮事件
    const closeBtn = layer.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', close);
    }
}

function _bindOutlineToggle() {
    const btn = document.querySelector('.outline-btn');
    const outline = document.getElementById('reader-outline');
    if (btn && outline) {
        // Prevent duplicate bindings if called multiple times
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            outline.classList.toggle('collapsed');
        });
    }
}

function _generateOutline() {
    const outlinePanel = document.getElementById('reader-outline');
    let contentContainer = document.getElementById('reader-content');

    // In admin mode, the container and scroll area are different due to vditor
    if (window.IS_ADMIN && vditorInstance) {
        // Vditor IR mode uses .vditor-ir content editable wrapper
        contentContainer = document.querySelector('.vditor-ir');
    }

    if (!outlinePanel || !contentContainer) return;

    // Get all headings
    const headings = contentContainer.querySelectorAll('h1, h2, h3, h4, h5, h6');
    outlinePanel.innerHTML = '<div class="outline-title">目录大纲</div>';

    if (headings.length === 0) {
        outlinePanel.innerHTML += '<div class="outline-item" style="color:var(--text-sub);cursor:default;">暂无目录</div>';
        return;
    }

    headings.forEach((heading, index) => {
        const level = parseInt(heading.tagName.substring(1));
        const item = document.createElement('div');
        item.className = `outline-item outline-level-${level}`;
        // Preserve clean text (Vditor might have internal span tags)
        let rawText = heading.innerText || heading.textContent || 'Untitled';
        // Remove Vditor IR mode heading markers (e.g., "### ") and zero-width spaces
        rawText = rawText.replace(/^#+\s*/g, '').replace(/\u200B/g, '').trim();
        item.textContent = rawText;
        item.title = rawText;

        // Ensure ID
        if (!heading.id) heading.id = 'maers-heading-' + index;

        item.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        outlinePanel.appendChild(item);
    });


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
