/**
 * MAERS API Client (api-client.module.js)
 * 统一 HTTP 请求客户端，处理 fetch 封装、错误捕获和参数序列化
 * @version 3.0.0 - ES6 Module
 */
import { confirmAction } from "./admin/admin-confirm.module.js";


import { uploadFetch } from './upload-progress.module.js';

const sessions = new Map();
const LOCAL_WRITE_WARNING = Object.freeze({ upload: 64 * 1024 * 1024, json: 16 * 1024 * 1024 });
export const STUDIO_ENTRY_KEY = 'maers_admin_entry';

function isLoopback(url) {
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
}

export function isAdminAddress(url) {
    return /\/admin(?:-|\.|\/?$)/.test(url.pathname) || url.searchParams.get('mode') === 'admin';
}

export function isStudioAdminPage() {
    const url = new URL(window.location.href);
    return isLoopback(url) && (window.IS_ADMIN === true || isAdminAddress(url));
}

/** 线上管理页单独验证入口，不把浏览器密钥交给本机管理接口。 */
export function isOnlineAdminPage(url = new URL(window.location.href)) {
    const local = ['localhost', '127.0.0.1', '[::1]', ''].includes(url.hostname) ||
        /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(url.hostname);
    return !local && (window.IS_ADMIN === true || isAdminAddress(url));
}

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

async function confirmLargeLocalWrite(path, body) {
    const upload = path === '/upload' || path === '/upload/';
    const limit = LOCAL_WRITE_WARNING[upload ? 'upload' : 'json'];
    let size = body?.size ?? body?.byteLength ?? 0;
    if (typeof body === 'string' && body.length * 3 >= limit) size = new TextEncoder().encode(body).byteLength;
    if (size < limit) return;
    const label = upload ? '图片' : '保存数据';
    if (!await confirmAction({ confirmText: "继续写入", cancelText: "先不写入", description: (`${label}约 ${(size / (1024 * 1024)).toFixed(1)} MiB，可能导致本地后台崩溃。确认继续？`).replace('确认继续？', '') })) {
        throw new DOMException('已取消本地写入', 'AbortError');
    }
}

/** 本地写请求附带会话令牌；保留原始 Response，供业务代码判断状态。 */
export async function localFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const target = new URL(url, (typeof document !== 'undefined' && document.baseURI) || window.location.href);
    if (!isLoopback(target)) return fetch(url, options);
    if (method === 'POST') await confirmLargeLocalWrite(target.pathname, options.body);
    const current = new URL(window.location.href);
    const admin = window.IS_ADMIN === true || isAdminAddress(current);
    if (admin && target.origin === window.location.origin &&
        !target.pathname.startsWith('/api/crypto/') && !target.pathname.startsWith('/api/studio/') &&
        target.pathname !== '/api/album/job' &&
        target.pathname !== '/data/crypto-keyring.json') {
        await (await import('./encrypt/admin-session.module.js')).ensureAdminSession();
    }
    if ((method === 'GET' || method === 'HEAD') && !admin) return fetch(url, options);

    const session = getSession(target.origin);
    const token = await session;
    const send = sessionToken => {
        const headers = new Headers(options.headers);
        headers.set('X-MAERS-Token', sessionToken);
        return uploadFetch(url, { ...options, headers, redirect: 'error' }, options.onUploadProgress);
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
    if (admin && !target.pathname.startsWith('/api/crypto/') && target.pathname !== '/api/album/job') {
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
            const response = options.progress
                ? await (await import('./operation-progress.module.js')).operationFetch(url, options, options.progress)
                : await localFetch(url, options);

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
    upload(endpoint, file, params = {}, options = {}) {
        const queryString = new URLSearchParams(params).toString();
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;

        return this.request(url, {
            ...options,
            method: 'POST',
            body: file
        });
    }
}

// 显式导出的共享客户端。
export const api = new ApiClient();
