/**
 * Cloudflare Relay Driver (cloudflare-relay.module.js)
 * 职责：与 Cloudflare Worker + KV 中继网关进行极速 HTTP 通信
 * 手机端暂存文字和图片，电脑端拉取与确认清空。
 * @version 1.0.0
 */

import { uploadFetch } from '../upload-progress.module.js';
import { photoDateLabel } from '../../shared/photo-date.module.js';

const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp|avif|gif|bmp|hei[cf])$/i;
const IMAGE_MIME = /^image\/(?:jpeg|png|webp|avif|gif|bmp|x-ms-bmp|hei[cf](?:-sequence)?)$/i;
const IMAGE_FORMAT_ERROR = '不支持该图片格式，请选择 JPG、PNG、WebP、AVIF、GIF、BMP 或 HEIC/HEIF';
const KV_VALUE_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_SIZE_ERROR = '图片草稿超过 KV 单文件 25 MiB 上限，请压缩图片或在电脑本地后台上传';
const DRAFT_SIZE_ERROR = '云端草稿超过 KV 单条 25 MiB 上限，请在电脑本地后台保存';

async function relayError(response, fallback) {
    try { return (await response.json())?.error || fallback; }
    catch { return fallback; }
}

async function uploadDraftImage(endpoint, secret, body, onProgress, group, token) {
    const base = endpoint.trim().replace(/\/+$/, '');
    const query = group ? '?g=' + encodeURIComponent(group) : '';
    const response = await uploadFetch(base + '/api/drafts/upload' + query, {
        method: 'POST', headers: { 'x-sync-key': secret.trim(), ...(token ? { 'x-private-media-token': token } : {}) }, body
    }, onProgress);
    if (response.status === 404) throw Error('请先更新云端同步 Worker，再上传图片草稿');
    if (!response.ok) {
        const fallback = response.status === 413 ? IMAGE_SIZE_ERROR :
            response.status === 415 ? IMAGE_FORMAT_ERROR : `图片草稿上传失败（HTTP ${response.status}）`;
        throw Error(await relayError(response, fallback));
    }
    return response.json();
}

export function cloudImageError(file) {
    if (!file?.size) return '请选择有效图片';
    if (file.size > KV_VALUE_MAX_BYTES) return IMAGE_SIZE_ERROR;
    if (!IMAGE_EXTENSIONS.test(file.name || '') && !IMAGE_MIME.test(file.type || '')) return IMAGE_FORMAT_ERROR;
    return '';
}

export class CloudflareRelayDriver {
    async uploadPrivatePhoto({ endpoint, secret, file, group, token, onProgress, bucketId }) {
        const invalid = cloudImageError(file);
        if (invalid) throw Error(invalid);
        const body = new FormData();
        body.append('file', file);
        body.append('dateLabel', await photoDateLabel(file));
        if (bucketId) body.append('bucketId', bucketId);
        const result = await uploadDraftImage(endpoint, secret, body, onProgress, group, token);
        if (!result.success || !result.id || !result.relPath || !result.path ||
            (bucketId && bucketId !== 'default' && result.bucketId !== bucketId)) {
            throw Error(result.error || '私密图片上传失败');
        }
        return { id: result.id, name: result.name, path: result.relPath, thumb: result.relPath, preview: result.relPath,
            draftPreview: result.path, ...(result.bucketId ? { bucketId: result.bucketId } : {}) };
    }

    /**
     * 构建标准请求头
     * @param {string} secretKey - 访问密码
     */
    _getHeaders(secretKey) {
        return {
            'Content-Type': 'application/json',
            'x-sync-key': (secretKey || '').trim()
        };
    }

    /**
     * 测试中继网关连通性与密码鉴权
     * @param {string} endpoint - Worker 地址
     * @param {string} secretKey - 访问密码
     */
    async ping(endpoint, secretKey) {
        if (!endpoint) return { success: false, msg: 'Worker 地址不可为空' };
        if (!secretKey) return { success: false, msg: '密码不可为空' };

        const cleanUrl = endpoint.trim().replace(/\/+$/, '');
        try {
            const res = await fetch(`${cleanUrl}/api/ping`, {
                headers: this._getHeaders(secretKey)
            });

            if (res.ok) {
                return { success: true, msg: '连接成功，网关在线且密钥匹配' };
            } else {
                let errMsg = `连接失败 (${res.status})`;
                try {
                    const errJson = await res.json();
                    errMsg = errJson.error || errJson.msg || errMsg;
                } catch {
                    const text = await res.text();
                    if (text) errMsg = text;
                }
                return { success: false, msg: errMsg };
            }
        } catch (e) {
            return { success: false, msg: `网络请求失败: ${e.message}` };
        }
    }

