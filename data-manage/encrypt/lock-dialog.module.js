/** 加密交互弹窗：表单、恢复码确认与共享样式。 */
import { icon as appIcon } from '../../shared/icons.module.js';
/** 固定的本地图标；名称只允许来自此表，不接受任意 HTML 或地址。 */
const CRYPTO_ICONS = {
    'secret-key': new URL('../../ui/secret-key.svg', import.meta.url).href,
    'password-group': new URL('../../ui/password-group.svg', import.meta.url).href,
    encryption: new URL('../../ui/encryption.svg', import.meta.url).href,
    decryption: new URL('../../ui/decryption.svg', import.meta.url).href
};

export function cryptoIconHtml(name, size = 18) {
    if (!Object.hasOwn(CRYPTO_ICONS, name)) return '';
    const src = CRYPTO_ICONS[name];
    return `<img class="mlock-svg-icon mlock-svg-icon--${name}" src="${escapeHtml(src)}" width="${Number(size) || 18}" height="${Number(size) || 18}" alt="" aria-hidden="true">`;
}

/** HTML 转义 */
export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

let activeProgress = 0;
const warnPendingProgress = event => {
    event.preventDefault();
    event.returnValue = '';
};

/** 长操作进度：未知数量时保持处理动画，已知数量时显示真实完成数。 */
export function openProgress(label, icon = 'encryption') {
    injectLockStyles();
    const el = document.createElement('div');
    el.className = 'mlock-progress';
    el.innerHTML = `<div class="mlock-progress-heading">${cryptoIconHtml(icon, 20)}<span class="mlock-progress-text" role="status"></span></div><div class="mlock-progress-bar" role="progressbar"><i></i></div>`;
    document.body.appendChild(el);
    const text = el.querySelector('.mlock-progress-text');
    const track = el.querySelector('.mlock-progress-bar');
    const bar = track.firstElementChild;
    if (activeProgress++ === 0) window.addEventListener?.('beforeunload', warnPendingProgress);
    let closed = false;
    const update = (done = 0, total = 0, message = label, unit = '') => {
        const known = total > 0;
        const value = Math.max(0, Math.min(done, total));
        const amount = unit === '%' ? `${value}%` : `${value}/${total}`;
        text.textContent = known ? `${message} ${amount}` : `${message}，正在处理…`;
        track.setAttribute('aria-label', message);
        track.classList.toggle('is-pending', !known);
        if (known) {
            track.setAttribute('aria-valuemin', '0');
            track.setAttribute('aria-valuemax', String(total));
            track.setAttribute('aria-valuenow', String(value));
        } else {
            ['aria-valuemin', 'aria-valuemax', 'aria-valuenow'].forEach(name => track.removeAttribute(name));
        }
        bar.style.width = known ? `${Math.round(value / total * 100)}%` : '35%';
    };
    update();
    return { update, close: () => {
        if (closed) return;
        closed = true;
        if (--activeProgress === 0) window.removeEventListener?.('beforeunload', warnPendingProgress);
        el.remove();
    } };
}

/**
 * 通用表单弹窗
 * @param {Object} opts
 * @param {string} opts.icon / opts.title / opts.sub - 头部
 * @param {Array<{name,type,placeholder,autocomplete,value}>} [opts.fields] - 输入框
 * @param {string} [opts.bodyHtml] - 输入框上方的附加 HTML（调用方负责转义）
 * @param {string} [opts.confirmText] / [opts.cancelText]
 * @param {boolean} [opts.focusDialog] - 打开时聚焦弹窗容器，等待用户选择操作
 * @param {boolean} [opts.closeButton] - 头部关闭按钮，等同取消
 * @param {{text:string,onClick:Function}} [opts.alternate] - 另一项操作，先关闭弹窗再执行
 * @param {(values:Object)=>Promise<true|string>|true|string} opts.onSubmit - 返回 true 关闭，返回字符串则作为错误提示
 * @param {Function} [opts.onCancel]
 * @param {{text:string,onClick:Function}} [opts.link] - 底部文字链接，点击后关闭弹窗再执行
 * @returns {{close:Function, el:HTMLElement}}
 */
