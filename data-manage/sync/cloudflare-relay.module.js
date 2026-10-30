/**
 * Cloudflare Relay Driver (cloudflare-relay.module.js)
 * 职责：与 Cloudflare Worker + KV 中继网关进行极速 HTTP 通信
 * 实现手机端 0.1 秒草稿入队、电脑端拉取与确认清空
 * @version 1.0.0
 */

export class CloudflareRelayDriver {
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
     * 手机端：将记录操作极速存入云端暂存队列 (POST /api/push)
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
            const res = await fetch(`${cleanUrl}/api/push`, {
                method: 'POST',
                headers: this._getHeaders(secretKey),
                body: JSON.stringify(itemPayload)
            });

            if (res.ok) {
                const data = await res.json();
                return { success: true, id: data.id };
            } else {
                const err = await res.text();
                return { success: false, msg: `暂存失败 (${res.status}): ${err}` };
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
            const res = await fetch(`${cleanUrl}/api/pull`, {
                headers: this._getHeaders(secretKey)
            });

            if (res.ok) {
                const json = await res.json();
                return { success: true, items: json.items || [] };
            } else {
                return { success: false, items: [], msg: `拉取失败 (${res.status})` };
            }
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
    async ack(endpoint, secretKey, keys = []) {
        if (!endpoint || !secretKey || !keys.length) return { success: true };

        const cleanUrl = endpoint.trim().replace(/\/+$/, '');
        try {
            const res = await fetch(`${cleanUrl}/api/ack`, {
                method: 'POST',
                headers: this._getHeaders(secretKey),
                body: JSON.stringify({ keys })
            });
            return { success: res.ok };
        } catch (e) {
            console.error('[CloudflareRelay] Ack failed:', e);
            return { success: false };
        }
    }

    /**
     * 手机端：将图片直接上传至 Cloudflare R2 存储桶 (POST /api/upload)
     * @param {string} endpoint 
     * @param {string} secretKey 
     * @param {File|Blob} file 
     * @param {string} category 
     * @returns {Promise<{success: boolean, path?: string, relPath?: string, name?: string, msg?: string}>}
     */
    async uploadFile(endpoint, secretKey, file, category = '_notes', scope = 'public') {
        if (!endpoint || !secretKey) {
            return { success: false, msg: '未配置中继网关地址或密码' };
        }

        const cleanUrl = endpoint.trim().replace(/\/+$/, '');
        const formData = new FormData();
        formData.append('file', file);
        formData.append('category', category);
        formData.append('scope', scope);

        // 将密钥同时附加到 URL query string（移动端浏览器可能剥离自定义 Header）
        const uploadUrl = `${cleanUrl}/api/upload?token=${encodeURIComponent((secretKey || '').trim())}`;

        try {
            const res = await fetch(uploadUrl, {
                method: 'POST',
                // 保留 Header 作为主要鉴权，URL token 作为后备（防移动端 Header 剥离）
                headers: {
                    'x-sync-key': (secretKey || '').trim()
                },
                body: formData
            });

            if (res.ok) {
                const data = await res.json();
                return {
                    success: true,
                    path: data.path, // 绝对 CDN URL: https://media.example.com/...
                    relPath: data.relPath, // 相对路径: photos/images/...
                    name: data.name
                };
            } else {
                const err = await res.text();
                return { success: false, msg: `上传失败 (${res.status}): ${err}` };
            }
        } catch (e) {
            return { success: false, msg: `网络错误: ${e.message}` };
        }
    }
}

export const cloudflareRelay = new CloudflareRelayDriver();
