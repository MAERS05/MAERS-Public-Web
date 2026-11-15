/** 动作确认：按钮说明选择，取消和关闭都不会触发操作。 */
import { openFormModal } from '../encrypt/lock-dialog.module.js';
import { Utils } from '../../shared/utils.module.js';

export function confirmAction({ confirmText, cancelText = '先不操作', description = '', danger = false }) {
    return new Promise(resolve => {
        const dialog = openFormModal({
            icon: '', title: confirmText, sub: '',
            bodyHtml: description ? '<p class="mlock-message">' + Utils.escapeHtml(description) + '</p>' : '',
            confirmText, cancelText, focusDialog: true,
            onSubmit: () => { resolve(true); return true; },
            onCancel: () => resolve(false)
        });
        const box = dialog.el.querySelector('.mlock-box');
        box.classList.add('mlock-box--confirm');
        if (description) box.classList.add('has-description');
        if (danger) box.classList.add('is-danger');
        box.setAttribute('aria-label', confirmText);
    });
}

export function requestText({ title, value = '', confirmText = '保存修改', cancelText = '不改了' }) {
    return new Promise(resolve => openFormModal({
        icon: '', title, fields: [{ name: 'value', value, placeholder: title }],
        confirmText, cancelText,
        onSubmit: values => { resolve(values.value); return true; },
        onCancel: () => resolve(null)
    }));
}
