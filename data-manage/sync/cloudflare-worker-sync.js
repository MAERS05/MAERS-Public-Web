/**
 * 同步 Worker：KV 草稿和已发布媒体读取。
 * 绑定 MAERS_SYNC_KV（或 KV），设置 SECRET_KEY。
 * 公私桶、附加桶组和读图域名的配置见项目部署说明。
 */

const TOKEN_KV_KEY = 'private_token_hash';
const TOKEN_OBJECT_KEY = '_maers/private-token.json';
const DRAFT_TTL = 60 * 60 * 24 * 30;
const KV_VALUE_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_SIZE_ERROR = '图片草稿超过 KV 单文件 25 MiB 上限，请压缩图片或在电脑本地后台上传';
const DRAFT_IMAGE_PREFIX = 'sync_media_';
const PULL_PAGE_SIZE = 20;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_UPLOAD_PREFIX = 'photos/images/_cloud_private/';
const DEFAULT_BUCKET = 'default';
const BUCKET_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const IMAGE_TYPES = Object.freeze({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif',
    gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif'
});
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const B2_S3_ENDPOINT = /^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com$/;
const R2_S3_ENDPOINT = /^https:\/\/([0-9a-f]{32})(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/;
const validGroup = group => typeof group === 'string' && (group === 'default' || /^g_[0-9a-f]{32}$/.test(group));

/** 计算字符串 SHA-256 十六进制摘要 */
async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getKv(env) {
    return env.MAERS_SYNC_KV || env.KV;
}

/** 从私有存储读取当前令牌，不缓存旧凭据；KV 仅用于兼容首次迁移。 */
async function getTokenHash(env, group) {
    const fromEnv = group === 'default' ? (env.PRIVATE_TOKEN_HASH || '').trim().toLowerCase() : '';
    if (fromEnv) return fromEnv;
    const object = await readMetadata(env, group === 'default' ? TOKEN_OBJECT_KEY : `_maers/private-tokens/${group}.json`);
    if (object) {
        const data = await new Response(object.body).json();
        return /^[0-9a-f]{64}$/.test(data.hash) ? data.hash : '';
    }
    if (group !== 'default') return '';
    const kv = getKv(env);
    return kv ? ((await draftKv(kv, 'get', TOKEN_KV_KEY)) || '').trim().toLowerCase() : '';
}

/** 错误正文最多读取 4 KiB，仅保留 S3 错误码，避免记录凭据或对象路径。 */
async function s3RequestError(response, method, provider) {
    const reader = response.body?.getReader();
    let text = '';
    if (reader) {
        const decoder = new TextDecoder();
        let size = 0;
        try {
            while (size < 4096) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = value.subarray(0, 4096 - size);
                size += chunk.byteLength;
                text += decoder.decode(chunk, { stream: true });
            }
        } catch { /* 正文读取失败时仍保留上游状态码。 */ }
        finally { await reader.cancel().catch(() => {}); }
    }
    return Object.assign(new Error('S3 media request failed'), {
        name: provider === 'b2' ? 'B2MediaError' : 'R2MediaError',
        upstream: { provider, method, status: response.status,
            code: /<Code>([A-Za-z0-9_.-]{1,80})<\/Code>/.exec(text)?.[1] || undefined }
    });
}

function s3Target(settings) {
    if (typeof settings === 'string') {
        try { settings = JSON.parse(settings); }
        catch { throw new Error('Invalid S3 media configuration'); }
    }
    const { provider, endpoint_url, bucket_name: bucket, access_key_id: keyId, secret_access_key: secret } = settings || {};
    const endpoint = typeof endpoint_url === 'string' ? endpoint_url.replace(/\/+$/, '') : '';
    const isB2 = provider === 'b2';
    const match = isB2 ? B2_S3_ENDPOINT.exec(endpoint) : provider === 'r2' && R2_S3_ENDPOINT.exec(endpoint);
    const bucketName = isB2 ? /^[a-zA-Z0-9-]{6,63}$/ : /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
    if (!match || typeof bucket !== 'string' || !bucketName.test(bucket) ||
        typeof keyId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(keyId.trim()) ||
        typeof secret !== 'string' || !secret.trim()) {
        throw new Error('Invalid S3 media configuration');
    }
    const target = isB2 ? `b2:${bucket.toLowerCase()}` : `r2:${match[1]}/${bucket}`;
    return { provider, endpoint, bucket, keyId: keyId.trim(), secret: secret.trim(),
        region: isB2 ? match[1] : 'auto', target };
}

