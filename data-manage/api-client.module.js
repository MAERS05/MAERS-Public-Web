/**
 * MAERS API Client (api-client.module.js)
 * 统一 HTTP 请求客户端，处理 fetch 封装、错误捕获和参数序列化
 * @version 3.0.0 - ES6 Module
 */

const sessions = new Map();

function getSession(origin) {
    if (!sessions.has(origin)) {
        const pending = (async () => {
            const response = await fetch(`${origin}/api/session`, {
                headers: { 'X-MAERS-Client': 'studio' }, cache: 'no-store', redirect: 'error'
            });
            if (!response.ok) throw new Error(`无法连接本地管理会话 (${response.status})`);
            const { token } = await response.json();
            if (typeof token !== 'string' || !token) throw new Error('本地管理会话令牌无效');
            return token;
        })();
        sessions.set(origin, pending);
        // 失败后允许下一次操作重新获取；同一来源的并发请求共用获取过程。
        pending.catch(() => {
            if (sessions.get(origin) === pending) sessions.delete(origin);
        });
    }
    return sessions.get(origin);
}

/** 本地写请求附带会话令牌；保留原始 Response，供业务代码判断状态。 */
export async function localFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const target = new URL(url, window.location.href);
    const isLocal = target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname);
    if (!isLocal) return fetch(url, options);
    const admin = window.IS_ADMIN === true || /\/admin(?:-|\.|\/?$)/.test(window.location.pathname) ||
        new URLSearchParams(window.location.search).get('mode') === 'admin';
    if (admin && target.origin === window.location.origin &&
        !target.pathname.startsWith('/api/crypto/') && target.pathname !== '/data/crypto-keyring.json') {
        await (await import('./encrypt/admin-session.module.js')).ensureAdminSession();
    }
    if ((method === 'GET' || method === 'HEAD') && !admin) return fetch(url, options);

    const session = getSession(target.origin);
    const token = await session;
    const send = sessionToken => {
        const headers = new Headers(options.headers);
        headers.set('X-MAERS-Token', sessionToken);
        return fetch(url, { ...options, headers, redirect: 'error' });
    };
    const response = await send(token);
    if (response.status !== 403) return response;
    const error = await response.clone().json().catch(() => ({}));
    if (admin && error.code === 'private_admin_required') {
        const management = await import('./encrypt/admin-session.module.js');
        management.resetAdminSession();
        await management.ensureAdminSession();
        return send(token);
    }
    if (error.code !== 'invalid_session') return response;
    // 仅在服务明确表示令牌过期、尚未分发操作时重试一次，避免重复执行写入。
    if (sessions.get(target.origin) === session) sessions.delete(target.origin);
    const refreshed = await getSession(target.origin);
    if (admin && !target.pathname.startsWith('/api/crypto/')) {
        const management = await import('./encrypt/admin-session.module.js');
        management.resetAdminSession();
        await management.ensureAdminSession();
    }
    return send(refreshed);
}

export class ApiClient {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
    }

    /**
     * 通用请求方法
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        try {
            const response = await localFetch(url, options);

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

// 显式导出的共享客户端。
export const api = new ApiClient();
