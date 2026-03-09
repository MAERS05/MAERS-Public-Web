/**
 * MAERS Toast Notification System
 * Usage: import { Toast } from './toast.module.js'; Toast.success('Saved!')
 * @version 3.0.0 - ES6 Module
 */

export class ToastManager {
    constructor() {
        if (typeof document === 'undefined') return;

        this.container = document.createElement('div');
        this.container.classList.add('toast-container');

        if (document.body) {
            document.body.appendChild(this.container);
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                document.body.appendChild(this.container);
            });
        }
    }

    _show(message, type = 'info', duration = 1500) {
        if (typeof document === 'undefined') return;

        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.textContent = message;

        this.container.appendChild(el);

        // Trigger reflow
        void el.offsetWidth;

        el.classList.add('show');

        setTimeout(() => {
            el.classList.remove('show');
            el.addEventListener('transitionend', () => el.remove());
        }, duration);
    }

    success(msg, duration = 1500) { this._show(msg, 'success', duration); }
    error(msg, duration = 5000) { this._show(msg, 'error', duration); }
    info(msg, duration = 1500) { this._show(msg, 'info', duration); }
    warning(msg, duration = 2000) { this._show(msg, 'warning', duration); }
}

export const Toast = new ToastManager();

// Mount to window for backward compatibility
if (typeof window !== 'undefined') {
    window.MAERS = window.MAERS || {};
    window.MAERS.Toast = Toast;
}