/** B2 和 R2 共用 S3 Signature V4，图片上传保持流式传输。 */
function s3Bucket({ provider, endpoint, region, bucket, keyId, secret }) {
    const encoder = new TextEncoder();
    const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    const hmac = async (key, value) => {
        const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return crypto.subtle.sign('HMAC', imported, encoder.encode(value));
    };
    const encode = value => encodeURIComponent(value).replace(/[!'()*]/g,
        character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
    const send = async (method, key, body, options = {}) => {
        if (typeof key !== 'string' || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) {
            throw new Error('Invalid S3 media key');
        }
        const url = new URL(`${endpoint}/${bucket}/${key.split('/').map(encode).join('/')}`);
        const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
        const scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`;
        const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
        const canonical = `${method}\n${url.pathname}\n\nhost:${url.host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${date}\n\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
        const digest = hex(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
        const dayKey = await hmac(encoder.encode('AWS4' + secret), date.slice(0, 8));
        const regionKey = await hmac(dayKey, region);
        const serviceKey = await hmac(regionKey, 's3');
        const signingKey = await hmac(serviceKey, 'aws4_request');
        const signature = hex(await hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest}`));
        const headers = new Headers({
            'x-amz-date': date, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
            Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
        });
        if (options.httpMetadata?.contentType) headers.set('Content-Type', options.httpMetadata.contentType);
        if (options.httpMetadata?.cacheControl) headers.set('Cache-Control', options.httpMetadata.cacheControl);
        // 签名绑定 HTTP 方法；绕过边缘缓存，防止 HEAD 在回源时变成 GET。
        const response = await fetch(url.toString(), { method, headers, body, redirect: 'manual', cache: 'no-store' });
        if (response.status === 404 && ['GET', 'HEAD'].includes(method)) {
            await response.body?.cancel();
            return null;
        }
        if (!response.ok) {
            throw await s3RequestError(response, method, provider);
        }
        if (method === 'PUT') {
            await response.body?.cancel();
            return;
        }
        return { body: response.body, httpEtag: response.headers.get('etag') || '',
            writeHttpMetadata(target) {
                for (const name of ['content-type', 'content-length', 'content-encoding']) {
                    const value = response.headers.get(name);
                    if (value) target.set(name, value);
                }
            } };
    };
    return { get: key => send('GET', key), head: key => send('HEAD', key),
        put: (key, body, options) => send('PUT', key, body, options) };
}

function defaultS3Targets(env) {
    if (env.MEDIA_PUBLIC_S3 !== undefined || env.MEDIA_PRIVATE_S3 !== undefined) {
        return [s3Target(env.MEDIA_PUBLIC_S3), s3Target(env.MEDIA_PRIVATE_S3)];
    }
    if (env.B2_ENDPOINT) {
        return [env.B2_PUBLIC_BUCKET, env.B2_PRIVATE_BUCKET].map(bucket => s3Target({
            provider: 'b2', endpoint_url: env.B2_ENDPOINT, bucket_name: bucket,
            access_key_id: env.B2_KEY_ID, secret_access_key: env.B2_APPLICATION_KEY
        }));
    }
    return null;
}

function bucketGroups(env) {
    const groups = new Map();
    if (env.MEDIA_BUCKET_GROUPS === undefined) return groups;
    const config = JSON.parse(env.MEDIA_BUCKET_GROUPS);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid bucket groups');
    const primary = defaultS3Targets(env);
    if (Object.keys(config).length && !primary) throw new Error('Bucket groups require default S3 buckets');
    const seen = new Set(primary?.map(target => target.target));
    for (const [id, pair] of Object.entries(config)) {
        if (id === DEFAULT_BUCKET || !BUCKET_ID.test(id)) throw new Error('Invalid bucket group ID');
        const targets = [s3Target(pair?.public), s3Target(pair?.private)];
        for (const target of targets) {
            if (seen.has(target.target)) throw new Error('Storage buckets must be separate');
            seen.add(target.target);
        }
        groups.set(id, { targets, signature: targets.map(target => target.target).join('|') });
    }
    return groups;
}

/** 媒体存储适配：S3 兼容桶、R2 绑定或独立 HTTPS 文件网关。 */
function mediaBucket(env, privateScope, group = null) {
    const targets = group?.targets || defaultS3Targets(env);
    if (targets) {
        if (targets[0].target === targets[1].target) throw new Error('Media buckets must be separate');
        return s3Bucket(targets[Number(privateScope)]);
    }
    if (!env.MEDIA_GATEWAY_URL) return privateScope ? env.PRIVATE_PHOTOS_BUCKET : env.PUBLIC_PHOTOS_BUCKET;
    const base = String(env.MEDIA_GATEWAY_URL).replace(/\/+$/, '');
    if (!base.startsWith('https://') || !env.MEDIA_GATEWAY_TOKEN) throw new Error('Invalid media gateway configuration');
    const scope = privateScope ? 'private' : 'public';
    const send = async (method, key, body, options = {}) => {
        const path = key.split('/').map(encodeURIComponent).join('/');
        const response = await fetch(`${base}/objects/${scope}/${path}`, {
            method, body, redirect: 'manual', headers: {
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

async function routeKey(key) {
    if (key.startsWith('markdown/')) {
        return `_maers/content-buckets/${await sha256Hex(key)}.json`;
    }
    return `_maers/photo-buckets/${await sha256Hex(key)}.json`;
}

async function readMetadata(env, key) {
    return mediaBucket(env, true)?.get(key) || null;
}

async function objectGroup(env, groups, key) {
    if (!groups.size) return null;
    const object = await readMetadata(env, await routeKey(key));
    if (!object) return null;
    const record = await new Response(object.body).json();
    const group = groups.get(record.bucketId);
    if (!group || group.signature !== record.target) throw new Error('Object bucket configuration changed');
    return group;
}

function imageResponse(object, isHead, baseHeaders) {
    const headers = new Headers(baseHeaders);
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(isHead ? null : object.body, { headers });
}

/** 只返回公开桶中的三级图片，路径组件按单段解码。 */
async function handlePublicMedia(request, env, url, groups) {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const empty = status => new Response(null, { status, headers: { ...cors, 'Cache-Control': 'no-store' } });
    let parts;
    try { parts = url.pathname.slice(1).split('/').map(part => decodeURIComponent(part)); }
    catch { return empty(404); }
    const [, size, category, name] = parts;
    const type = IMAGE_TYPES[name?.split('.').pop().toLowerCase()];
    if (parts.length !== 4 || !['images', 'previews', 'thumbnails'].includes(size) ||
        !validMediaComponent(category) || category.toLowerCase() === '_cloud_private' ||
        !validMediaComponent(name) || !name.includes('.') || typeof type !== 'string') return empty(404);

    const key = parts.join('/');
    const bucket = mediaBucket(env, false, await objectGroup(env, groups, key));
    if (!bucket) return empty(500);
    const isHead = request.method === 'HEAD';
    const object = isHead ? await bucket.head(key) : await bucket.get(key);
    if (!object) return empty(404);
    const response = imageResponse(object, isHead, cors);
    response.headers.set('Content-Type', type);
    response.headers.delete('Content-Disposition');
    return response;
}

function validContentKey(key) {
    const parts = key.split('/');
    return parts[0] === 'markdown' && parts[1] !== 'private' &&
        parts.length >= 3 && key.endsWith('.md') &&
        parts.every(part => part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f]/.test(part));
}

async function handlePublicContent(request, env, url, groups) {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache',
        'Content-Type': 'text/markdown; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
    let key;
    try { key = decodeURIComponent(url.pathname.slice(1)); }
    catch { return new Response(null, { status: 404, headers }); }
    if (!validContentKey(key)) return new Response(null, { status: 404, headers });
    const bucket = mediaBucket(env, false, await objectGroup(env, groups, key));
    if (!bucket) return new Response(null, { status: 500, headers });
    const head = request.method === 'HEAD';
    const object = await (head ? bucket.head(key) : bucket.get(key));
    if (!object) return new Response(null, { status: 404, headers });
    return new Response(head ? null : object.body, { headers });
}

/** 处理私密图片请求（令牌鉴权，位于同步密码鉴权之前） */
async function handlePrivateMedia(request, env, url, corsHeaders, groups) {
    const deny = (status, msg) => new Response(msg, { status, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
    const group = url.searchParams.get('g') || 'default';
    if (!validGroup(group)) return deny(400, 'Bad group');
    const expect = await getTokenHash(env, group);
    if (!expect) return deny(500, 'Token hash not configured');

    const token = (url.searchParams.get('t') || '').trim();
    if (!token || (await sha256Hex(token)) !== expect) return deny(403, 'Forbidden');

    let key;
    try { key = decodeURIComponent(url.pathname.slice('/private/'.length)); }
    catch { return deny(400, 'Bad key'); }
    const isPhoto = /^photos\/(images|previews|thumbnails)\/[^/]+\/[^/]+$/.test(key);
    const isMarkdown = validContentKey(key);
    if (!isMarkdown && (!isPhoto || key.includes('..') || key.includes('\\'))) return deny(400, 'Bad key');
    const isHead = request.method === 'HEAD';
    if (key.startsWith(PRIVATE_UPLOAD_PREFIX) && url.searchParams.has('draft')) {
        const image = await readDraftImage(getKv(env), key);
        if (!image) return deny(404, '图片草稿已过期或已合并');
        if (image.metadata.group !== group) {
            await image.value.cancel();
            return deny(403, 'Forbidden');
        }
        return await draftImageResponse(image, corsHeaders, isHead);
    }
    if (!mediaBucket(env, true)) return deny(500, 'Private media store not configured');
    const destination = await objectGroup(env, groups, key);
    const digest = await sha256Hex(key);
    const policy = (isMarkdown && await readMetadata(env, `_maers/content-groups/${digest}.json`)) ||
        await readMetadata(env, `_maers/media-groups/${digest}.json`);
    if (policy) {
        const allowed = await new Response(policy.body).json();
        if (allowed.key !== key || !Array.isArray(allowed.groups) || !allowed.groups.includes(group)) return deny(403, 'Forbidden');
    } else if (group !== 'default' || key.startsWith(PRIVATE_UPLOAD_PREFIX) || (isMarkdown && destination)) {
        return deny(403, 'Forbidden');
    }

    const bucket = mediaBucket(env, true, destination);
    const object = isHead
        ? await bucket.head(key)
        : await bucket.get(key);
    if (!object) return deny(404, 'Not Found');

    if (isMarkdown) {
        return new Response(isHead ? null : object.body, {
            status: 200,
            headers: {
                ...corsHeaders,
                'Content-Type': 'text/markdown; charset=utf-8',
                'Cache-Control': 'no-store'
            }
        });
    }
    return imageResponse(object, isHead, corsHeaders);
}

const KV_CONFIG_ERROR = 'Worker 未绑定 KV：请在 Cloudflare 后台「绑定」中添加 KV 命名空间（变量名设为 MAERS_SYNC_KV 或 KV）';

class DraftKvLimit extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

async function draftKv(kv, operation, ...args) {
    try {
        return await kv[operation](...args);
    } catch (error) {
        const message = String(error?.message || '');
        const status = Number(error?.status ?? message.match(/\bKV [A-Z]+ failed:\s*(\d{3})\b/)?.[1]);
        if (status === 507 || /(?:storage|namespace|account).{0,40}(?:full|size limit|storage limit|capacity)/i.test(message)) {
            throw new DraftKvLimit('KV 草稿空间已满，请在电脑合并草稿释放空间后重试', 507);
        }
        if (status === 413 || /value.{0,40}(?:too large|size limit|25\s*MiB)/i.test(message)) {
            throw new DraftKvLimit('云端草稿超过 KV 单条 25 MiB 上限，请在电脑本地后台保存', 413);
        }
        const action = { get: '读取', getWithMetadata: '读取', list: '列出', put: '写入', delete: '删除' }[operation];
        if (/daily|per day|quota exceeded/i.test(message)) {
            throw new DraftKvLimit(`KV 今日${action}额度已用完，免费版额度在北京时间 08:00 重置`, 429);
        }
        if (status === 429 || /too many requests|rate limit/i.test(message)) {
            throw new DraftKvLimit(`KV ${action}达到频率或额度限制，请稍后重试。若免费版当日额度已用完，请在北京时间 08:00 重置后再试`, 429);
        }
        if (status === 403) throw new DraftKvLimit(`KV 拒绝${action}，请在 Cloudflare 控制台检查 KV 用量和绑定`, 503);
        throw error;
    }
}

const utf8Bytes = value => new TextEncoder().encode(value).byteLength;

function jsonResponse(value, status, headers) {
    return new Response(JSON.stringify(value), {
        status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
}

function corsHeaders(request) {
    return {
        'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-sync-key, x-private-media-token',
        'Access-Control-Max-Age': '86400'
    };
}

function authorizeSync(request, env, json) {
    const secret = (env.SECRET_KEY || '').trim();
    if (!secret) return json({
        error: 'Worker 未检测到密码配置：请在 Cloudflare 控制台 Settings -> Variables and Secrets 中添加环境变量 SECRET_KEY 并填入密码'
    }, 500);
    const clientKey = (request.headers.get('x-sync-key') || '').trim();
    return !clientKey || clientKey !== secret ? json({ error: 'Unauthorized: 密码不匹配' }, 401) : null;
}

async function handlePing({ env, kv, json }) {
    return json({
        status: 'ok', msg: 'Connected successfully', kv_ready: Boolean(kv),
        public_r2_ready: Boolean(mediaBucket(env, false)),
        private_r2_ready: Boolean(mediaBucket(env, true)),
        password_groups_version: 1, private_token_ready: Boolean(await getTokenHash(env, 'default'))
    });
}

async function handlePrivateToken({ request, env, url, json }) {
    const group = url.searchParams.get('g') || 'default';
    if (!validGroup(group)) return json({ error: '密码组编号无效' }, 400);
    if (request.method === 'GET') return json({
        hash: await getTokenHash(env, group),
        source: group === 'default' && (env.PRIVATE_TOKEN_HASH || '').trim() ? 'env' : 'storage'
    });
    const bucket = mediaBucket(env, true);
    if (!bucket) return json({ error: '尚未配置私有媒体存储' }, 500);
    const { hash } = await request.json();
    const clean = String(hash || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(clean)) return json({ error: '令牌哈希格式错误' }, 400);
    const key = group === 'default' ? TOKEN_OBJECT_KEY : `_maers/private-tokens/${group}.json`;
    await bucket.put(key, JSON.stringify({ hash: clean }), {
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' }
    });
    return json({ success: true, overridden_by_env: group === 'default' && Boolean((env.PRIVATE_TOKEN_HASH || '').trim()) });
}

/** 相同请求写同一个键，即使响应丢失或两次写入交错也只占一个队列位置。 */
async function putDraftOnce(kv, payload, existing, encoded = JSON.stringify(payload)) {
    const key = `sync_request_${payload.requestId}`;
    if (existing === undefined) existing = await draftKv(kv, 'get', key, 'json');
    if (existing) return JSON.stringify(existing) === encoded;
    const bytes = encoded.length < 16384 ? encoded.length * 3 : utf8Bytes(encoded);
    if (bytes > KV_VALUE_MAX_BYTES) {
        throw new DraftKvLimit('云端草稿超过 KV 单条 25 MiB 上限，请在电脑本地后台保存', 413);
    }
    await draftKv(kv, 'put', key, encoded, { expirationTtl: DRAFT_TTL, metadata: { bytes } });
    return true;
}

function validRequest({ requestId, timestamp } = {}) {
    return typeof requestId === 'string' && REQUEST_ID.test(requestId) &&
        Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 8640000000000000;
}

function validPrivateDraft({ action, data }) {
    return action === 'replace' && data && Object.keys(data).sort().join(',') === 'enc,group,revision,source' &&
        ['notes', 'literature', 'record', 'games', 'videos', 'album'].includes(data.source) && validGroup(data.group) &&
        typeof data.revision === 'string' && /^[0-9a-f]{64}$/.test(data.revision) &&
        typeof data.enc === 'string' &&
        /^enc:[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(data.enc);
}

async function handleDraftPush({ request, kv, json }) {
    if (!kv) return json({ error: KV_CONFIG_ERROR }, 500);
    if (Number(request.headers.get('content-length')) > KV_VALUE_MAX_BYTES) {
        return json({ error: '云端草稿超过 KV 单条 25 MiB 上限，请在电脑本地后台保存' }, 413);
    }
    const payload = await request.json();
    if (!payload || !validRequest(payload) || typeof payload.module !== 'string' ||
        typeof payload.action !== 'string' || !payload.data || typeof payload.data !== 'object') {
        return json({ error: '草稿请求格式无效' }, 400);
    }
    const { module, action, data, timestamp, requestId } = payload;
    if (module === 'photos' && action === 'upload') return json({ error: '请使用图片草稿上传入口' }, 400);
    if (module === 'private' && !validPrivateDraft(payload)) {
        return json({ error: '私密草稿格式无效' }, 400);
    }
    if (!await putDraftOnce(kv, { module, action, data, timestamp, requestId })) {
        return json({ error: '草稿编号已用于另一项操作' }, 409);
    }
    return json({ success: true, id: requestId });
}

async function handlePull({ kv, json, url }) {
    if (!kv) return json({ error: KV_CONFIG_ERROR }, 500);
    const items = [];
    const media = [];
    let bytes = 0;
    const paged = url.searchParams.has('cursor');
    let offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset >= PULL_PAGE_SIZE) {
        return json({ error: '草稿分页位置无效' }, 400);
    }
    let cursor = url.searchParams.get('cursor') || undefined;
    // 旧客户端仍可一次拉取，新客户端通过游标分摊存储查询。
    do {
        const page = await draftKv(kv, 'list', { prefix: 'sync_', cursor, limit: PULL_PAGE_SIZE });
        for (let i = offset; i < page.keys.length; i++) {
            const key = page.keys[i];
            if (key.name.startsWith(DRAFT_IMAGE_PREFIX)) {
                if (key.metadata?.key) media.push([key.metadata.key, previewUrl(url, key.metadata)]);
                continue;
            }
            // 大正文分开返回，避免一页累积多个接近 25 MiB 的草稿。
            const size = key.metadata?.bytes ?? KV_VALUE_MAX_BYTES;
            if (items.length && bytes + size > KV_VALUE_MAX_BYTES) {
                return json({ success: true, items, media, cursor: cursor || '', offset: i });
            }
            const data = await draftKv(kv, 'get', key.name, 'json');
            if (!data) continue;
            items.push({ key: key.name, data });
            bytes += size;
        }
        cursor = page.list_complete === false && page.cursor ? page.cursor : undefined;
        offset = 0;
    } while (!paged && cursor);
    return json({ success: true, items, media, ...(cursor ? { cursor } : {}) });
}

async function handleAck({ request, kv, json }) {
    if (!kv) return json({ error: KV_CONFIG_ERROR }, 500);
    const { keys, media = [] } = await request.json();
    if (!Array.isArray(keys) || !Array.isArray(media) ||
        keys.some(key => typeof key !== 'string' || !key.startsWith('sync_request_')) ||
        media.some(key => !validDraftImageKey(key))) {
        return json({ error: '草稿确认格式无效' }, 400);
    }
    if (keys.length + media.length > 50) return json({ error: '每次最多确认 50 个 KV 项目' }, 400);
    for (const path of media) await draftKv(kv, 'delete', await draftImageKey(path));
    for (const key of keys) await draftKv(kv, 'delete', key);
    return json({ success: true, deleted: keys.length });
}

/** 只读取文件头，按实际图片类型决定扩展名与响应类型。 */
async function imageFormat(file) {
    const bytes = await file.slice(0, 64).arrayBuffer();
    const header = String.fromCharCode(...new Uint8Array(bytes));
    if (header.startsWith('\xff\xd8\xff')) return 'jpg';
    if (header.startsWith('\x89PNG\r\n\x1a\n')) return 'png';
    if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'gif';
    if (header.startsWith('BM')) return 'bmp';
    if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'webp';
    if (header.slice(4, 8) !== 'ftyp' || bytes.byteLength < 16) return '';

    const major = header.slice(8, 12);
    if (major === 'avif' || major === 'avis') return 'avif';
    if (HEIC_BRANDS.has(major)) return 'heic';
    if (major !== 'mif1' && major !== 'msf1') return '';

    const end = Math.min(new DataView(bytes).getUint32(0), bytes.byteLength);
    const brands = [];
    for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(header.slice(offset, offset + 4));
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
    return brands.some(brand => HEIC_BRANDS.has(brand)) ? 'heic' : 'heif';
}

function uploadName(file, format, id = crypto.randomUUID(), timestamp = Date.now(), dateLabel = '') {
    const extension = file.name.split('.').pop().toLowerCase();
    const now = new Date(timestamp);
    const pad = value => String(value).padStart(2, '0');
    const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    // 保留 JPEG 与 HEIF 家族的原扩展名，已有请求重试时继续使用同一键。
    const matches = IMAGE_TYPES[extension] === IMAGE_TYPES[format] ||
        (/^hei[cf]$/.test(extension) && /^hei[cf]$/.test(format));
    const ext = matches ? extension : format;
    return `${dateLabel || `${day}_${time}`}_${id.replace(/-/g, '')}.${ext}`;
}

/** 图片路径组件沿用本地登记的文件名边界。 */
function validMediaComponent(value) {
    return typeof value === 'string' && Boolean(value) && value === value.trim() &&
        !value.includes('..') && !value.endsWith('.') && !/[\\/:*?"<>|\x00-\x1f]/.test(value) &&
        !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value.split('.')[0]);
}

function photoBucket(env, scope) {
    const settings = JSON.parse(env.MEDIA_PHOTO_BUCKETS || '{}');
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('Invalid photo bucket settings');
    }
    return settings[scope] ?? DEFAULT_BUCKET;
}

function validDraftImageKey(key) {
    if (typeof key !== 'string') return false;
    const [root, size, category, name, ...rest] = key.split('/');
    return !rest.length && root === 'photos' && size === 'images' &&
        validMediaComponent(category) && validMediaComponent(name) &&
        Object.hasOwn(IMAGE_TYPES, name.split('.').pop().toLowerCase());
}

async function draftImageKey(path) {
    return DRAFT_IMAGE_PREFIX + await sha256Hex(path);
}

async function readDraftImage(kv, path) {
    if (!kv || !validDraftImageKey(path)) return null;
    const image = await draftKv(kv, 'getWithMetadata', await draftImageKey(path), 'stream');
    if (!image.value) return null;
    if (image.metadata?.key === path) return image;
    await image.value.cancel();
    return null;
}

async function draftImageResponse(image, headers, isHead = false) {
    const { type, size, bucketId, bucketTarget } = image.metadata;
    if (isHead) await image.value.cancel();
    return new Response(isHead ? null : image.value, { headers: {
        ...headers, 'Content-Type': type, 'X-Maers-Image-Size': String(size),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'X-Maers-Bucket': bucketId, ...(bucketTarget ? { 'X-Maers-Bucket-Target': bucketTarget } : {})
    } });
}

function previewUrl(url, metadata) {
    const path = metadata.key.split('/').map(encodeURIComponent).join('/');
    return metadata.group ? `${url.origin}/private/${path}?draft=1` :
        `${url.origin}/api/drafts/preview/${path}?p=${metadata.previewToken}`;
}

async function handleDraftImageRead({ request, env, kv, json, url, headers }) {
    if (!kv) return json({ error: KV_CONFIG_ERROR }, 500);
    const path = url.searchParams.get('path');
    if (!validDraftImageKey(path)) return json({ error: '图片草稿路径无效' }, 400);
    const group = url.searchParams.get('g');
    if (path.startsWith(PRIVATE_UPLOAD_PREFIX)) {
        if (!validGroup(group) || !await canReadDraftGroup(request, env, group)) {
            return json({ error: '请在电脑解锁图片所属密码组，并确认已同步该组的图片令牌' }, 403);
        }
    } else if (group) {
        return json({ error: '图片草稿不属于此密码组' }, 403);
    }
    const image = await readDraftImage(kv, path);
    if (!image) return json({ code: 'draft_image_missing', error: '图片草稿暂不可用，可能尚未同步到当前节点或已超过 30 天' }, 404);
    if ((image.metadata.group || null) !== group) {
        await image.value.cancel();
        return json({ error: '图片草稿不属于此密码组' }, 403);
    }
    return draftImageResponse(image, headers);
}

async function handleDraftPreview(request, kv, url, headers) {
    const missing = status => new Response(null, { status, headers: { ...headers, 'Cache-Control': 'no-store' } });
    const token = url.searchParams.get('p');
    if (!REQUEST_ID.test(token || '')) return missing(404);
    let path;
    try { path = decodeURIComponent(url.pathname.slice('/api/drafts/preview/'.length)); }
    catch { return missing(404); }
    if (path.startsWith(PRIVATE_UPLOAD_PREFIX)) return missing(404);
    const image = await readDraftImage(kv, path);
    if (!image) return missing(404);
    if (image.metadata.group || image.metadata.previewToken !== token) {
        await image.value.cancel();
        return missing(404);
    }
    return draftImageResponse(image, headers, request.method === 'HEAD');
}

async function canReadDraftGroup(request, env, group) {
    const token = request.headers.get('x-private-media-token') || '';
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const expected = await getTokenHash(env, group);
    return Boolean(expected) && await sha256Hex(token) === expected;
}

async function handleDraftUpload({ request, env, json, kv, url, groups }) {
    if (!kv) return json({ error: KV_CONFIG_ERROR }, 500);
    const group = url.searchParams.get('g');
    if (group !== null && (!validGroup(group) || !await canReadDraftGroup(request, env, group))) {
        return json({ error: '请解锁密码组，并在电脑端同步该组的图片令牌' }, 403);
    }
    // 表单还有文件名和登记信息，按原图的实际字节数执行 KV 上限。
    if (Number(request.headers.get('content-length')) > KV_VALUE_MAX_BYTES + 1024 * 1024) {
        return json({ error: IMAGE_SIZE_ERROR }, 413);
    }
    const form = await request.formData().catch(() => null);
    if (!form) return json({ error: '图片上传表单无效' }, 400);
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) return json({ error: '请选择有效图片' }, 400);
    if (file.size > KV_VALUE_MAX_BYTES) return json({ error: IMAGE_SIZE_ERROR }, 413);
    const format = await imageFormat(file);
    if (!format) return json({ error: '不支持该图片格式' }, 415);

    const category = group ? '_cloud_private' : form.get('category') || '_notes';
    if (!validMediaComponent(category) || (!group && /^(?:private|_cloud_private$)/i.test(category))) {
        return json({ error: '图片分类无效，私密图片请从已解锁的密码组上传' }, 400);
    }
    const raw = form.get('registration');
    let registration = null;
    if (raw !== null) {
        try { registration = JSON.parse(raw); } catch { /* 下方统一校验 */ }
        if (group || !registration || !validRequest(registration) || !Array.isArray(registration.tags) ||
            registration.tags.some(tag => typeof tag !== 'string')) {
            return json({ error: '图片登记请求无效' }, 400);
        }
    }

    const existing = registration ? await draftKv(kv, 'get', `sync_request_${registration.requestId}`, 'json') : null;
    const id = registration?.requestId || crypto.randomUUID();
    const dateLabel = form.get('dateLabel') || '';
    if (dateLabel && !/^\d{8}_\d{6}$/.test(dateLabel)) return json({ error: '图片时间格式无效' }, 400);
    const name = existing?.data?.name || (group && !dateLabel ? `${id}.${format}` :
        uploadName(file, format, id, registration?.timestamp, dateLabel));
    const key = `photos/images/${category}/${name}`;
    const previous = registration ? await readDraftImage(kv, key) : null;
    if (previous) await previous.value.cancel();
    const bucketId = form.get('bucketId') || existing?.data?.bucketId || previous?.metadata.bucketId ||
        photoBucket(env, group ? 'private' : 'public');
    const target = groups.get(bucketId);
    if (bucketId !== DEFAULT_BUCKET && !target) return json({ error: '未知的存储桶代号，请同步 Worker 的桶组配置' }, 400);
    if (!group && target && env.PUBLIC_MEDIA_READS !== 'true') {
        return json({ error: '发布到附加桶组需要启用 Worker 的公开读图入口' }, 503);
    }
    const placement = { bucketId, ...(target ? { bucketTarget: target.signature } : {}) };
    const draft = registration && { module: 'photos', action: 'upload',
        data: { category, path: key, name, scope: 'public', tags: registration.tags, ...placement },
        timestamp: registration.timestamp, requestId: id };
    if ((existing && JSON.stringify(existing) !== JSON.stringify(draft)) ||
        (previous && (previous.metadata.bucketId !== bucketId ||
            previous.metadata.bucketTarget !== placement.bucketTarget || previous.metadata.size !== file.size))) {
        return json({ error: '图片草稿编号已用于另一项操作，请使用原图片与桶组重试' }, 409);
    }
    const metadata = previous?.metadata || { key, type: IMAGE_TYPES[format], size: file.size, ...placement,
        ...(group ? { group } : { previewToken: crypto.randomUUID() }) };
    if (utf8Bytes(JSON.stringify(metadata)) > 1024) {
        return json({ error: '图片分类或桶组信息超过 KV 元数据上限，请缩短分类名称' }, 413);
    }
    if (!previous) {
        await draftKv(kv, 'put', await draftImageKey(key), file.stream(), { expirationTtl: DRAFT_TTL, metadata });
    }
    if (draft && !await putDraftOnce(kv, draft, existing)) {
        return json({ error: '图片草稿编号已用于另一项操作' }, 409);
    }
    return json({ success: true, id, name, relPath: key, path: previewUrl(url, metadata),
        ...(draft ? { draft } : {}), ...(target ? { bucketId } : {}) });
}

const ROUTES = Object.freeze({
    'GET /api/storage/buckets': ({ groups, json }) => json({ buckets: [DEFAULT_BUCKET, ...groups.keys()] }),
    'GET /api/ping': handlePing,
    'GET /api/private-token': handlePrivateToken,
    'POST /api/private-token': handlePrivateToken,
    'POST /api/drafts/push': handleDraftPush,
    'GET /api/pull': handlePull,
    'POST /api/ack': handleAck,
    'POST /api/drafts/upload': handleDraftUpload,
    'GET /api/drafts/media': handleDraftImageRead
});

export default {
    async fetch(request, env) {
        const headers = corsHeaders(request);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
        const url = new URL(request.url);
        const json = (value, status = 200) => jsonResponse(value, status, headers);
        try {
            const groups = bucketGroups(env);
            if (request.method === 'GET' || request.method === 'HEAD') {
                if (url.pathname.startsWith('/api/drafts/preview/')) return await handleDraftPreview(request, getKv(env), url, headers);
                if (url.pathname.startsWith('/private/')) return await handlePrivateMedia(request, env, url, headers, groups);
                if (env.PUBLIC_MEDIA_READS === 'true' && url.pathname.startsWith('/photos/')) {
                    return await handlePublicMedia(request, env, url, groups);
                }
                if (env.PUBLIC_CONTENT_READS === 'true') {
                    // B2 下载域名的 URL 改写先于 Worker 执行，读取前还原正文逻辑路径。
                    const prefix = env.PUBLIC_CONTENT_PATH_PREFIX || '';
                    if (prefix && url.pathname.startsWith(`${prefix}/markdown/`)) {
                        url.pathname = url.pathname.slice(prefix.length);
                    }
                    if (url.pathname.startsWith('/markdown/')) return await handlePublicContent(request, env, url, groups);
                }
            }
            const denied = authorizeSync(request, env, json);
            if (denied) return denied;
            const handler = ROUTES[`${request.method} ${url.pathname}`];
            if (!handler) return json({ error: 'Endpoint Not Found' }, 404);
            return await handler({ request, env, url, headers, json, kv: getKv(env), groups });
        } catch (error) {
            if (error instanceof DraftKvLimit) return json({ error: error.message }, error.status);
            // 统一失败响应，不将存储凭据、内部路径或异常正文返回客户端。
            console.error('[MAERS.Sync] 请求处理失败', { method: request.method, error: error?.name || 'Error',
                upstream: ['B2MediaError', 'R2MediaError'].includes(error?.name) ? error.upstream : undefined,
                frames: error?.stack?.split('\n').slice(1, 4).map(frame => frame.trim()) });
            return jsonResponse({ error: 'Worker 请求处理失败，请稍后重试' }, 500,
                { ...headers, 'Cache-Control': 'no-store' });
        }
    }
};
