/**
 * MAERS DataProvider - 统一数据访问层 (v4.0 ESM)
 * 职责：环境感知、数据策略分发、业务接口封装
 * 依赖：通过 ES Module 导入 api 客户端
 * @version 4.0.0
 */

import { api } from './api-client.module.js';

/** 统一公开媒体入口；私密 URL 和外部绝对地址不做改写。 */
export function publicMediaUrl(value) {
    if (typeof value === 'string' && value.startsWith('/api/private/media/')) return value;
    if (!value || /^https?:\/\//i.test(value)) return value;
    const key = value.replace(/^\/+/, '');
    const base = (window.MAERS?.Config?.MEDIA_PUBLIC_BASE || '').replace(/\/+$/, '');
    if (!/^photos\/(images|thumbnails|previews)\//.test(key)) return value;
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return base && key.startsWith('photos/images/') ? `${base}/${encoded}` : encoded;
}

/** 保留真实文件键；URL 路径仅解码一次，以便匹配完整 CDN 地址。 */
function mediaKeys(value, fromUrl = true) {
    if (typeof value !== 'string' || !value) return [];
    const clean = path => path.replace(/\\/g, '/').replace(/^(?:\.\.\/|\.\/)+/, '').replace(/^\/+/, '');
    const keys = [clean(value)];
    if (fromUrl) try {
        const path = clean(decodeURIComponent(new URL(value, window.location.href).pathname));
        keys.push(path);
        const media = path.match(/(?:^|\/)(photos\/(?:images|previews|thumbnails)\/.*)$/);
        if (media) keys.push(media[1]);
    } catch { /* 无效 URL 仍可按真实文件键查找。 */ }
    return keys;
}

export const DataProvider = {
    // 缓存数据
    _cache: {},
    _coverIndex: new Map(),
    _coverIndexLoaded: false,
    _coverIndexRequest: null,

    /** 共用页面内封面索引；管理端重新载入时刷新，失败后允许重试。 */
    loadCoverIndex({ refresh = false } = {}) {
        if (this._coverIndexRequest) return this._coverIndexRequest;
        if (this._coverIndexLoaded && !refresh) return Promise.resolve(true);
        this._coverIndexRequest = Promise.resolve().then(async () => {
            try {
                const response = await fetch('data/photos-data.json', { cache: 'no-cache' });
                if (!response.ok) throw new Error(`图片索引请求失败：${response.status}`);
                const data = await response.json();
                if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('图片索引格式无效');
                const index = new Map();
                for (const rows of Object.values(data)) {
                    if (!Array.isArray(rows)) continue;
                    for (const row of rows) {
                        if (!row || typeof row !== 'object') continue;
                        for (const key of mediaKeys(row.path, false)) index.set(key, row);
                    }
                }
                this._coverIndex = index;
                this._coverIndexLoaded = true;
                return true;
            } catch (error) {
                this._coverIndexLoaded = false;
                console.warn('[DataProvider] 封面索引加载失败，使用原图：', error);
                return false;
            } finally {
                this._coverIndexRequest = null;
            }
        });
        return this._coverIndexRequest;
    },

    /** 使用显式私密地址、索引的真实衍生路径或原图，禁止推测文件名。 */
    getCoverUrl(node, size = 'preview') {
        if (!node) return null;
        const explicit = size === 'thumb' ? node.coverThumb || node.coverPreview : node.coverPreview || node.coverThumb;
        if (explicit) return explicit;
        for (const key of mediaKeys(node.coverImage)) {
            const row = this._coverIndex.get(key);
            if (row) return publicMediaUrl(row[size] || row[size === 'thumb' ? 'preview' : 'thumb'] || node.coverImage) || null;
        }
        return publicMediaUrl(node.coverImage) || null;
    },

    // 环境判定
    get isLocal() {
        const host = window.location.hostname;
        const params = new URLSearchParams(window.location.search);

        // 只有带有 admin 参数，或者在 localhost 环境下，才视为 Local Server
        if (params.get('mode') === 'admin') return true;
        return ['localhost', '127.0.0.1', '[::1]', ''].includes(host) ||
            /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host);
    },

    // --- 画廊业务 ---

    /**
     * 获取分类下的图片列表
     */
    async getGalleryData(category) {
        // 本地模式：请求 JSON 文件 (获取最新文件列表)
        if (this.isLocal) {
            const data = await api.get(`data/photos-data.json`, {
                v: Date.now()
            });
            return data[category] || [];
        }

        // 线上模式：读取全局变量 (由 photos-data.js 提供，或异步加载 JSON)
        if (typeof galleryData !== 'undefined' && galleryData[category]) {
            return galleryData[category];
        }

        // 降级：尝试异步加载 JSON
        try {
            const response = await fetch('data/photos-data.json');
            if (response.ok) {
                const data = await response.json();
                return data[category] || [];
            }
        } catch (e) {
            console.error('[DataProvider] Failed to load photos data:', e);
        }

        return [];
    },

    /**
     * 上传图片
     */
    async uploadImage(category, file) {
        if (!this.isLocal) throw new Error("Permission denied: Not local environment");
        const result = await api.upload('/upload', file, {
            category: category,
            name: encodeURIComponent(file.name)
        });
        if (result.sync?.state === 'pending') window.MAERS?.Toast?.warning('图片已保存到本机，云端同步待完成，请在后台备份与恢复中重试');
        return result;
    },

    /**
     * 删除图片
     */
    async deleteImage(path) {
        if (!this.isLocal) throw new Error("Permission denied");
        return api.post('/delete', { path });
    },

    /**
     * 重新排序
     */
    async reorderGallery(category, orderedList) {
        if (!this.isLocal) throw new Error("Permission denied");
        return api.post(`/reorder?category=${category}`, orderedList);
    },

    // --- 音乐业务 ---

    async getMusicData() {
        if (this.isLocal) {
            return api.get('data/music-data.json', { v: Date.now() });
        }
        return typeof musicData !== 'undefined' ? musicData : [];
    },

    async saveMusicData(fullData) {
        if (!this.isLocal) throw new Error("Permission denied");
        return api.post('/api/save_music', fullData);
    },

    async deleteTrack(params) {
        if (!this.isLocal) throw new Error("Permission denied");
        return api.post('/api/delete_track', params);
    },

    async resetTracks(params) {
        if (!this.isLocal) throw new Error("Permission denied");
        return api.post('/api/reset_tracks', params);
    },

    // --- 辅助功能 ---

    async fetchBiliInfo(bvid) {
        if (!this.isLocal) return null;
        return api.get('/api/get_bili_info', { bvid });
    }
};
