/**
 * MAERS API Client (api-client.module.js)
 * 统一 HTTP 请求客户端，处理 fetch 封装、错误捕获和参数序列化
 * @version 3.0.0 - ES6 Module
 */

export class ApiClient {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
    }

    /**
     * 通用请求方法
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const defaultHeaders = {};

        const config = {
            ...options,
            headers: { ...defaultHeaders, ...options.headers }
        };

        try {
            const response = await fetch(url, config);

            // 统一错误处理
            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`API Error ${response.status}: ${errorBody || response.statusText}`);
            }

            // 根据 Content-Type 自动解析
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.indexOf("application/json") !== -1) {
                return await response.json();
            } else {
                return await response.text();
            }
        } catch (error) {
            console.error(`[MAERS.ApiClient] Request failed: ${endpoint}`, error);
            if (window.MAERS?.Toast) {
                // Remove "Error: " prefix if present for cleaner display
                const msg = error.message.replace(/^Error:\s*/, '');
                window.MAERS.Toast.error(msg);
            }
            throw error; // 继续抛出供上层处理
        }
    }

    get(endpoint, params = {}) {
        const queryString = new URLSearchParams(params).toString();
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        return this.request(url, { method: 'GET' });
    }

    post(endpoint, body) {
        return this.request(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    }

    // 上传文件专用
    upload(endpoint, file, params = {}) {
        const queryString = new URLSearchParams(params).toString();
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;

        return this.request(url, {
            method: 'POST',
            body: file
        });
    }
}

// Instantiate and export a singleton
export const api = new ApiClient();

// Mount to window for backward compatibility if needed
if (typeof window !== 'undefined') {
    window.MAERS = window.MAERS || {};
    window.MAERS.ApiClient = api;
}
