/** 同步请求管理：入队串行化、失败重试编号和并发拉取合并。 */
import { cloudflareRelay } from './cloudflare-relay.module.js';
import { contentHash } from './relay-actions.module.js';

const REQUEST_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/** Git 元数据独立读取，状态徽章和提交面板共用超时处理。 */
export async function getLocalGitStatus() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch('/api/git/status', { cache: 'no-store', signal: controller.signal, redirect: 'error' });
        if (response.ok) return await response.json();
        return { success: false, msg: `HTTP ${response.status}` };
    } catch (error) {
        return { success: false, msg: error.message };
    } finally {
        clearTimeout(timeout);
    }
}

export class RelayRequests {
    constructor() {
        this._pushes = new Map();
        this._pulls = new Map();
        this._retries = new Map();
        this._timestamp = 0;
        this._tail = Promise.resolve();
    }

    /** 相同请求共用一次推送，前一项失败后继续处理后续请求。 */
    enqueue(relay, request, send) {
        const key = JSON.stringify([relay?.endpoint, relay?.secret, request]);
        const active = this._pushes.get(key);
        if (active) return active;
        const pending = this._tail.then(send, send).finally(() => this._pushes.delete(key));
        this._pushes.set(key, pending);
        this._tail = pending;
        return pending;
    }

    /** 只复用同一配置、同一写入代次中尚未完成的拉取。 */
    pull(relay, revision) {
        const key = JSON.stringify([relay.endpoint, relay.secret, revision]);
        const active = this._pulls.get(key);
        if (active) return active;
        const pending = cloudflareRelay.pull(relay.endpoint, relay.secret).finally(() => this._pulls.delete(key));
        this._pulls.set(key, pending);
        return pending;
    }

    /** 收到确认前保留请求编号，刷新后重试也使用原编号。 */
    async reserve(relay, request, bucketId) {
        const endpoint = relay.endpoint.trim().replace(/\/+$/, '');
        const key = `maers_relay_retry_${await contentHash([endpoint, request])}`;
        const previous = this._retries.get(key) ?? readRetry(key);
        if (previous?.requestId && Number.isSafeInteger(previous.timestamp) && Date.now() - previous.timestamp < REQUEST_MAX_AGE) {
            this._timestamp = Math.max(this._timestamp, previous.timestamp);
            this._retries.set(key, previous);
            return { key, ...previous };
        }

        this._timestamp = Math.max(Date.now(), this._timestamp + 1);
        const retry = { requestId: crypto.randomUUID(), timestamp: this._timestamp,
            ...(bucketId ? { bucketId } : {}) };
        this._retries.set(key, retry);
        try {
            localStorage.setItem(key, JSON.stringify(retry));
        } catch (error) {
            console.warn('[MAERS.Sync] 重试编号仅保存在当前页面:', error);
        }
        return { key, ...retry };
    }

    finish({ key }) {
        this._retries.delete(key);
        try {
            localStorage.removeItem(key);
        } catch (error) {
            console.warn('[MAERS.Sync] 草稿已确认，清除浏览器重试记录失败:', error);
        }
    }
}

function readRetry(key) {
    try {
        return JSON.parse(localStorage.getItem(key));
    } catch (error) {
        console.warn('[MAERS.Sync] 读取浏览器重试记录失败:', error);
        return null;
    }
}
