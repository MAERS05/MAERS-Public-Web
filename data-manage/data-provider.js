/**
 * MAERS DataProvider - 统一数据访问层 (v3.0)
 * 职责：环境感知、数据策略分发、业务接口封装
 * 依赖：MAERS.ApiClient
 * @version 3.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};

    MAERS.DataProvider = {
        // 缓存数据
        _cache: {},

        // 环境判定
        get isLocal() {
            // 如果是 file:// 协议，直接视为"非本地服务器模式"，强制走静态数据
            if (window.location.protocol === 'file:') return false;

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
            // 1. 本地模式：尝试请求 Python API (获取最新文件列表)
            if (this.isLocal) {
                try {
                    const jsContent = await MAERS.ApiClient.request(`data/photos-data.js`, {
                        method: 'GET',
                        headers: { 'Cache-Control': 'no-cache' },
                        v: Date.now()
                    });

                    // 去掉前缀 "window.galleryData = " 和后缀 ";"
                    const jsonStr = jsContent.replace('window.galleryData = ', '').replace(/;\s*$/, '');
                    const data = JSON.parse(jsonStr);
                    return data[category] || [];
                } catch (e) {
                    console.warn("[MAERS.DataProvider] Local data fetch failed, fallback to static.", e);
                }
            }

            // 2. 线上模式：读取全局变量 (由 photos-data.js 提供)
            if (typeof galleryData !== 'undefined' && galleryData[category]) {
                return galleryData[category];
            }

            // 3. 最后的兜底：尝试请求静态 JSON
            try {
                const data = await MAERS.ApiClient.get('data/photos-data.json');
                return data[category] || [];
            } catch (e) {
                return [];
            }
        },

        /**
         * 上传图片
         */
        async uploadImage(category, file) {
            if (!this.isLocal) throw new Error("Permission denied: Not local environment");
            return MAERS.ApiClient.upload('/upload', file, {
                category: category,
                name: encodeURIComponent(file.name)
            });
        },

        /**
         * 删除图片
         */
        async deleteImage(path) {
            if (!this.isLocal) throw new Error("Permission denied");
            return MAERS.ApiClient.post('/delete', { path });
        },

        /**
         * 重新排序
         */
        async reorderGallery(category, orderedList) {
            if (!this.isLocal) throw new Error("Permission denied");
            return MAERS.ApiClient.post(`/reorder?category=${category}`, orderedList);
        },

        // --- 音乐业务 ---

        async getMusicData() {
            if (this.isLocal) {
                return MAERS.ApiClient.get('data/music-data.json', { v: Date.now() });
            }
            if (typeof musicData !== 'undefined') return musicData;
            return MAERS.ApiClient.get('data/music-data.json');
        },

        async saveMusicData(fullData) {
            if (!this.isLocal) throw new Error("Permission denied");
            return MAERS.ApiClient.post('/api/save_music', fullData);
        },

        async deleteTrack(params) {
            if (!this.isLocal) throw new Error("Permission denied");
            return MAERS.ApiClient.post('/api/delete_track', params);
        },

        async resetTracks(params) {
            if (!this.isLocal) throw new Error("Permission denied");
            return MAERS.ApiClient.post('/api/reset_tracks', params);
        },

        // --- 辅助功能 ---

        async fetchBiliInfo(bvid) {
            if (!this.isLocal) return null;
            return MAERS.ApiClient.get('/api/get_bili_info', { bvid });
        }
    };

})(typeof window !== 'undefined' ? window : this);
