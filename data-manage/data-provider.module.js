/**
 * MAERS DataProvider - 统一数据访问层 (v4.0 ESM)
 * 职责：环境感知、数据策略分发、业务接口封装
 * 依赖：通过 ES Module 导入 api 客户端
 * @version 4.0.0
 */

import { api } from './api-client.module.js';

// KV 预览只存在于管理页面内存，正文和图库索引始终使用原来的媒体键。
const draftPhotos = new Map();

export function rememberDraftPhoto(path, url, endpoint) {
    if (typeof path !== 'string' || !path.startsWith('photos/images/') || !url) return;
    try {
        const preview = new URL(url);
        const encoded = path.split('/').map(encodeURIComponent).join('/');
        const privateScope = path.startsWith('photos/images/_cloud_private/');
        const route = privateScope ? '/private/' : '/api/drafts/preview/';
        const validQuery = privateScope ? preview.search === '?draft=1' : /^\?p=[a-f0-9-]{36}$/.test(preview.search);
        if (preview.protocol === 'https:' && preview.origin === new URL(endpoint).origin &&
            preview.pathname === route + encoded && validQuery && !preview.hash && !preview.username && !preview.password) {
            draftPhotos.set(path, preview.href);
        }
    } catch { /* 草稿预览地址无效时沿用正式媒体地址。 */ }
}

export function clearDraftPhotos(paths = null) {
    if (!paths) draftPhotos.clear();
    else for (const path of paths) draftPhotos.delete(path);
}

export function draftPhotoUrl(key, privateScope = false) {
    if (typeof key !== 'string' || key.startsWith('photos/images/_cloud_private/') !== privateScope) return undefined;
    return draftPhotos.get(key);
}

/** 统一公开媒体入口；私密 URL 和外部绝对地址不做改写。 */
export function publicMediaUrl(value, { local = false } = {}) {
    if (typeof value === 'string' && value.startsWith('/api/private/media/')) return value;
    if (!value || /^https?:\/\//i.test(value)) return value;
    const key = value.replace(/^\/+/, '');
    const draft = draftPhotoUrl(key);
    if (draft) return draft;
    const base = (window.MAERS?.Config?.MEDIA_PUBLIC_BASE || '').replace(/\/+$/, '');
    if (!/^photos\/(images|thumbnails|previews)\//.test(key)) return value;
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return base && !local ? `${base}/${encoded}` : encoded;
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

let photoIndexRequest;
let coverIndexRequest;
let coverIndex = new Map();

/** 只复用公开索引，避免在页面内缓存本机管理会话的私密投影。 */
function readPublicPhotoIndex(refresh) {
    if (!refresh && photoIndexRequest) return photoIndexRequest;
    const request = (async () => {
        const response = await fetch('data/photos-data.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error('图片索引请求失败：' + response.status);
        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('图片索引格式无效');
        return data;
    })();
    photoIndexRequest = request;
    request.catch(() => {
        if (photoIndexRequest === request) photoIndexRequest = undefined;
    });
    return request;
}

export const DataProvider = {
    /** 共用页面内封面索引；管理端重新载入时刷新，失败后允许重试。 */
    async loadCoverIndex({ refresh = false } = {}) {
        const request = readPublicPhotoIndex(refresh);
        try {
            const data = await request;
            if (request !== photoIndexRequest) return false;
            if (request === coverIndexRequest) return true;
            const index = new Map();
            for (const rows of Object.values(data)) {
                if (!Array.isArray(rows)) continue;
                for (const row of rows) {
                    if (!row || typeof row !== 'object') continue;
                    for (const key of mediaKeys(row.path, false)) index.set(key, row);
                }
            }
            coverIndex = index;
            coverIndexRequest = request;
            return true;
        } catch (error) {
            console.warn('[DataProvider] 封面索引加载失败，使用原图：', error);
            return false;
        }
    },

    /** 使用显式私密地址、索引的真实衍生路径或原图，禁止推测文件名。 */
    getCoverUrl(node, size = 'preview', { local = this.isLocal } = {}) {
        if (!node) return null;
        const explicit = size === 'thumb' ? node.coverThumb || node.coverPreview : node.coverPreview || node.coverThumb;
        if (explicit) return explicit;
        for (const key of mediaKeys(node.coverImage)) {
            const row = coverIndex.get(key);
            if (row) return publicMediaUrl(row[size] || row[size === 'thumb' ? 'preview' : 'thumb'] || node.coverImage, { local }) || null;
        }
        return publicMediaUrl(node.coverImage, { local }) || null;
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
    async getGalleryData(category, { refresh = false } = {}) {
        if (this.isLocal && (refresh || window.IS_ADMIN === true)) {
            const data = await api.get('data/photos-data.json', { v: Date.now() });
            return data[category] || [];
        }

        if (!this.isLocal && !refresh && typeof galleryData !== 'undefined' && galleryData[category]) {
            return galleryData[category];
        }

        try {
            const data = await readPublicPhotoIndex(refresh);
            return structuredClone(data[category] || []);
        } catch (e) {
            if (this.isLocal) throw e;
            console.error('[DataProvider] Failed to load photos data:', e);
            return [];
        }
    },

    /**
     * 上传图片
     */
    async uploadImage(category, file, options = {}) {
        if (!this.isLocal) throw new Error("Permission denied: Not local environment");
        const result = await api.upload('/upload', file, {
            category: category,
            name: encodeURIComponent(file.name),
            ...(options.bucketId ? { bucketId: options.bucketId } : {})
        }, options);
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
