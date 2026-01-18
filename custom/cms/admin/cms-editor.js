/**
 * MAERS CMS Editor & Viewer Logic (cms-editor.js)
 * 依赖: Vditor, marked, DOMPurify (optional), MAERS.Utils.Search, MAERS.CMS.Core
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.CMS = MAERS.CMS || {};

    const CmsEditor = {
        vditorInstance: null,
        currentEditingId: null,

        // 打开阅读器/编辑器
        open(node) {
            const layer = document.getElementById('immersive-reader');
            if (!layer) return;

            // Admin 模式记录 ID
            if (window.IS_ADMIN) this.currentEditingId = node.id;

            if (window.IS_ADMIN) {
                this._renderAdminEditor(layer, node);
            } else {
                this._renderVisitorReader(layer, node);
            }

            layer.classList.add('active');
            document.body.style.overflow = 'hidden';

            // Visitor 模式下的自动定位逻辑
            if (!window.IS_ADMIN && MAERS.Utils && MAERS.Utils.Search && MAERS.CMS.Controller) {
                const AppState = MAERS.CMS.Controller.AppState;
                setTimeout(() => {
                    const fullPath = MAERS.Utils.Search.findPathNodes(AppState.root, node.id);
                    if (fullPath) {
                        const parentPathNodes = fullPath.slice(0, -1);
                        AppState.pathStack = ['root', ...parentPathNodes];
                        const targetChildren = parentPathNodes.length > 0 ?
                            parentPathNodes[parentPathNodes.length - 1].children : AppState.root;

                        if (MAERS.CMS.View) {
                            MAERS.CMS.View.clearTagFilter();
                            MAERS.CMS.View.renderBreadcrumb();
                            MAERS.CMS.View.renderGrid(targetChildren);
                            MAERS.CMS.View.refreshDrawerList();
                        }
                    }
                }, 400);
            }
        },

        // 关闭
        close() {
            const layer = document.getElementById('immersive-reader');
            if (layer) layer.classList.remove('active');
            document.body.style.overflow = '';
        },

        // 保存笔记 (Admin)
        async save() {
            if (!window.IS_ADMIN) return;

            const btn = document.querySelector('.editor-save-btn');
            if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

            const t = document.getElementById('edit-title-input').value;
            const c = this.vditorInstance ? this.vditorInstance.getValue() : '';

            let result = { success: false };
            if (MAERS.CMS.Controller && MAERS.CMS.Controller.callApi) {
                result = await MAERS.CMS.Controller.callApi('update', { id: this.currentEditingId, data: { title: t, content: c } });
            } else {
                console.error("[MAERS.CMS.Editor] MAERS.CMS.Controller not found.");
            }

            if (btn) {
                if (result.success) { btn.textContent = '✅ Saved'; btn.style.background = '#2ed573'; }
                else { btn.textContent = '❌ Error'; btn.style.background = '#ff4757'; }
                setTimeout(() => {
                    btn.textContent = '💾 Save'; btn.disabled = false;
                    btn.style.background = '#2ed573';
                }, 1500);
            }
        },

        // --- Internal Render Helpers ---

        _renderAdminEditor(layer, node) {
            const isLight = document.documentElement.classList.contains('light-mode');
            const themeMode = isLight ? 'classic' : 'dark';
            const contentTheme = isLight ? 'light' : 'dark';

            // 样式初始化
            layer.className = 'immersive-layer active main-card admin-editor-mode';
            layer.style.padding = '0';
            layer.style.setProperty('height', '100vh', 'important');
            layer.style.setProperty('min-height', '100vh', 'important');
            layer.style.borderRadius = '0';

            // 构建 HTML
            layer.innerHTML = `
                <div class="editor-header">
                    <div class="editor-left">
                        <span style="font-size:1.5rem;">📝</span>
                        <input type="text" value="${this._escapeHtml(node.title)}" id="edit-title-input">
                    </div>
                    <div class="editor-right">
                        <button class="editor-save-btn" onclick="MAERS.CMS.Editor.save()">💾 Save</button>
                        <button class="close-btn" onclick="MAERS.CMS.Editor.close()">✕</button>
                    </div>
                </div>
                <div id="vditor-container" style="flex:1; width:100%;"></div>
            `;

            // 初始化 Vditor
            if (this.vditorInstance) {
                this.vditorInstance.destroy();
                this.vditorInstance = null;
            }

            this.vditorInstance = new Vditor('vditor-container', {
                height: '100%',
                mode: 'ir',
                value: node.content || '',
                theme: themeMode,
                preview: {
                    theme: {
                        current: contentTheme,
                        path: 'assets/vditor-assets/css/content-theme'
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
                        return this._handleImageUpload(files);
                    }
                }
            });
        },

        _renderVisitorReader(layer, node) {
            layer.className = 'immersive-layer';
            layer.style = '';
            const safeTitle = this._escapeHtml(node.title);

            let htmlContent = "> No content.";
            if (window.marked) {
                htmlContent = marked.parse(node.content || "> No content.");
            }

            if (window.DOMPurify) {
                htmlContent = DOMPurify.sanitize(htmlContent, { USE_PROFILES: { html: true } });
            }

            layer.innerHTML = `
            <div class="reader-toolbar">
                <div class="reader-meta"><span class="reader-icon">📝</span><span class="reader-title">${safeTitle}</span></div>
                <div class="reader-actions"><button class="close-btn" onclick="MAERS.CMS.Editor.close()">✕</button></div>
            </div>
            <div class="reader-scroll-area">
                <div class="markdown-body paper-sheet" id="reader-content">${htmlContent}</div>
                <div class="reader-footer">— End of Note —</div>
            </div>
            `;
        },

        async _handleImageUpload(files) {
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

            this.vditorInstance.insertValue(`![Uploading...](${newFileName})`);

            if (MAERS.CMS.Controller && MAERS.CMS.Controller.uploadImage) {
                // Use Controller (which handles the fetch)
                // Wait, Controller.uploadImage expects a file. 
                // It returns {success: true, path: ...}
                const res = await MAERS.CMS.Controller.uploadImage(file);
                if (res.success) {
                    const content = this.vditorInstance.getValue();
                    this.vditorInstance.setValue(content.replace(`![Uploading...](${newFileName})`, `![](${res.path})`));
                    return null;
                }
            }
            return "Upload Failed";
        },

        _escapeHtml(input) {
            if (MAERS.Utils) return MAERS.Utils.escapeHtml(input);
            return String(input ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
    };

    // Mount to namespace
    MAERS.CMS.Editor = CmsEditor;

    // Also expose openNote for fallback - using View as main entry usually, but keeping this for compatibility
    // if View calls Editor.open


})(typeof window !== 'undefined' ? window : this);
