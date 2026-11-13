/** 通用管理弹窗：字段渲染、表单提交、图标预览与本地网页信息补全。 */
import { localFetch } from '../api-client.module.js';
import { Toast } from '../../shared/toast.module.js';
import { Utils } from '../../shared/utils.module.js';
import { disableAdminControl, isLocalOnlyUnavailable } from './local-only.module.js';
import { openFormModal } from '../encrypt/lock-dialog.module.js';

function fieldAttributes(field, value, type = field.type || 'text') {
    const placeholder = field.placeholder || (type === 'tags' ? 'tag1, tag2' : '');
    return `name="${Utils.escapeAttr(field.name)}" value="${Utils.escapeAttr(value)}"
        placeholder="${Utils.escapeAttr(placeholder)}" ${field.required ? 'required' : ''}
        ${field.disabled ? 'disabled' : ''}`;
}

function renderControl(field, value) {
    const attributes = fieldAttributes(field, value);
    switch (field.type) {
        case 'textarea':
            return `<textarea ${attributes} class="form-control">${Utils.escapeHtml(value)}</textarea>`;
        case 'url':
            return `<div style="display:flex; gap:8px;">
                <input type="url" ${attributes} class="form-control" style="flex:1;">
                ${field.showFetch ? '<button type="button" class="btn-fetch-meta" title="Auto-fetch metadata">🪄</button>' : ''}
            </div>`;
        case 'image':
            return `<div style="display:flex; gap:8px; align-items:center;">
                <input type="text" ${attributes} class="form-control icon-input" style="flex:1;">
                <img src="${Utils.escapeAttr(value)}" class="icon-preview" style="display:${value ? 'block' : 'none'};">
            </div>`;
        case 'tags':
            return `<input type="text" ${fieldAttributes(field, Array.isArray(value) ? value.join(', ') : value)} class="form-control">`;
        default:
            return `<input type="${Utils.escapeAttr(field.type || 'text')}" ${attributes} class="form-control">`;
    }
}

function createModal({ title, isNew = false, fields = [], data = {} }) {
    const modal = document.createElement('div');
    modal.className = 'admin-modal';
    const controls = fields.map(field => `<div class="form-group">
        <label>${Utils.escapeHtml(field.label)}${field.required ? ' *' : ''}</label>
        ${renderControl(field, data[field.name] ?? '')}
    </div>`).join('');
    modal.innerHTML = `<div class="modal-content">
        <div class="modal-header"><h3>${Utils.escapeHtml(title)}</h3><button class="btn-close-modal">×</button></div>
        <form class="admin-modal-form">${controls}
            <div class="modal-actions"><button type="button" class="btn-cancel">Cancel</button>
                <button type="submit" class="btn-primary">${isNew ? 'Create' : 'Save'}</button></div>
        </form>
    </div>`;
    return modal;
}

function readForm(form, fields) {
    const values = Object.fromEntries(new FormData(form));
    for (const field of fields) {
        if (field.type !== 'tags') continue;
        values[field.name] = (values[field.name] || '').split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
    }
    return values;
}

function bindSubmit(modal, { fields = [], onSave, isNew = false }, close) {
    const form = modal.querySelector('form');
    const button = modal.querySelector('.btn-primary');
    let saving = false;
    form.onsubmit = async event => {
        event.preventDefault();
        if (saving) return;
        saving = true;
        button.textContent = 'Saving...';
        button.disabled = true;
        try {
            if (await onSave(readForm(form, fields), modal) !== false) close();
        } catch (error) {
            console.error('[MAERS.Admin] 表单保存失败:', error);
            Toast.error('Save failed: ' + error.message);
        } finally {
            saving = false;
            button.textContent = isNew ? 'Create' : 'Save';
            button.disabled = false;
        }
    };
}

