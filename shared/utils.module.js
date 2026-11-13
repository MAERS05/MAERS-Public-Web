/**
 * MAERS Shared Utilities (utils.module.js)
 * 统一的安全工具库和通用函数
 * @version 3.0.0 - ES6 Module
 */

function setElementAttribute(el, key, value) {
    if (key === 'className') {
        el.className = value;
    } else if (key === 'dataset') {
        Object.entries(value).forEach(([name, entry]) => { el.dataset[name] = entry; });
    } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
        el.setAttribute(key, value);
    }
}

function appendElementChild(el, child) {
    if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
    } else if (child && child instanceof HTMLElement) {
        el.appendChild(child);
    }
}

function matchesTags(tags, selectedTags, mode) {
    if (!selectedTags.length) return true;
    if (!tags) return false;
    if (mode === 'AND') return selectedTags.every(tag => tags.includes(tag));
    if (mode === 'OR') return selectedTags.some(tag => tags.includes(tag));
    if (mode === 'DEL') return selectedTags.every(tag => !tags.includes(tag));
    return true;
}

export const Utils = {
    // ================= 安全工具 =================

    /**
     * HTML 实体转义，防止 XSS 攻击
     * @param {*} input - 任意输入
     * @returns {string} 转义后的安全字符串
     */
    escapeHtml(input) {
        return String(input ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    /**
     * 属性值转义，用于写入 HTML 属性 (如 value="...")
     * @param {*} input - 任意输入
     * @returns {string} 转义后的安全字符串
     */
    escapeAttr(input) {
        return this.escapeHtml(input).replace(/`/g, '&#096;');
    },

    /**
     * 安全的 JSON 字符串化，用于拼接到 onclick 参数
     * @param {*} input - 任意输入
     * @returns {string} JSON 格式的字符串
     */
    jsStr(input) {
        return JSON.stringify(String(input ?? ''));
    },

    /**
     * 净化 Markdown 渲染结果
     * @param {string} html - Markdown 渲染的 HTML
     * @returns {string} 净化后的 HTML
     */
    sanitizeHtml(html) {
        if (typeof window.DOMPurify !== 'undefined') {
            return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
        }
        // 如果没有 DOMPurify，使用简单的标签过滤
        console.warn('[MAERS.Utils] DOMPurify not loaded, using basic sanitization');
        return this.escapeHtml(html);
    },

    /**
     * 安全地绑定事件监听器
     * @param {string|HTMLElement} selector - 选择器字符串或 DOM 元素
     * @param {string} event - 事件名称
     * @param {Function} handler - 事件处理函数
     * @returns {HTMLElement|null} 绑定了事件的元素或 null
     */
    bindEvent(selector, event, handler) {
        const el = typeof selector === 'string'
            ? document.querySelector(selector)
            : selector;
        if (el) el.addEventListener(event, handler);
        return el;
    },

    // ================= 通用工具 =================

    /**
     * 防抖函数
     * @param {Function} fn - 要执行的函数
     * @param {number} delay - 延迟毫秒数
     * @returns {Function} 防抖后的函数
     */
    debounce(fn, delay = 300) {
        let timer = null;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    },

    /**
     * 节流函数
     * @param {Function} fn - 要执行的函数
     * @param {number} limit - 限制毫秒数
     * @returns {Function} 节流后的函数
     */
    throttle(fn, limit = 300) {
        let inThrottle = false;
        return function (...args) {
            if (!inThrottle) {
                fn.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    },

    /**
     * 格式化日期
     * @param {Date|string|number} date - 日期对象或时间戳
     * @param {string} format - 格式模板 (默认 YYYY-MM-DD)
     * @returns {string} 格式化后的日期字符串
     */
    formatDate(date, format = 'YYYY-MM-DD') {
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';

        const pad = (n) => String(n).padStart(2, '0');
        const tokens = {
            'YYYY': d.getFullYear(),
            'MM': pad(d.getMonth() + 1),
            'DD': pad(d.getDate()),
            'HH': pad(d.getHours()),
            'mm': pad(d.getMinutes()),
            'ss': pad(d.getSeconds())
        };

        return format.replace(/YYYY|MM|DD|HH|mm|ss/g, match => tokens[match]);
    },

    /**
     * 生成唯一 ID
     * @param {string} prefix - ID 前缀
     * @returns {string} 唯一 ID
     */
    generateId(prefix = 'id') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    },

    /**
     * 深克隆对象
     * @param {*} obj - 要克隆的对象
     * @returns {*} 克隆后的对象
     */
    deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (obj instanceof Date) return new Date(obj);
        if (obj instanceof Array) return obj.map(item => this.deepClone(item));
        if (obj instanceof Object) {
            const copy = {};
            Object.keys(obj).forEach(key => {
                copy[key] = this.deepClone(obj[key]);
            });
            return copy;
        }
        return obj;
    },

    // ================= DOM 工具 =================

    /**
     * 安全地设置元素的文本内容
     * @param {HTMLElement} el - DOM 元素
     * @param {string} text - 文本内容
     */
    setText(el, text) {
        if (el) el.textContent = text;
    },

    /**
     * 安全地设置元素的 HTML 内容 (会进行净化)
     * @param {HTMLElement} el - DOM 元素
     * @param {string} html - HTML 内容
     */
    setHtml(el, html) {
        if (el) el.innerHTML = this.sanitizeHtml(html);
    },

    /**
     * 创建 DOM 元素
     * @param {string} tag - 标签名
     * @param {Object} attrs - 属性对象
     * @param {string|HTMLElement|Array} children - 子元素
     * @returns {HTMLElement}
     */
    createElement(tag, attrs = {}, children = null) {
        const el = document.createElement(tag);

        Object.entries(attrs).forEach(([key, value]) => setElementAttribute(el, key, value));
        const childList = Array.isArray(children) ? children : children ? [children] : [];
        childList.forEach(child => appendElementChild(el, child));

        return el;
    },

    // ================= 图片工具 =================

    /**
     * 生成封面图片 URL (支持多格式)
     * @param {string} coverImage - 原始封面图片路径
     * @param {string} format - 图片格式 ('webp' | 'avif')
     * @returns {string|null} 生成的 URL
     */
    getCoverUrl(coverImage, format = 'avif') {
        if (!coverImage) return null;
        const pathParts = coverImage.split('/');
        const filename = pathParts[pathParts.length - 1];
        const basename = filename.replace(/\.[^/.]+$/, "");
        const folder = format === 'avif' ? 'previews' : 'thumbnails';
        const ext = format === 'avif' ? 'avif' : 'webp';
        return `photos/${folder}/covers/${basename}.${ext}`;
    }
};

export const Search = {
    /**
     * 递归查找节点信息
     * @param {Array} list - 节点列表
     * @param {string} id - 目标节点 ID
     * @returns {Object|null}
     */
    findNodeInfo(list, id) {
        for (let n of list) {
            if (n.id === id) return n;
            if (n.children) {
                const f = this.findNodeInfo(n.children, id);
                if (f) return f;
            }
        }
        return null;
    },

    /**
     * 路径查找 (返回节点对象数组)
     * @param {Array} list - 节点列表
     * @param {string} targetId - 目标节点 ID
     * @param {Array} currentPath - 当前路径
     * @returns {Array|null}
     */
    findPathNodes(list, targetId, currentPath = []) {
        for (let n of list) {
            if (n.id === targetId) return [...currentPath, n];
            if (n.children) {
                const p = this.findPathNodes(n.children, targetId, [...currentPath, n]);
                if (p) return p;
            }
        }
        return null;
    },

    /**
     * 路径查找 (返回 ID 数组)
     * @param {Array} list - 节点列表
     * @param {string} targetId - 目标节点 ID
     * @param {Array} currentPath - 当前路径
     * @returns {Array|null}
     */
    findPathIds(list, targetId, currentPath = ['root']) {
        for (let n of list) {
            if (n.id === targetId) return [...currentPath, n.id];
            if (n.children) {
                const p = this.findPathIds(n.children, targetId, [...currentPath, n.id]);
                if (p) return p;
            }
        }
        return null;
    },

    /**
     * 收集所有标签及其计数
     * @param {Array} list - 节点列表
     * @param {Map} map - 标签计数映射
     */
    collectAllTags(list, map) {
        list.forEach(node => {
            if (node.tags) {
                node.tags.forEach(t => map.set(t, (map.get(t) || 0) + 1));
            }
            if (node.children) this.collectAllTags(node.children, map);
        });
    },

    /**
     * 获取拼音首字母
     * @param {string} str - 中文字符串
     * @returns {string} 拼音首字母
     */
    getPinyinInitials(str) {
        if (!str) return '';
        const boundaries = "阿八嚓哒俄发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝".split('');
        const letters = "ABCDEFGHJKLMNOPQRSTWXYZ".split('');
        let res = '';
        for (const c of str) {
            if (/[a-zA-Z0-9]/.test(c)) { res += c; continue; }
            if (!/[\u4e00-\u9fa5]/.test(c)) { res += c; continue; }
            let found = '';
            for (let i = letters.length - 1; i >= 0; i--) {
                if (c.localeCompare(boundaries[i], 'zh-CN') >= 0) {
                    found = letters[i];
                    break;
                }
            }
            res += found || c;
        }
        return res;
    },

    /**
     * 通用匹配逻辑 (支持中文、拼音、大小写)
     * @param {string} text - 原文
     * @param {string} query - 查询词
     * @returns {boolean}
     */
    match(text, query) {
        if (!query) return true;
        if (!text) return false;

        const q = query.toLowerCase();
        const t = text.toLowerCase();

        // 原文包含
        if (t.includes(q)) return true;

        // 拼音首字母包含
        const pinyin = this.getPinyinInitials(text).toLowerCase();
        if (pinyin.includes(q)) return true;

        return false;
    },

    /**
     * 核心筛选逻辑
     * @param {Array} rootList - 根节点列表
     * @param {Set} filters - 选中的标签集合
     * @param {string} keywordStr - 搜索关键词 (逗号分隔)
     * @returns {Array} 过滤后的节点数组
     */
    filterNodes(rootList, filters, keywordStr, filterMode = 'AND') {
        const results = [];
        const keywords = keywordStr ?
            keywordStr.toLowerCase().split(/[,，]/).map(s => s.trim()).filter(s => s) : [];
        const selectedTags = Array.from(filters || []);

        const visit = list => {
            for (const node of list) {
                if ('_enc' in node) continue;
                const tagsMatch = matchesTags(node.tags, selectedTags, filterMode);
                if (tagsMatch && (!keywords.length || keywords.some(keyword => this.match(node.title || node.name, keyword)))) {
                    results.push(node);
                }
                if (node.children) visit(node.children);
            }
        };

        visit(rootList);
        return results;
    }
};

const assetRequests = new Map();

/** 同一页面共用按需加载请求，失败后移除节点并允许重试。 */
export function loadLocalAsset(path, { stylesheet = false, before = null } = {}) {
    const url = new URL(path, document.baseURI).href;
    if (assetRequests.has(url)) return assetRequests.get(url);
    const element = document.createElement(stylesheet ? 'link' : 'script');
    if (stylesheet) {
        element.rel = 'stylesheet';
        element.href = url;
    } else {
        element.src = url;
        element.async = true;
    }
    const request = new Promise((resolve, reject) => {
        element.addEventListener('load', resolve, { once: true });
        element.addEventListener('error', () => {
            assetRequests.delete(url);
            element.remove();
            reject(Error(`资源加载失败 ${path}`));
        }, { once: true });
    });
    assetRequests.set(url, request);
    if (before) before.before(element);
    else document.head.appendChild(element);
    return request;
}
