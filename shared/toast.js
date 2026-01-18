/**
 * MAERS Toast Notification System
 * Usage: MAERS.Toast.success('Saved!'), MAERS.Toast.error('Error msg')
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};

    class ToastManager {
        constructor() {
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

        _show(message, type = 'info', duration = 3000) {
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

        success(msg, duration = 3000) { this._show(msg, 'success', duration); }
        error(msg, duration = 5000) { this._show(msg, 'error', duration); }
        info(msg, duration = 3000) { this._show(msg, 'info', duration); }
        warning(msg, duration = 4000) { this._show(msg, 'warning', duration); }
    }

    // Mount to namespace
    MAERS.Toast = new ToastManager();

})(typeof window !== 'undefined' ? window : this);