export function openFormModal(opts) {
    injectLockStyles();
    const {
        icon = '', title = '', sub = '', fields = [], bodyHtml = '',
        confirmText = '继续', cancelText = '先不改了', onSubmit, onCancel, link, alternate, focusDialog = false, closeButton = false
    } = opts;
    const iconName = icon;

    const previousFocus = document.activeElement;
    const modal = document.createElement('div');
    modal.className = 'mlock-overlay';
    modal.innerHTML = `
        <div class="mlock-box" role="dialog" aria-modal="true" tabindex="-1">
            <div class="mlock-header">
                <div class="mlock-icon-wrap">${cryptoIconHtml(iconName, 28) || escapeHtml(icon)}</div>
                <div class="mlock-title-group">
                    <span class="mlock-title">${escapeHtml(title)}</span>
                    ${sub ? `<span class="mlock-sub">${escapeHtml(sub)}</span>` : ''}
                </div>
                ${closeButton ? '<button type="button" class="mlock-btn-close app-icon-button" data-act="close" aria-label="关闭弹窗" title="关闭弹窗">' + appIcon("close", 18) + '</button>' : ''}
            </div>
            <div class="mlock-body">
                ${bodyHtml}
                ${fields.map(f => `
                    <input class="mlock-input" data-name="${escapeHtml(f.name)}"
                        type="${escapeHtml(f.type || 'text')}"
                        placeholder="${escapeHtml(f.placeholder || '')}"
                        autocomplete="${escapeHtml(f.autocomplete || 'off')}"
                        value="${escapeHtml(f.value || '')}">`).join('')}
                <div class="mlock-hint"></div>
                ${link ? `<a href="javascript:void(0)" class="mlock-link">${escapeHtml(link.text)}</a>` : ''}
            </div>
            <div class="mlock-footer">
                ${cancelText ? `<button class="mlock-btn-secondary" data-act="cancel">${escapeHtml(cancelText)}</button>` : ''}
                ${alternate ? `<button class="mlock-btn-secondary" data-act="alternate">${escapeHtml(alternate.text)}</button>` : ''}
                <button class="mlock-btn-primary" data-act="ok">${escapeHtml(confirmText)}</button>
            </div>
        </div>
    `;
    modal.querySelector('.mlock-box').setAttribute('aria-label', title || confirmText);
    document.body.appendChild(modal);

    const inputs = [...modal.querySelectorAll('.mlock-input')];
    const hint = modal.querySelector('.mlock-hint');
    const okBtn = modal.querySelector('[data-act="ok"]');
    const cancelBtn = modal.querySelector('[data-act="cancel"]');
    let busy = false;
    let closed = false;

    const close = () => {
        if (closed) return;
        closed = true;
        modal.querySelectorAll('input').forEach(input => { input.value = ''; });
        modal.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        document.removeEventListener('keydown', onKey, true);
    };
    const showError = (msg) => {
        hint.textContent = msg;
        hint.style.display = 'block';
    };
    const submit = async () => {
        if (busy || closed || okBtn.disabled) return;
        const values = {};
        inputs.forEach(i => { values[i.dataset.name] = i.value; });
        busy = true;
        const label = okBtn.textContent;
        okBtn.disabled = true;
        okBtn.textContent = '处理中...';
        hint.style.display = 'none';
        let res;
        try {
            res = onSubmit ? await onSubmit(values) : true;
        } catch (e) {
            res = e.message || String(e);
        }
        busy = false;
        if (res === true) { close(); return; }
        okBtn.disabled = false;
        okBtn.textContent = label;
        if (typeof res === 'string') showError(res);
    };
    const cancel = () => {
        if (busy || closed || (!cancelText && !onCancel)) return;
        close();
        if (onCancel) onCancel();
    };
    // 捕获阶段监听，避免被页面其他快捷键拦截；多层弹窗时只有最上层响应
    const onKey = (e) => {
        const overlays = [...document.querySelectorAll('.mlock-overlay')].filter(el => el.style.display !== 'none');
        if (overlays[overlays.length - 1] !== modal) return;
        if (CSS.supports('selector(select:open)') && modal.querySelector('select:open')) return;
        if (e.key === 'Tab') {
            const focusable = [...modal.querySelectorAll('button, input, select, textarea, a[href]')]
                .filter(item => !item.disabled && item.getClientRects().length);
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (e.shiftKey && (document.activeElement === first || document.activeElement === modal.querySelector('.mlock-box'))) {
                e.preventDefault(); last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
        if (e.key === 'Enter' && !['BUTTON', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName)) { e.preventDefault(); submit(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    };

    okBtn.onclick = submit;
    if (cancelBtn) cancelBtn.onclick = cancel;
    if (closeButton) modal.querySelector('[data-act="close"]').onclick = cancel;
    const alternateBtn = modal.querySelector('[data-act="alternate"]');
    if (alternateBtn) alternateBtn.onclick = () => {
        if (busy || closed) return;
        close();
        alternate.onClick();
    };
    document.addEventListener('keydown', onKey, true);
    const linkEl = modal.querySelector('.mlock-link');
    if (linkEl) {
        linkEl.onclick = () => {
            if (busy) return;
            close();
            link.onClick();
        };
    }

    requestAnimationFrame(() => {
        if (!closed) (focusDialog ? modal.querySelector('.mlock-box') : inputs[0] || okBtn).focus();
    });
    return { close, el: modal, showError };
}

/**
 * 展示恢复码：必须勾选「已妥善保存」才能关闭
 * @param {string} code
 * @returns {Promise<void>}
 */
export function showRecoveryCodeModal(code) {
    return new Promise((resolve) => {
        const { el } = openFormModal({
            icon: '',
            title: '请保存恢复码',
            sub: '忘记主密码时，用它重置。只显示这一次',
            bodyHtml: `
                <div class="mlock-code">${escapeHtml(code)}</div>
                <button class="mlock-btn-secondary" data-act="copy" type="button"> 复制</button>
                <label class="mlock-check"><input type="checkbox" data-act="ack"> 我已妥善保存（如密码管理器）</label>
            `,
            confirmText: '完成',
            cancelText: '',
            onSubmit: () => {
                if (!el.querySelector('[data-act="ack"]').checked) return '请先确认已保存恢复码';
                resolve();
                return true;
            }
        });
        const okBtn = el.querySelector('[data-act="ok"]');
        const ack = el.querySelector('[data-act="ack"]');
        okBtn.disabled = true;
        ack.onchange = () => { okBtn.disabled = !ack.checked; };
        el.querySelector('[data-act="copy"]').onclick = async (e) => {
            try {
                await navigator.clipboard.writeText(code);
                e.target.textContent = ' 已复制';
            } catch {
                e.target.textContent = '复制失败，请手动抄写';
            }
        };
    });
}

// ══════════════════════════════════════════════
// 3. 样式
// ══════════════════════════════════════════════

export function injectLockStyles() {
    if (document.getElementById('mlock-styles')) return;
    const sheet = document.createElement('link');
    sheet.id = 'mlock-styles';
    sheet.rel = 'stylesheet';
    sheet.href = new URL('../../static-style/admin-modal.css', import.meta.url).href;
    document.head.append(sheet);
}
