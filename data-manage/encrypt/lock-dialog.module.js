/** 加密交互弹窗：表单、恢复码确认与共享样式。 */
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
        icon = '🔐', title = '', sub = '', fields = [], bodyHtml = '',
        confirmText = '确定', cancelText = '取消', onSubmit, onCancel, link, alternate, focusDialog = false, closeButton = false
    } = opts;
    const iconName = ['🔐', '🔒'].includes(icon) ? 'encryption' : icon;

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
                ${closeButton ? '<button type="button" class="mlock-btn-close" data-act="close" aria-label="关闭弹窗">×</button>' : ''}
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
        if (e.key === 'Enter' && !['BUTTON', 'SELECT'].includes(e.target?.tagName)) { e.preventDefault(); submit(); }
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
            icon: '🧩',
            title: '请保存恢复码',
            sub: '忘记主密码时，用它重置。只显示这一次',
            bodyHtml: `
                <div class="mlock-code">${escapeHtml(code)}</div>
                <button class="mlock-btn-secondary" data-act="copy" type="button">📋 复制</button>
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
                e.target.textContent = '✅ 已复制';
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
    const style = document.createElement('style');
    style.id    = 'mlock-styles';
    style.textContent = `
        .mlock-overlay {
            position: fixed; inset: 0; z-index: 999999;
            background: rgba(0, 0, 0, 0.72);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            display: flex; align-items: center; justify-content: center;
            animation: mlockFadeIn 0.2s ease;
        }
        @keyframes mlockFadeIn {
            from { opacity: 0; } to { opacity: 1; }
        }

        .mlock-box {
            width: min(380px, 92vw);
            background: rgba(22, 22, 28, 0.96);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border-radius: 18px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            box-shadow: none;
            overflow: hidden;
            animation: mlockSlide 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .mlock-box:focus { outline: none; }
        @keyframes mlockSlide {
            from { transform: translateY(14px) scale(0.97); opacity: 0; }
            to   { transform: translateY(0) scale(1); opacity: 1; }
        }
        html.light-mode .mlock-box {
            background: rgba(255, 255, 255, 0.97);
            border-color: rgba(0, 0, 0, 0.16);
            box-shadow: none;
        }

        .mlock-header {
            display: flex; align-items: center; gap: 14px;
            padding: 22px 22px 16px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.15);
        }
        html.light-mode .mlock-header {
            border-bottom-color: rgba(0, 0, 0, 0.16);
        }
        .mlock-icon-wrap {
            font-size: 28px;
            flex-shrink: 0;
            width: 44px; height: 44px;
            border-radius: 12px;
            background: rgba(100, 150, 255, 0.12);
            border: 1px solid rgba(100, 150, 255, 0.2);
            display: flex; align-items: center; justify-content: center;
        }
        .mlock-svg-icon { display: inline-block; flex-shrink: 0; vertical-align: middle; object-fit: contain; pointer-events: none; }
        .mlock-svg-icon--secret-key, .mlock-svg-icon--password-group { filter: invert(1); }
        html.light-mode .mlock-svg-icon--secret-key, html.light-mode .mlock-svg-icon--password-group { filter: none; }
        .mlock-svg-icon--encryption, .mlock-svg-icon--decryption { filter: invert(1) hue-rotate(180deg) brightness(1.5); }
        html.light-mode .mlock-svg-icon--encryption, html.light-mode .mlock-svg-icon--decryption { filter: none; }
        .mlock-title-group { display: flex; flex-direction: column; gap: 3px; }
        .mlock-box--choices .mlock-title-group { flex: 1; min-width: 0; }
        .mlock-btn-close { flex-shrink: 0; width: 44px; height: 44px; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--text-main, #eee); font-size: 24px; cursor: pointer; }
        html.light-mode .mlock-btn-close { color: #222; }
        .mlock-btn-close:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
        .mlock-message { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-main, #eee); font-size: 13px; line-height: 1.6; }
        html.light-mode .mlock-message { color: #222; }
        .mlock-box--choices .mlock-footer { flex-direction: column; align-items: stretch; }
        .mlock-box--choices .mlock-footer button { min-height: 44px; }
        .mlock-title { font-size: 15px; font-weight: 700; color: var(--text-main, #eee); }
        html.light-mode .mlock-title { color: #111; }
        .mlock-sub { font-size: 12px; color: var(--text-sub, #888); line-height: 1.4; }

        .mlock-body {
            padding: 20px 22px 6px;
            display: flex; flex-direction: column; gap: 8px;
        }
        .mlock-input {
            width: 100%; box-sizing: border-box;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 10px;
            color: var(--text-main, #eee);
            font-size: 14px; padding: 11px 14px;
            outline: none; font-family: inherit;
            transition: border-color 0.2s, background 0.2s;
        }
        .mlock-input:focus {
            border-color: rgba(100, 150, 255, 0.6);
            background: rgba(255, 255, 255, 0.08);
        }
        html.light-mode .mlock-input {
            background: #f4f4f6;
            border-color: rgba(0, 0, 0, 0.15);
            color: #111;
        }
        html.light-mode .mlock-input:focus {
            background: #fff;
            border-color: rgba(59, 130, 246, 0.6);
        }
        .mlock-hint {
            font-size: 12px; color: #ff5252;
            display: none;
        }

        .mlock-footer {
            padding: 16px 22px 20px;
            display: flex; gap: 10px; justify-content: flex-end;
        }
        .mlock-btn-secondary {
            padding: 9px 18px; border-radius: 9px; font-size: 13px; cursor: pointer;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(255, 255, 255, 0.05); color: var(--text-main, #eee);
            transition: all 0.2s;
        }
        .mlock-btn-secondary:hover {
            background: rgba(255, 255, 255, 0.1);
        }
        html.light-mode .mlock-btn-secondary {
            background: #f0f0f4; border-color: rgba(0, 0, 0, 0.12); color: #222;
        }
        html.light-mode .mlock-btn-secondary:hover { background: #e4e4ea; }

        .mlock-btn-primary {
            padding: 9px 22px; border-radius: 9px; font-size: 13px; font-weight: 600;
            cursor: pointer; border: none;
            background: linear-gradient(135deg, #3b82f6, #2563eb);
            color: #fff;
            box-shadow: none;
            transition: all 0.2s;
        }
        .mlock-btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: none;
        }

        .mlock-crypto-controls {
            position: fixed; left: 20px; bottom: 20px; z-index: 9998;
            display: inline-flex; align-items: stretch; height: 42px; box-sizing: border-box;
            border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 999px;
            background: rgba(30, 30, 40, 0.85); box-shadow: none;
        }
        html.light-mode .mlock-crypto-controls:not(.mlock-crypto-controls--actions) { background: rgba(255, 255, 255, 0.92); border-color: rgba(0, 0, 0, 0.16); }
        /* 批量取消加密沿用思维导图的蓝灰、冷白与天蓝强调色。 */
        .mlock-crypto-controls--actions {
            --mlock-action-accent: #38bdf8;
            background: rgba(30, 41, 59, 0.92); border-color: rgba(148, 163, 184, 0.28);
            color: #f1f5f9; overflow: hidden; box-shadow: none;
            transition: border-color 0.18s ease, box-shadow 0.18s ease;
        }
        html.light-mode .mlock-crypto-controls--actions {
            --mlock-action-accent: #0284c7;
            background: #f8fafc; border-color: #cbd5e1; color: #1e293b;
            box-shadow: none;
        }
        .mlock-crypto-controls--actions:focus-within { border-color: var(--mlock-action-accent); }
        .mlock-settings-btn {
            position: relative; display: flex; align-items: center; justify-content: center;
            flex: 0 0 40px; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%;
            background: rgba(30, 30, 40, 0.85); cursor: pointer;
        }
        html.light-mode .mlock-settings-btn { background: rgba(255, 255, 255, 0.96); }
        .mlock-settings-btn--disabled {
            opacity: 0.35 !important;
            filter: grayscale(1) !important;
            cursor: not-allowed !important;
        }
        .mlock-settings-btn--disabled:hover {
            transform: none !important;
            box-shadow:none !important;
        }
        .mlock-unlock-panel {
            flex: 0 0 auto; width: 0; overflow: hidden; opacity: 0; pointer-events: none;
            transition: width 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease;
        }
        .mlock-unlock-panel.is-expanded { opacity: 1; pointer-events: auto; }
        .mlock-unlock-all {
            display: block; width: max-content; height: 40px; padding: 0 12px;
            white-space: nowrap; font-size: 13px; font-weight: 600; color: inherit;
            border: 0; background: transparent; cursor: pointer;
            transition: background 0.18s ease, color 0.18s ease;
        }
        .mlock-unlock-all:disabled { opacity: 0.55; cursor: progress; }
        .mlock-unlock-toggle {
            display: flex; align-items: center; justify-content: center;
            flex: 0 0 28px; width: 28px; padding: 0; border: 0; border-radius: 999px;
            background: transparent; color: var(--mlock-action-accent); cursor: pointer;
            touch-action: manipulation; transition: background 0.18s ease, color 0.18s ease;
        }
        .mlock-unlock-toggle::before {
            content: ''; width: 8.5px; height: 8.5px; box-sizing: border-box;
            border-top: 2px solid currentColor; border-right: 2px solid currentColor;
            transform: translateX(-1.5px) rotate(45deg);
        }
        .mlock-unlock-toggle[aria-expanded="true"]::before { transform: translateX(1.5px) rotate(225deg); }
        .mlock-unlock-all:focus-visible, .mlock-unlock-toggle:focus-visible {
            outline: 2px solid var(--mlock-action-accent); outline-offset: -3px;
        }

        .mlock-btn-primary:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
        .mlock-link {
            font-size: 12px; color: #60a5fa; text-decoration: none; align-self: flex-start;
        }
        .mlock-link:hover { text-decoration: underline; }
        .mlock-code {
            font-family: ui-monospace, Consolas, monospace;
            font-size: 15px; letter-spacing: 1px; word-break: break-all;
            padding: 12px 14px; border-radius: 10px; user-select: all;
            background: rgba(100, 150, 255, 0.1);
            border: 1px dashed rgba(100, 150, 255, 0.45);
            color: var(--text-main, #eee);
        }
        html.light-mode .mlock-code { color: #111; }
        .mlock-check {
            display: flex; align-items: center; gap: 8px;
            font-size: 13px; color: var(--text-sub, #aaa); cursor: pointer;
        }
        .mlock-status {
            font-size: 12.5px; line-height: 1.75; color: var(--text-sub, #aaa);
            padding: 10px 12px; border-radius: 10px;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.15);
        }
        html.light-mode .mlock-status { background: #f6f6f8; border-color: rgba(0, 0, 0, 0.16); color: #444; }
        .mlock-status b { color: var(--text-main, #eee); font-weight: 600; }
        html.light-mode .mlock-status b { color: #111; }
        .mlock-ok { color: #34d399; }
        .mlock-bad { color: #f87171; }
        .mlock-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .mlock-actions.mlock-crypto-actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .mlock-crypto-actions .mlock-btn-secondary { min-width: 0; min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
        .mlock-actions.mlock-group-actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .mlock-group-actions .mlock-btn-secondary { min-width: 0; min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
        .mlock-status.mlock-password-group { padding: 0 12px; }
        .mlock-password-group > summary { position: relative; display: block; min-height: 44px; padding: 10px 22px 10px 0; box-sizing: border-box; cursor: pointer; overflow-wrap: anywhere; list-style: none; }
        .mlock-password-group > summary::-webkit-details-marker { display: none; }
        .mlock-password-group > summary::after { content: ''; position: absolute; right: 2px; top: 50%; border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 6px solid var(--text-sub, #aaa); transform: translateY(-50%); }
        .mlock-password-group[open] > summary::after { transform: translateY(-50%) rotate(90deg); }
        .mlock-status.mlock-password-group > .mlock-actions { margin-top: 0; padding-bottom: 10px; }
        .mlock-unlocked-groups { display: flex; flex-wrap: wrap; gap: 8px; }
        .mlock-unlocked-groups:empty { display: none; }
        .mlock-unlocked-group {
            min-height: 36px; max-width: 100%; padding: 6px 12px;
            border-radius: 9px; border: 1px solid rgba(107, 156, 255, 0.55);
            box-shadow: none;
            background: transparent; color: var(--text-main, #eee);
            font: inherit; font-size: 13px; overflow-wrap: anywhere; cursor: pointer;
        }
        html.light-mode .mlock-unlocked-group {
            border-color: rgba(37, 99, 235, 0.48);
            box-shadow: none;
        }
        .mlock-unlocked-group:hover { background: rgba(79, 135, 249, 0.09); }
        .mlock-unlocked-group:focus-visible { outline: 2px solid #659aff; outline-offset: 2px; }
        .mlock-unlocked-group.mlock-group-choice[aria-pressed="false"] {
            border-color: rgba(255, 255, 255, 0.15); box-shadow:none;
            background: rgba(255, 255, 255, 0.05);
        }
        html.light-mode .mlock-group-choice[aria-pressed="false"] {
            border-color: rgba(0, 0, 0, 0.12); background: #f4f4f6;
        }
        .mlock-group-choice:disabled { cursor: default; }
        .mlock-btn-secondary.mlock-lock-all { display: grid; place-items: center; min-width: 36px; padding: 6px; }
        .mlock-password-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-bottom: 10px; }
        .mlock-password-row [role="alert"] { grid-column: 1 / -1; font-size: 12px; }
        .mlock-password-row input[aria-invalid="true"] { border-color: #f87171; }
        .mlock-group-items { display: flex; flex-direction: column; gap: 12px; max-height: 45dvh; overflow-y: auto; }
        .mlock-group-items .mlock-check { align-items: flex-start; overflow-wrap: anywhere; }
        .mlock-status + .mlock-status { margin-top: 10px; }
        .mlock-status .mlock-actions { margin-top: 10px; }
        .mlock-actions .mlock-btn-secondary { padding: 9px 10px; text-align: center; }
        .mlock-btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
        .mlock-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--text-sub, #888); }
        .mlock-box--settings { display: flex; flex-direction: column; max-height: calc(100dvh - 32px); }
        .mlock-box--settings .mlock-body { overflow-y: auto; min-height: 0; }
        .mlock-box--settings .mlock-header, .mlock-box--settings .mlock-footer { flex-shrink: 0; }
        .mlock-progress {
            visibility: visible;
            position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
            z-index: 1000000; width: max-content; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 10px 16px; border-radius: 14px;
            background: rgba(22, 22, 28, 0.94); color: #eee; font-size: 13px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            box-shadow: none;
            display: flex; flex-direction: column; gap: 8px;
        }
        .mlock-progress-heading { display: flex; align-items: center; gap: 8px; }
        html.light-mode .mlock-progress { background: #f6f6f8; color: #222; border-color: rgba(0, 0, 0, 0.12); }
        html.light-mode .mlock-progress-bar { background: rgba(0, 0, 0, 0.12); }
        .mlock-progress-bar { height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.12); overflow: hidden; }
        .mlock-progress-bar.is-pending i { animation: mlock-progress-pending 1.2s ease-in-out infinite alternate; }
        @keyframes mlock-progress-pending { from { transform: translateX(0); } to { transform: translateX(185%); } }
        .mlock-progress-bar i {
            display: block; height: 100%; width: 0;
            background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width 0.3s;
        }
    `;
    document.head.appendChild(style);
}
