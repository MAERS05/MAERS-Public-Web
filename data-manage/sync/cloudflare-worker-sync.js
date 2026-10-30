/**
 * Cloudflare Worker: your-sync-worker
 * 
 * 职责：
 * 1. 跨端极速中继网关：手机端 0.1 秒存入 KV，电脑端拉取合并
 * 2. 移动端富媒体直传：手机端上传图片直接存入 Cloudflare R2，免去 Python 后端与 Vercel 构建
 * 3. 公开/私密多桶支持：解耦公开图片桶与私密图片桶，支持未来私有加密资产扩展
 * 
 * Cloudflare 控制台绑定要求：
 * 1. KV 命名空间绑定 (Settings -> Variables and Secrets -> KV Namespace Bindings):
 *    - Variable name: MAERS_SYNC_KV
 *    - KV namespace: 选择您创建的 MAERS_SYNC_KV
 * 
 * 2. R2 存储桶绑定 (Settings -> Variables and Secrets -> R2 Bucket Bindings):
 *    - 公开图片桶 (当前):
 *      - Variable name: PUBLIC_PHOTOS_BUCKET
 *      - R2 bucket: 选择 your-public-bucket
 *    - 私密图片桶 (未来创建后绑定):
 *      - Variable name: PRIVATE_PHOTOS_BUCKET
 *      - R2 bucket: 选择您的私密存储桶 (如 your-private-bucket)
 * 
 * 3. 环境变量 (Settings -> Variables and Secrets -> Environment Variables):
 *    - SECRET_KEY: 您的同步访问密码 (必须设置)
 *    - PUBLIC_CUSTOM_DOMAIN: https://media.example.com（示例，请填写自己的域名；默认使用相对路径）
 *    - PRIVATE_TOKEN_HASH: 可选。一般无需手动设置——后台「🛡️ 加密设置 → 同步令牌到 Worker」
 *      会自动写入 KV（键 private_token_hash）。若设置了该变量，则以变量为准
 *
 * 4. 私密图片访问 (访客侧)：GET /private/<r2key>?t=<令牌>
 *    - Worker 仅比对 sha256(令牌) 与令牌哈希，不接触主密码与数据密钥
 *    - 图片地址前缀保存在 data/crypto-keyring.json 的 media_base，默认即本 Worker 的 workers.dev 地址
 *
 * 5. 令牌哈希管理 (需 SECRET_KEY)：GET/POST /api/private-token  body: { hash }
 */

const TOKEN_KV_KEY = 'private_token_hash';
const TOKEN_OBJECT_KEY = '_maers/private-token.json';

/** 计算字符串 SHA-256 十六进制摘要 */
async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getKv(env) {
    return env.MAERS_SYNC_KV || env.KV || env.SYNC_KV;
}

/** 从私有存储读取当前令牌，不缓存旧凭据；KV 仅用于兼容首次迁移。 */
async function getTokenHash(env) {
    const fromEnv = (env.PRIVATE_TOKEN_HASH || '').trim().toLowerCase();
    if (fromEnv) return fromEnv;
    const bucket = mediaBucket(env, true);
    if (bucket?.get) {
        const object = await bucket.get(TOKEN_OBJECT_KEY);
        if (object) {
            const data = await new Response(object.body).json();
            return /^[0-9a-f]{64}$/.test(data.hash) ? data.hash : '';
        }
    }
    const kv = getKv(env);
    return kv ? ((await kv.get(TOKEN_KV_KEY)) || '').trim().toLowerCase() : '';
}

/** 媒体存储适配：保留 R2 绑定，也可连接独立的 HTTPS 文件网关。 */
function mediaBucket(env, privateScope) {
    if (!env.MEDIA_GATEWAY_URL) return privateScope ? env.PRIVATE_PHOTOS_BUCKET
        : (env.PUBLIC_PHOTOS_BUCKET || env.PHOTOS_BUCKET);
    const base = String(env.MEDIA_GATEWAY_URL).replace(/\/+$/, '');
    if (!base.startsWith('https://') || !env.MEDIA_GATEWAY_TOKEN) throw new Error('Invalid media gateway configuration');
    const scope = privateScope ? 'private' : 'public';
    const send = async (method, key, body, options = {}) => {
        const path = key.split('/').map(encodeURIComponent).join('/');
        const response = await fetch(`${base}/objects/${scope}/${path}`, {
            method, body, redirect: 'error', headers: {
                Authorization: `Bearer ${env.MEDIA_GATEWAY_TOKEN}`,
                'Content-Type': options.httpMetadata?.contentType || 'application/octet-stream'
            }
        });
        if (response.status === 404 && ['GET', 'HEAD'].includes(method)) return null;
        if (!response.ok) throw new Error('Media gateway request failed');
        return { body: response.body, httpEtag: response.headers.get('etag') || '',
            writeHttpMetadata(headers) {
                const type = response.headers.get('content-type');
                if (type) headers.set('Content-Type', type);
            } };
    };
    return { get: key => send('GET', key), head: key => send('HEAD', key),
        put: (key, body, options) => send('PUT', key, body, options) };
}