    /**
     * 手机端：将记录操作存入云端草稿队列。
     * @param {string} endpoint 
     * @param {string} secretKey 
     * @param {Object} itemPayload - 包含模块名、动作、数据及时间戳
     */
    async push(endpoint, secretKey, itemPayload) {
        if (!endpoint || !secretKey) {
            return { success: false, msg: '未配置中继网关地址或密码' };
        }

        const cleanUrl = endpoint.trim().replace(/\/+$/, '');
        try {
            const body = JSON.stringify(itemPayload);
            if (body.length > KV_VALUE_MAX_BYTES || (body.length * 3 > KV_VALUE_MAX_BYTES &&
                new TextEncoder().encode(body).byteLength > KV_VALUE_MAX_BYTES)) {
                return { success: false, msg: DRAFT_SIZE_ERROR };
            }
            const res = await fetch(`${cleanUrl}/api/drafts/push`, {
                method: 'POST',
                headers: this._getHeaders(secretKey),
                body
            });

            if (res.ok) {
                const data = await res.json();
                return { success: data.success !== false, id: data.id, msg: data.msg };
            } else {
                if (res.status === 404) return { success: false, msg: '请先更新云端同步 Worker' };
                return { success: false, msg: await relayError(res, res.status === 413 ? DRAFT_SIZE_ERROR : `暂存失败 (${res.status})`) };
            }
        } catch (e) {
            return { success: false, msg: `网络错误: ${e.message}` };
        }
    }

    /**
     * 电脑端：拉取云端所有待处理的草稿项 (GET /api/pull)
     * @param {string} endpoint 
     * @param {string} secretKey 
     * @returns {Promise<{success: boolean, items: Array<{key: string, data: any}>, msg?: string}>}
     */
    async pull(endpoint, secretKey) {
        if (!endpoint || !secretKey) {
            return { success: false, items: [], msg: '未配置中继网关信息' };
        }

        const cleanUrl = endpoint.trim().replace(/\/+$/, '');
        try {
            const items = [];
            const media = [];
            const cursors = new Set();
            let cursor = '';
            let offset = 0;
            do {
                const query = new URLSearchParams({ cursor });
                if (offset) query.set('offset', offset);
                const pageKey = query.toString();
                if (cursors.has(pageKey)) throw new Error('云端草稿分页游标重复');
                cursors.add(pageKey);
                const res = await fetch(`${cleanUrl}/api/pull?${pageKey}`, {
                    headers: this._getHeaders(secretKey)
                });
                if (!res.ok) return { success: false, items: [], msg: await relayError(res, `拉取失败 (${res.status})`) };
                const page = await res.json();
                if (!Array.isArray(page?.items)) throw new Error('云端草稿列表无效');
                items.push(...page.items);
                if (Array.isArray(page.media)) media.push(...page.media);
                cursor = page.cursor ?? '';
                offset = page.offset ?? 0;
                if (typeof cursor !== 'string' || !Number.isSafeInteger(offset) || offset < 0) {
                    throw new Error('云端草稿分页游标无效');
                }
            } while (cursor || offset);
            return { success: true, items, media };
        } catch (e) {
            return { success: false, items: [], msg: `请求失败: ${e.message}` };
        }
    }

    /**
     * 电脑端：合并入库完成后，通知云端批量删除草稿 (POST /api/ack)
     * @param {string} endpoint 
     * @param {string} secretKey 
     * @param {Array<string>} keys 
     */
    async ack(endpoint, secretKey, keys = [], media = []) {
        if (!endpoint || !secretKey || !keys.length) return { success: true };

        const cleanUrl = endpoint.trim().replace(/\/+$/, '');
        try {
            for (let start = 0; start < keys.length + media.length; start += 50) {
                const batchMedia = media.slice(start, start + 50);
                const batchKeys = keys.slice(Math.max(0, start - media.length), Math.max(0, start + 50 - media.length));
                const res = await fetch(`${cleanUrl}/api/ack`, {
                    method: 'POST', headers: this._getHeaders(secretKey),
                    body: JSON.stringify({ keys: batchKeys, media: batchMedia })
                });
                if (!res.ok) return { success: false, msg: await relayError(res, `HTTP ${res.status}`) };
            }
            return { success: true };
        } catch (e) {
            console.error('[CloudflareRelay] Ack failed:', e);
            return { success: false, msg: e.message };
        }
    }

    /**
     * 手机端：将图片原图暂存至 KV。
     * @param {string} endpoint 
     * @param {string} secretKey 
     * @param {File|Blob} file 
     * @param {string} category 
     * @returns {Promise<{success: boolean, path?: string, relPath?: string, name?: string, msg?: string}>}
     */
    async uploadFile(endpoint, secretKey, file, category = '_notes', registration = null, onProgress = null, bucketId) {
        const invalid = cloudImageError(file);
        if (invalid) return { success: false, msg: invalid };
        if (!endpoint || !secretKey) {
            return { success: false, msg: '未配置中继网关地址或密码' };
        }

        const formData = new FormData();
        formData.append('file', file);
        formData.append('dateLabel', await photoDateLabel(file, registration?.timestamp));
        formData.append('category', category);
        if (bucketId) formData.append('bucketId', bucketId);
        if (registration) formData.append('registration', JSON.stringify(registration));

        try {
            const data = await uploadDraftImage(endpoint, secretKey, formData, onProgress);
            if (!data.success || !data.path || !data.relPath || (registration && data.draft?.requestId !== registration.requestId) ||
                (bucketId && bucketId !== 'default' && data.bucketId !== bucketId)) {
                return { success: false, msg: data.msg || '上传未返回有效的图片草稿信息' };
            }
            const { path: draftPreview, relPath, name, draft } = data;
            return { success: true, path: relPath, relPath, name, draft, draftPreview,
                ...(data.bucketId ? { bucketId: data.bucketId } : {}) };
        } catch (e) {
            return { success: false, msg: e.message };
        }
    }
}

export const cloudflareRelay = new CloudflareRelayDriver();
