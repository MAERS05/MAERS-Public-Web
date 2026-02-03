/**
 * MAERS Templates Manager
 * ES6 Module Version
 * HTML 模板管理器，使用 <template> 元素替代字符串拼接
 * @version 3.0.0 - ES6 Module
 */

import { Utils } from './utils.module.js';

const Templates = {
    _cache: new Map(),

    /**
     * 注册模板
     * @param {string} name - 模板名称
     * @param {string} html - 模板 HTML
     */
    register(name, html) {
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        this._cache.set(name, template);
    },

    /**
     * 克隆模板并填充数据
     * @param {string} name - 模板名称
     * @param {Object} data - 数据对象
     * @returns {DocumentFragment}
     */
    clone(name, data = {}) {
        const template = this._cache.get(name);
        if (!template) {
            console.warn(`[MAERS.Templates] Template "${name}" not found`);
            return document.createDocumentFragment();
        }

        const fragment = template.content.cloneNode(true);
        this._fillData(fragment, data);
        return fragment;
    },

    /**
     * 填充数据到 DOM 片段
     * @param {DocumentFragment} fragment - DOM 片段
     * @param {Object} data - 数据对象
     */
    _fillData(fragment, data) {
        // 处理 data-text 属性 (安全文本)
        fragment.querySelectorAll('[data-text]').forEach(el => {
            const key = el.getAttribute('data-text');
            if (data[key] !== undefined) {
                el.textContent = data[key];
            }
        });

        // 处理 data-html 属性 (净化 HTML)
        fragment.querySelectorAll('[data-html]').forEach(el => {
            const key = el.getAttribute('data-html');
            if (data[key] !== undefined && Utils?.sanitizeHtml) {
                el.innerHTML = Utils.sanitizeHtml(data[key]);
            }
        });

        // 处理 data-attr-* 属性
        fragment.querySelectorAll('*').forEach(el => {
            Array.from(el.attributes).forEach(attr => {
                if (attr.name.startsWith('data-attr-')) {
                    const targetAttr = attr.name.replace('data-attr-', '');
                    const key = attr.value;
                    if (data[key] !== undefined) {
                        el.setAttribute(targetAttr, data[key]);
                    }
                    el.removeAttribute(attr.name);
                }
            });
        });

        // 处理 data-class 属性 (条件类名)
        fragment.querySelectorAll('[data-class]').forEach(el => {
            const key = el.getAttribute('data-class');
            if (data[key]) {
                el.classList.add(...data[key].split(' '));
            }
        });

        // 处理 data-if 属性 (条件渲染)
        fragment.querySelectorAll('[data-if]').forEach(el => {
            const key = el.getAttribute('data-if');
            const negate = key.startsWith('!');
            const actualKey = negate ? key.slice(1) : key;
            const show = negate ? !data[actualKey] : !!data[actualKey];
            if (!show) {
                el.remove();
            }
        });
    },

    /**
     * 从 DOM 中加载现有的 <template> 元素
     */
    loadFromDOM() {
        document.querySelectorAll('template[id]').forEach(template => {
            this._cache.set(template.id, template);
        });
    },

    /**
     * 初始化常用模板
     */
    init() {
        // CMS 卡片模板
        this.register('grid-item', `
            <div class="grid-item">
                <div class="card-actions" data-if="isAdmin">
                    <div class="action-mini action-pick">➦</div>
                    <div class="action-mini action-rename">✎</div>
                    <div class="action-mini act-del action-delete">×</div>
                    <div class="action-mini action-add-tag">＋</div>
                </div>
                <div class="item-icon" data-text="icon"></div>
                <div class="item-title" data-text="title"></div>
                <div class="item-tags"></div>
            </div>
        `);

        // 标签模板
        this.register('mini-tag', `
            <span class="mini-tag" data-text="tagName"></span>
        `);

        // 面包屑项模板
        this.register('crumb-item', `
            <span class="crumb-item" data-text="title"></span>
        `);

        // 抽屉项模板
        this.register('drawer-item', `
            <div class="drawer-item">
                <span data-text="tagName"></span>
                <span class="tag-count-badge" data-text="count"></span>
            </div>
        `);

        // 从 DOM 加载额外模板
        this.loadFromDOM();
    }
};

// 自动初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Templates.init());
} else {
    Templates.init();
}

// 挂载到全局命名空间（向后兼容）
if (typeof window !== 'undefined') {
    window.MAERS = window.MAERS || {};
    window.MAERS.Templates = Templates;
}

// 导出
export { Templates };
export default Templates;