/** 处理私密图片请求（令牌鉴权，位于同步密码鉴权之前） */
async function handlePrivateMedia(request, env, url, corsHeaders) {
    const deny = (status, msg) => new Response(msg, { status, headers: corsHeaders });
    const bucket = mediaBucket(env, true);
    if (!bucket) return deny(500, 'Private media store not configured');
    const expect = await getTokenHash(env);
    if (!expect) return deny(500, 'Token hash not configured');

    const token = (url.searchParams.get('t') || '').trim();
    if (!token || (await sha256Hex(token)) !== expect) return deny(403, 'Forbidden');

    const key = decodeURIComponent(url.pathname.slice('/private/'.length));
    if (!key || key.includes('..')) return deny(400, 'Bad key');

    const isHead = request.method === 'HEAD';
    const object = isHead
        ? await bucket.head(key)
        : await bucket.get(key);
    if (!object) return deny(404, 'Not Found');

    const headers = new Headers(corsHeaders);
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'no-store');
    return new Response(isHead ? null : object.body, { headers });
}

export default {
    async fetch(request, env, ctx) {
        // 允许跨域
        const origin = request.headers.get('Origin') || '*';
        const corsHeaders = {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, x-sync-key',
            'Access-Control-Max-Age': '86400',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        // 私密图片：令牌鉴权，先于同步密码校验
        if (path.startsWith('/private/') && (request.method === 'GET' || request.method === 'HEAD')) {
            return handlePrivateMedia(request, env, url, corsHeaders);
        }

        // 统一密码鉴权
        const serverSecret = (env.SECRET_KEY || env.SYNC_SECRET || env.secret_key || env.SECRET || '').trim();
        if (!serverSecret) {
            return new Response(JSON.stringify({
                error: 'Worker 未检测到密码配置：请在 Cloudflare 控制台 Settings -> Variables and Secrets 中添加环境变量 SECRET_KEY 并填入密码'
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const clientKey = (request.headers.get('x-sync-key') || url.searchParams.get('token') || '').trim();
        if (!clientKey || clientKey !== serverSecret) {
            return new Response(JSON.stringify({ error: 'Unauthorized: 密码不匹配' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const kv = getKv(env);
        const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
            status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

        try {
            // 1. GET /api/ping (连通性测试)
            if (path === '/api/ping' && request.method === 'GET') {
                return json({
                    status: 'ok',
                    msg: 'Connected successfully',
                    kv_ready: Boolean(kv),
                    public_r2_ready: Boolean(mediaBucket(env, false)),
                    private_r2_ready: Boolean(mediaBucket(env, true)),
                    private_token_ready: Boolean(await getTokenHash(env))
                });
            }

            // 1.5 GET/POST /api/private-token (私密图片令牌哈希)
            if (path === '/api/private-token') {
                if (request.method === 'GET') {
                    return json({
                        hash: await getTokenHash(env),
                        source: (env.PRIVATE_TOKEN_HASH || '').trim() ? 'env' : 'storage'
                    });
                }
                if (request.method === 'POST') {
                    const bucket = mediaBucket(env, true);
                    if (!bucket) return json({ error: '尚未配置私有媒体存储' }, 500);
                    const { hash } = await request.json();
                    const clean = String(hash || '').trim().toLowerCase();
                    if (!/^[0-9a-f]{64}$/.test(clean)) return json({ error: '令牌哈希格式错误' }, 400);
                    await bucket.put(TOKEN_OBJECT_KEY, JSON.stringify({ hash: clean }), {
                        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' }
                    });
                    return json({
                        success: true,
                        overridden_by_env: Boolean((env.PRIVATE_TOKEN_HASH || '').trim())
                    });
                }
            }

            // 2. POST /api/push (手机端暂存入队)
            if (path === '/api/push' && request.method === 'POST') {
                if (!kv) {
                    return new Response(JSON.stringify({
                        error: 'Worker 未绑定 KV：请在 Cloudflare 后台「绑定」中添加 KV 命名空间（变量名设为 MAERS_SYNC_KV 或 KV）'
                    }), {
                        status: 500,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }

                const payload = await request.json();
                const id = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                const key = `sync_${payload.module || 'data'}_${id}`;

                await kv.put(key, JSON.stringify(payload), {
                    expirationTtl: 60 * 60 * 24 * 30 // 30天有效
                });

                return new Response(JSON.stringify({ success: true, id }), {
                    status: 200,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }

            // 3. GET /api/pull (电脑端拉取未合并草稿)
            if (path === '/api/pull' && request.method === 'GET') {
                if (!kv) {
                    return new Response(JSON.stringify({
                        error: 'Worker 未绑定 KV：请在 Cloudflare 后台「绑定」中添加 KV 命名空间（变量名设为 MAERS_SYNC_KV 或 KV）'
                    }), {
                        status: 500,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }

                const list = await kv.list({ prefix: 'sync_' });
                const items = [];
                for (const k of list.keys) {
                    const val = await kv.get(k.name, 'json');
                    if (val) {
                        items.push({ key: k.name, data: val });
                    }
                }
                return new Response(JSON.stringify({ success: true, items }), {
                    status: 200,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }

            // 4. POST /api/ack (电脑端合并入库后清除 KV)
            if (path === '/api/ack' && request.method === 'POST') {
                if (!kv) {
                    return new Response(JSON.stringify({ error: 'Worker 未绑定 KV' }), {
                        status: 500,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }

                const body = await request.json();
                const keys = body.keys || [];
                for (const k of keys) {
                    await kv.delete(k);
                }
                return new Response(JSON.stringify({ success: true, deleted: keys.length }), {
                    status: 200,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }

            // 5. POST /api/upload (手机端直传图片至 Cloudflare R2，支持公私桶分流)
            if (path === '/api/upload' && request.method === 'POST') {
                const formData = await request.formData();
                const file = formData.get('file');
                const category = formData.get('category') || '_notes';
                const scope = (formData.get('scope') || 'public').toLowerCase(); // 'public' | 'private'

                const isPrivate = scope === 'private' || category.startsWith('private');
                const targetBucket = mediaBucket(env, isPrivate);

                if (!targetBucket) {
                    const missingVar = isPrivate ? 'PRIVATE_PHOTOS_BUCKET' : 'PUBLIC_PHOTOS_BUCKET';
                    return new Response(JSON.stringify({
                        success: false,
                        msg: `Cloudflare Worker 尚未绑定对应存储桶 (变量名需为 ${missingVar})`
                    }), {
                        status: 500,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }

                if (!file || !(file instanceof File)) {
                    return new Response(JSON.stringify({ success: false, msg: 'No file received' }), {
                        status: 400,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }

                // 与本地上传一致：时间前缀 + UUID，避免并发及混合扩展名复用编号。
                const originalName = file.name || 'image.jpg';
                const ext = originalName.includes('.') ? originalName.split('.').pop().toLowerCase() : 'jpg';
                const now = new Date();
                const YYYY = now.getFullYear();
                const MM = String(now.getMonth() + 1).padStart(2, '0');
                const DD = String(now.getDate()).padStart(2, '0');
                const HH = String(now.getHours()).padStart(2, '0');
                const mm = String(now.getMinutes()).padStart(2, '0');
                const ss = String(now.getSeconds()).padStart(2, '0');
                const uploadId = crypto.randomUUID().replace(/-/g, '');
                const safeName = `${YYYY}${MM}${DD}_${HH}${mm}${ss}_${uploadId}.${ext}`;

                const r2Key = `photos/images/${category}/${safeName}`;
                const contentType = file.type || 'application/octet-stream';

                // 将二进制数据写入对应存储桶（arrayBuffer 兼容性优于 stream）
                await targetBucket.put(r2Key, await file.arrayBuffer(), {
                    httpMetadata: { contentType }
                });

                let fullUrl = '';
                if (!isPrivate) {
                    const customDomain = (env.MEDIA_PUBLIC_BASE || env.PUBLIC_CUSTOM_DOMAIN || env.CUSTOM_DOMAIN || '').replace(/\/+$/, '');
                    fullUrl = `${customDomain}/${r2Key}`;
                } else {
                    // 私密图片不暴露公开域名，返回凭证代理地址
                    fullUrl = `/api/private-file?key=${encodeURIComponent(r2Key)}`;
                }

                return new Response(JSON.stringify({
                    success: true,
                    isPrivate,
                    path: fullUrl,
                    relPath: r2Key,
                    name: safeName
                }), {
                    status: 200,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }

            // 6. GET /api/private-file (私密图片鉴权拉取，预留扩展)
            if (path === '/api/private-file' && request.method === 'GET') {
                const bucket = mediaBucket(env, true);
                if (!bucket) {
                    return new Response('Private bucket not configured', { status: 500 });
                }
                const key = url.searchParams.get('key');
                if (!key) return new Response('Missing key parameter', { status: 400 });

                const object = await bucket.get(key);
                if (!object) return new Response('File Not Found', { status: 404 });

                const headers = new Headers(corsHeaders);
                object.writeHttpMetadata(headers);
                headers.set('etag', object.httpEtag);
                return new Response(object.body, { headers });
            }

            return new Response(JSON.stringify({ error: 'Endpoint Not Found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });

        } catch (e) {
            return new Response(JSON.stringify({ error: e.message || String(e) }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    }
};
