/**
 * MAERS DataProvider - 统一数据访问层 (v4.0 ESM)
 * 职责：环境感知、数据策略分发、业务接口封装
 * 依赖：MAERS.ApiClient (暂时保留全局依赖，后续可进一步模块化)
 * @version 4.0.0
 */

import { api } from './api-client.module.js';

export const DataProvider = {
    // 缓存数据
    _cache: {},

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
        return api.upload('/upload', file, {
            category: category,
            name: encodeURIComponent(file.name)
        });
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
