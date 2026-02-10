/**
 * Admin Modal - Generic Modal Component
 * 通用管理模态框组件
 * @version 1.0.0
 */

import { Toast } from '../shared/toast.module.js';

export const AdminModal = {
    /**
     * Open a modal dialog
     * @param {Object} config - Modal configuration
     * @param {string} config.title - Modal title
     * @param {boolean} config.isNew - Whether this is a new item
     * @param {Object} config.data - Initial data object
     * @param {Array} config.fields - Field definitions
     * @param {Function} config.onSave - Save callback (async)
     */
    open(config) {
        const { title, isNew = false, data = {}, fields = [], onSave } = config;

        const modal = document.createElement('div');
        modal.className = 'admin-modal';

        // Build form fields HTML
        const fieldsHtml = fields.map(field => this._renderField(field, data)).join('');

        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>${title}</h3>
                    <button class="btn-close-modal">×</button>
                </div>
                <form class="admin-modal-form">
                    ${fieldsHtml}
                    <div class="modal-actions">
                        <button type="button" class="btn-cancel">Cancel</button>
                        <button type="submit" class="btn-primary">${isNew ? 'Create' : 'Save'}</button>
                    </div>
                </form>
            </div>
        `;

        document.body.appendChild(modal);

        // Event bindings
        const form = modal.querySelector('form');
        const closeBtn = modal.querySelector('.btn-close-modal');
        const cancelBtn = modal.querySelector('.btn-cancel');
        const submitBtn = modal.querySelector('.btn-primary');

        const close = () => modal.remove();

        closeBtn.onclick = close;
        cancelBtn.onclick = close;

        // Setup special field handlers
        this._setupFieldHandlers(modal, fields, data);

        // Form submission
        form.onsubmit = async (e) => {
            e.preventDefault();

            submitBtn.textContent = 'Saving...';
            submitBtn.disabled = true;

            try {
                const formData = new FormData(form);
                const result = {};

                // Process form data
                for (const [key, value] of formData.entries()) {
                    result[key] = value;
                }

                // Process special fields
                fields.forEach(field => {
                    if (field.type === 'tags') {
                        const val = result[field.name];
                        result[field.name] = val ? val.split(/[,，]/).map(t => t.trim()).filter(t => t) : [];
                    }
                });

                const success = await onSave(result, modal);

                if (success !== false) {
                    close();
                }
            } catch (err) {
                console.error('Modal save error:', err);
                if (Toast) {
                    Toast.error('Save failed: ' + err.message);
                }
            } finally {
                submitBtn.textContent = isNew ? 'Create' : 'Save';
                submitBtn.disabled = false;
            }
        };
    },

    _renderField(field, data) {
        const { name, label, type = 'text', required = false, placeholder = '', disabled = false, showFetch = false } = field;
        const value = data[name] || '';

        switch (type) {
            case 'textarea':
                return `
                    <div class="form-group">
                        <label>${label}${required ? ' *' : ''}</label>
                        <textarea name="${name}" class="form-control" ${required ? 'required' : ''} 
                            placeholder="${placeholder}" ${disabled ? 'disabled' : ''}>${this._escapeHtml(value)}</textarea>
                    </div>
                `;

            case 'url':
                return `
                    <div class="form-group">
                        <label>${label}${required ? ' *' : ''}</label>
                        <div style="display:flex; gap:8px;">
                            <input type="url" name="${name}" class="form-control" value="${this._escapeAttr(value)}" 
                                ${required ? 'required' : ''} placeholder="${placeholder}" style="flex:1;">
                            ${showFetch ? '<button type="button" class="btn-fetch-meta" title="Auto-fetch metadata">🪄</button>' : ''}
                        </div>
                    </div>
                `;

            case 'image':
                return `
                    <div class="form-group">
                        <label>${label}</label>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <input type="text" name="${name}" class="form-control icon-input" value="${this._escapeAttr(value)}" 
                                placeholder="${placeholder}" style="flex:1;">
                            <img src="${value || ''}" class="icon-preview" style="display:${value ? 'block' : 'none'};">
                        </div>
                    </div>
                `;

            case 'tags':
                const tagsValue = Array.isArray(value) ? value.join(', ') : value;
                return `
                    <div class="form-group">
                        <label>${label}</label>
                        <input type="text" name="${name}" class="form-control" value="${this._escapeAttr(tagsValue)}" 
                            placeholder="${placeholder || 'tag1, tag2'}">
                    </div>
                `;

            default:
                return `
                    <div class="form-group">
                        <label>${label}${required ? ' *' : ''}</label>
                        <input type="${type}" name="${name}" class="form-control" value="${this._escapeAttr(value)}" 
                            ${required ? 'required' : ''} placeholder="${placeholder}" ${disabled ? 'disabled' : ''}>
                    </div>
                `;
        }
    },

    _setupFieldHandlers(modal, fields, data) {
        // Icon preview handler
        const iconInput = modal.querySelector('.icon-input');
        const iconPreview = modal.querySelector('.icon-preview');
        if (iconInput && iconPreview) {
            iconInput.oninput = () => {
                iconPreview.src = iconInput.value;
                iconPreview.style.display = iconInput.value ? 'block' : 'none';
            };
        }

        // Fetch metadata handler
        const fetchBtn = modal.querySelector('.btn-fetch-meta');
        if (fetchBtn) {
            const urlInput = modal.querySelector('input[name="url"]');
            const nameInput = modal.querySelector('input[name="name"]');
            const descInput = modal.querySelector('textarea[name="content"]') || modal.querySelector('textarea[name="description"]');

            const fetchMeta = async () => {
                const url = urlInput.value.trim();
                if (!url || url.length < 4) return;

                const canUpdateName = !nameInput || !nameInput.value || nameInput.value === 'New Link' || nameInput.value === data.name;

                fetchBtn.classList.add('loading');

                try {
                    const res = await fetch('/api/space/fetch_meta', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url })
                    });

                    if (res.ok) {
                        const meta = await res.json();

                        if (meta.title && canUpdateName && nameInput) {
                            nameInput.value = meta.title;
                        }

                        if (meta.description && descInput && !descInput.value) {
                            descInput.value = meta.description.substring(0, 200);
                        }

                        if ((meta.icon_url || meta.google_icon) && iconInput) {
                            const icon = meta.icon_url || meta.google_icon;
                            iconInput.value = icon;
                            if (iconPreview) {
                                iconPreview.src = icon;
                                iconPreview.style.display = 'block';
                            }
                        }

                        if (Toast) Toast.success("Info fetched!");
                    }
                } catch (e) {
                    console.error("Meta fetch error", e);
                } finally {
                    fetchBtn.classList.remove('loading');
                }
            };

            fetchBtn.onclick = fetchMeta;
            if (urlInput) {
                urlInput.onblur = () => {
                    if (!data.url || urlInput.value !== data.url) fetchMeta();
                };
            }
        }
    },

    _escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, function (m) {
            switch (m) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                case "'": return '&#039;';
            }
        });
    },

    _escapeAttr(str) {
        if (!str) return '';
        return String(str).replace(/"/g, '&quot;');
    }
};