function fillMetadata(meta, inputs, initial, canUpdateName) {
    const { nameInput, descInput, iconInput, iconPreview } = inputs;
    // 请求期间手动填写的字段保留用户的新值。
    if (meta.title && canUpdateName && nameInput?.value === initial.name) nameInput.value = meta.title;
    if (meta.description && descInput && !descInput.value) descInput.value = meta.description.substring(0, 200);
    const icon = meta.icon_url || meta.google_icon;
    if (!icon || !iconInput || iconInput.value !== initial.icon) return;
    iconInput.value = icon;
    if (iconPreview) {
        iconPreview.src = icon;
        iconPreview.style.display = 'block';
    }
}

function bindMetadataFetch(modal, data, iconInput, iconPreview) {
    const button = modal.querySelector('.btn-fetch-meta');
    if (!button) return;
    if (isLocalOnlyUnavailable()) {
        disableAdminControl(button, '网页信息抓取仅限电脑本地后台，可手动填写');
        return;
    }
    const urlInput = modal.querySelector('input[name="url"]');
    if (!urlInput) return;
    const inputs = { iconInput, iconPreview, nameInput: modal.querySelector('input[name="name"]'),
        descInput: modal.querySelector('textarea[name="content"]') || modal.querySelector('textarea[name="description"]') };
    let requestId = 0;
    const fetchMetadata = async () => {
        const url = urlInput.value.trim();
        if (url.length < 4) return;
        const id = ++requestId;
        const initial = { name: inputs.nameInput?.value, icon: iconInput?.value };
        const canUpdateName = !initial.name || initial.name === 'New Link' || initial.name === data.name;
        const current = () => id === requestId && modal.isConnected !== false && urlInput.value.trim() === url;
        button.classList.add('loading');
        try {
            const response = await localFetch('/api/space/fetch_meta', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const metadata = await response.json();
            if (!current()) return;
            fillMetadata(metadata, inputs, initial, canUpdateName);
            Toast.success('同步成功');
        } catch (error) {
            console.error('[MAERS.Admin] 网页信息抓取失败:', error);
            if (current()) Toast.error('同步失败');
        } finally {
            if (id === requestId) button.classList.remove('loading');
        }
    };
    button.onclick = fetchMetadata;
    urlInput.onblur = () => {
        if (!data.url || urlInput.value !== data.url) return fetchMetadata();
    };
}

function bindFieldHandlers(modal, data) {
    const input = modal.querySelector('.icon-input');
    const preview = modal.querySelector('.icon-preview');
    if (input && preview) input.oninput = () => {
        preview.src = input.value;
        preview.style.display = input.value ? 'block' : 'none';
    };
    bindMetadataFetch(modal, data, input, preview);
}

function open(config) {
    const modal = createModal(config);
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.btn-close-modal').onclick = close;
    modal.querySelector('.btn-cancel').onclick = close;
    bindFieldHandlers(modal, config.data || {});
    bindSubmit(modal, config, close);
}

/** 操作按钮返回调用方的选项值，关闭返回 null。 */
function choose({ title, message, primary, secondary, extraChoices = [] }) {
    return new Promise(resolve => {
        const modal = openFormModal({
            icon: '⚠️', title, focusDialog: true, closeButton: true,
            bodyHtml: `<p class="mlock-message">${Utils.escapeHtml(message)}</p>`,
            confirmText: primary.text, cancelText: '',
            alternate: { text: secondary.text, onClick: () => resolve(secondary.value) },
            onSubmit: () => { resolve(primary.value); return true; },
            onCancel: () => resolve(null)
        });
        modal.el.querySelector('.mlock-box').classList.add('mlock-box--settings', 'mlock-box--choices');
        for (const choice of extraChoices) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'mlock-btn-secondary';
            button.textContent = choice.text;
            button.onclick = () => { modal.close(); resolve(choice.value); };
            modal.el.querySelector('.mlock-footer').appendChild(button);
        }
    });
}

export const AdminModal = { open, choose };
