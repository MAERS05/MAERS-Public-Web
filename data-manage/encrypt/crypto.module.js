/**
 * MAERS Crypto Module (crypto.module.js)
 * 职责：基于 Web Crypto API 提供 AES-256-GCM 记录级加密与密钥工具
 *
 * 设计：
 * - 数据密钥（DEK）为随机 256 位密钥，由密钥环（keyring.module.js）用主密码与恢复码分别包裹保存
 * - 主密码 / 恢复码经 PBKDF2 派生包裹密钥（KEK），只用于解开 DEK
 * - 会话中保存的是 DEK（base64，sessionStorage），关闭标签即失效
 * - 加密格式：enc:<ivBase64>.<ciphertextBase64>
 * - 加密记录：{ _enc: "enc:..." } —— 前台过滤此标志直接跳过
 */

// ── 常量 ──
const ALGO          = 'AES-GCM';
const KEY_BITS      = 256;
const PBKDF2_HASH   = 'SHA-256';
// sessionStorage 存储字段名
const SESSION_KEY   = 'maers_crypto_key';
// 加密字符串前缀
const ENC_PREFIX    = 'enc:';
const ENC_SEP       = '.';
// 加密记录的标识字段（前台据此过滤）
export const ENC_FIELD = '_enc';

// ══════════════════════════════════════════════
// 1. 密钥派生 / 导入
// ══════════════════════════════════════════════

/**
 * 从口令（主密码或恢复码）派生包裹密钥 KEK（不可导出）
 * @param {string} secret
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @returns {Promise<CryptoKey>}
 */
export async function deriveWrappingKey(secret, salt, iterations) {
    const base = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH },
        base,
        { name: ALGO, length: KEY_BITS },
        false,
        ['encrypt', 'decrypt']
    );
}

/** 将原始字节导入为数据密钥（不可导出） */
export function importDataKey(rawBytes) {
    return crypto.subtle.importKey('raw', rawBytes, { name: ALGO, length: KEY_BITS }, false, ['encrypt', 'decrypt']);
}

/** 生成随机字节 */
export function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
}

// ══════════════════════════════════════════════
// 2. 加密 / 解密
// ══════════════════════════════════════════════

/**
 * 将 JS 对象加密为 "enc:<iv>.<ct>" 字符串
 * @param {Object} obj - 原始对象
 * @param {CryptoKey} key
 * @returns {Promise<string>}
 */
export async function encryptRecord(obj, key) {
    const iv        = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    const ct        = await crypto.subtle.encrypt({ name: ALGO, iv }, key, plaintext);

    return ENC_PREFIX + toB64(iv) + ENC_SEP + toB64(new Uint8Array(ct));
}

/**
 * 解密 "enc:<iv>.<ct>" 字符串为原始 JS 对象
 * @param {string} encStr
 * @param {CryptoKey} key
 * @returns {Promise<Object|null>} 失败返回 null
 */
export async function decryptRecord(encStr, key) {
    try {
        if (!isEncryptedString(encStr)) return null;
        const body   = encStr.slice(ENC_PREFIX.length);
        const sepIdx = body.indexOf(ENC_SEP);
        if (sepIdx === -1) return null;

        const iv = fromB64(body.slice(0, sepIdx));
        const ct = fromB64(body.slice(sepIdx + 1));

        const plain = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ct);
        return JSON.parse(new TextDecoder().decode(plain));
    } catch (e) {
        console.warn('[Crypto] 解密失败（密钥错误或数据损坏）:', e.message);
        return null;
    }
}

// ══════════════════════════════════════════════
// 3. 记录包装 / 解包
// ══════════════════════════════════════════════

/**
 * 将普通记录包装为加密记录 { _enc: "enc:..." }
 * @param {Object} record
 * @param {CryptoKey} key
 * @returns {Promise<Object>}
 */
export async function wrapRecord(record, key) {
    const encStr = await encryptRecord(record, key);
    return { [ENC_FIELD]: encStr };
}

/**
 * 解包加密记录 { _enc: "enc:..." } 为原始对象
 * @param {Object} encRecord
 * @param {CryptoKey} key
 * @returns {Promise<Object|null>}
 */
export async function unwrapRecord(encRecord, key) {
    return decryptRecord(encRecord[ENC_FIELD], key);
}

// ══════════════════════════════════════════════
// 4. 判断工具
// ══════════════════════════════════════════════

/** 判断字符串是否为加密格式 */
export function isEncryptedString(str) {
    return typeof str === 'string' && str.startsWith(ENC_PREFIX);
}

/**
 * 判断记录是否为加密记录（含 _enc 字段）
 * 前台用此函数过滤，返回 true 则不渲染
 */
export function isEncryptedRecord(record) {
    return record !== null &&
           typeof record === 'object' &&
           ENC_FIELD in record;
}

// ══════════════════════════════════════════════
// 5. 会话密钥管理（sessionStorage）
// ══════════════════════════════════════════════

/**
 * 从 sessionStorage 恢复会话密钥（DEK）
 * @returns {Promise<CryptoKey|null>}
 */
export async function getSessionKey() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        return await importDataKey(fromB64(raw));
    } catch {
        return null;
    }
}

/** 读取会话 DEK 的原始字节（用于改密码时重新包裹），无会话返回 null */
export function getSessionKeyRaw() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? fromB64(raw) : null;
}

/** 将 DEK 原始字节存入会话 */
export function setSessionKeyRaw(rawBytes) {
    sessionStorage.setItem(SESSION_KEY, toB64(rawBytes));
}

/** 清除会话密钥（退出加密会话） */
export function clearSessionKey() {
    sessionStorage.removeItem(SESSION_KEY);
}

// ══════════════════════════════════════════════
// 5.1 私密资源访问令牌（用于 Worker 校验，Worker 不接触主密码）
// ══════════════════════════════════════════════

const ACCESS_TOKEN_SALT = 'maers-private-access-v1|';

/** 计算字符串的 SHA-256 十六进制摘要 */
export async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 跨 Python/浏览器一致的结构摘要，用于防止旧快照覆盖新数据。 */
export function fingerprintRecord(value) {
    const stable = item => Array.isArray(item) ? item.map(stable)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(k => [k, stable(item[k])])) : item;
    return sha256Hex(JSON.stringify(stable(value)));
}

/**
 * 由会话 DEK 派生私密资源访问令牌：hex(SHA-256(salt + DEK base64))
 * DEK 不随主密码变化，因此修改主密码后令牌与 Worker 配置均无需更新
 * @returns {Promise<string|null>} 无会话密钥时返回 null
 */
export async function getAccessToken() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return sha256Hex(ACCESS_TOKEN_SALT + raw);
}

/** 令牌的哈希（同步到 Worker，Worker 只保存哈希） */
export async function getAccessTokenHash() {
    const t = await getAccessToken();
    return t ? sha256Hex(t) : null;
}

/** 在提交新密钥环前计算新媒体令牌摘要，不改变当前会话。 */
export async function accessTokenHashForRaw(rawBytes) {
    return sha256Hex(await sha256Hex(ACCESS_TOKEN_SALT + toB64(rawBytes)));
}

// ══════════════════════════════════════════════
// 编码工具
// ══════════════════════════════════════════════

export function toB64(bytes) {
    let s = '';
    // 分段拼接，避免大数组展开超出调用栈
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

export function fromB64(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
