/**
 * MAERS Keyring Module (keyring.module.js)
 * 职责：管理数据密钥（DEK）的包裹与解包
 *
 * 公开文件：data/crypto-keyring.json，包含密码槽与主密码加密的密码组密钥槽。
 * 本机完整密钥环：_studio/.local/crypto-keyring.json，经鉴权接口读取，包含 rc、updated。
 * {
 *   "v": 1,
 *   "dek_id": "16 位十六进制，用于防止误覆盖为另一把密钥",
 *   "pw": { "salt": b64, "iter": 600000, "wrap": "enc:..." },   // 主密码包裹的 DEK
 *   "rc": { "salt": b64, "iter": 100000, "wrap": "enc:..." },   // 恢复码包裹的 DEK
 *   "media_base": "私密图片 Worker 地址",
 *   "updated": "ISO 时间"
 * }
 *
 * 公开文件只包含包裹后的 DEK；仍需强主密码抵抗离线猜测。
 * 主密码包裹强度取决于主密码本身；随机恢复码对应的密钥槽仅保留在本机。
 */
import { localFetch } from '../api-client.module.js';

import {
    deriveWrappingKey, encryptRecord, decryptRecord, randomBytes,
    toB64, fromB64, sha256Hex, DEFAULT_GROUP, fingerprintRecord, importDataKey, getSessionKeyRaw
} from './crypto.module.js';

const KEYRING_URL = 'data/crypto-keyring.json';
const PW_ITER = 600_000;
const RC_ITER = 100_000;
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆字符 I/O/0/1
const GROUP_NAME_ORDER = new Intl.Collator('zh-CN-u-co-pinyin', { sensitivity: 'base', numeric: true });

let _cache;

/** 表单沿用已读取的密钥环模式，记录打包无需额外联网。 */
export function isMasterOnlyKeyring() { return _cache?.master_only === true; }

/** 是否为本地后台（只有本地后台能写入密钥环文件） */
export function canWriteKeyring() {
    const host = window.location.hostname;
    const isLocal = ['localhost', '127.0.0.1', '[::1]', ''].includes(host) ||
        /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host);
    const isAdmin = window.IS_ADMIN === true ||
        new URLSearchParams(window.location.search).get('mode') === 'admin' ||
        /admin/i.test(window.location.pathname);
    return isLocal && isAdmin;
}

// ══════════════════════════════════════════════
// 1. 读取 / 保存
// ══════════════════════════════════════════════

/** 读取密钥环；请求取消时保留已有缓存。 */
export async function loadKeyring(force = false, { signal } = {}) {
    if (signal?.aborted) return null;
    if (_cache !== undefined && !force) return _cache;
    try {
        const res = await localFetch(canWriteKeyring() ? '/api/crypto/keyring' : KEYRING_URL, { cache: 'no-cache', signal });
        if (canWriteKeyring() && !res.ok) throw new Error('读取本机密钥环失败，请重启后台或恢复完整备份');
        const data = res.ok ? await res.json() : null;
        if (signal?.aborted) return null;
        _cache = isValidKeyring(data) ? data : null;
    } catch (error) {
        if (signal?.aborted) return null;
        if (canWriteKeyring()) throw error;
        _cache = null;
    }
    return _cache;
}

export function isValidKeyring(k) {
    return !!(k && k.v === 1 && k.dek_id && k.pw?.wrap && k.pw?.salt &&
        (k.master_only === undefined || typeof k.master_only === 'boolean') &&
        (!k.content || k.master_only === true && k.content.v === 1 && k.content.dek_id &&
            k.content.pw?.salt && k.content.pw?.wrap && k.content.master_wrap &&
            k.content.wraps && typeof k.content.wraps === 'object' &&
            Object.keys(k.content.wraps).length === Object.keys(k.groups || {}).length &&
            Object.keys(k.groups || {}).every(id => typeof k.content.wraps[id] === 'string')) &&
        (!k.groups || (typeof k.groups === 'object' && !Array.isArray(k.groups) &&
        Object.entries(k.groups).every(([id, group]) => /^[a-zA-Z0-9_-]{1,64}$/.test(id) &&
            id !== DEFAULT_GROUP && group?.dek_id && group.pw?.wrap && group.pw?.salt &&
            (!k.master_only || typeof group.master_wrap === 'string' && group.master_wrap.startsWith('enc:'))))));
}

/** 组名统一按 A–Z（中文拼音）排列，旧默认组仅供存量密文迁移。 */
export function passwordGroups(ring) {
    if (!ring) return [];
    const groups = Object.entries(ring.groups || {}).map(([id, group]) => ({ ...group, id }));
    if (!ring.master_only) groups.unshift({ ...ring, groups: undefined, id: DEFAULT_GROUP, name: ring.name || '旧默认组' });
    return groups.sort((a, b) => GROUP_NAME_ORDER.compare(a.name || '', b.name || '') || a.id.localeCompare(b.id));
}

export function groupKeyring(ring, id = DEFAULT_GROUP) {
    return id === DEFAULT_GROUP ? ring : ring?.groups?.[id] || null;
}

export function updateGroup(ring, id, group) {
    if (id === DEFAULT_GROUP) return { ...ring, ...group };
    return { ...ring, groups: { ...ring.groups, [id]: group } };
}

/** 已接入主密码的组由本机直接重设密码，只保留旧未接入组的迁移恢复槽。 */
function cleanGroupRecovery(ring) {
    if (!ring?.groups) return ring;
    const groups = Object.fromEntries(Object.entries(ring.groups).map(([id, value]) => {
        if (!value.master_wrap) return [id, value];
        const { rc, ...group } = value;
        return [id, group];
    }));
    return { ...ring, groups };
}

/**
 * 保存密钥环（仅本地后端可用）
 * 后端会拒绝 dek_id 不同的覆盖，避免把已加密数据变成不可解
 */
export async function saveKeyring(keyring, previous = _cache, { masterRaw = getSessionKeyRaw() } = {}) {
    const expected = previous ? await fingerprintRecord(cleanGroupRecovery(previous)) : null;
    keyring = cleanGroupRecovery(keyring);
    if (keyring.content) keyring = await refreshContentAccess(keyring, masterRaw);
    keyring = { ...keyring, updated: new Date().toISOString() };
    const res = await localFetch('/api/crypto/keyring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...keyring, _expected: expected })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    _cache = keyring;
    return true;
}

// ══════════════════════════════════════════════
// 2. 包裹 / 解包
// ══════════════════════════════════════════════

async function _wrap(dekRaw, secret, iter) {
    const salt = randomBytes(16);
    const kek = await deriveWrappingKey(secret, salt, iter);
    return { salt: toB64(salt), iter, wrap: await encryptRecord({ k: toB64(dekRaw) }, kek) };
}

async function _unwrap(slot, secret) {
    if (!slot || !secret) return null;
    try {
        const kek = await deriveWrappingKey(secret, fromB64(slot.salt), slot.iter);
        const plain = await decryptRecord(slot.wrap, kek, { silent: true });
        return plain?.k ? fromB64(plain.k) : null;
    } catch {
        return null;
    }
}

async function _dekId(dekRaw) {
    return (await sha256Hex('maers-dek-id|' + toB64(dekRaw))).slice(0, 16);
}

export async function matchesDataKey(keyring, raw) {
    return raw?.byteLength === 32 && (await _dekId(raw)) === keyring?.dek_id;
}

/** 用密码或恢复码解出该组 DEK，并校验密钥身份。 */
export async function unlockWithPassword(keyring, password) {
    const raw = await _unwrap(keyring?.pw, password);
    return (await matchesDataKey(keyring, raw)) ? raw : null;
}

export async function unlockWithRecovery(keyring, code) {
    const raw = await _unwrap(keyring?.rc, normalizeRecoveryCode(code));
    return (await matchesDataKey(keyring, raw)) ? raw : null;
}

/** 主密钥单向包裹独立组的密钥，凭独立组密码只能取得该组密钥。 */
export async function wrapMasterGroup(id, group, raw, masterKey) {
    if (!(await matchesDataKey(group, raw))) throw new Error('密码组密钥已变化，请重新验证');
    return encryptRecord({ purpose: 'master-group-v1', group: id, k: toB64(raw) }, masterKey);
}

/** 副密码使用独立密钥，只包裹内容组，永不包裹管理主密钥。 */
export async function createContentAccess(ring, password, masterRaw) {
    if (!ring.master_only) throw Error('请先将旧默认组内容迁入自建组');
    if (await unlockWithPassword(ring, password)) throw Error('副密码不能与主密码相同');
    const { keyring, dekRaw } = await createKeyring(password, '', { recovery: false });
    const { v, dek_id, pw } = keyring;
    const master_wrap = await wrapMasterGroup('content', keyring, dekRaw, await importDataKey(masterRaw));
    return refreshContentAccess({ ...ring, content: { v, dek_id, pw, master_wrap, wraps: {} } }, masterRaw);
}

/** 保存组配置时同步副密码的解锁范围，新建组也自动纳入。 */
export async function refreshContentAccess(ring, masterRaw) {
    if (!await matchesDataKey(ring, masterRaw)) throw Error('管理密钥已变化，请重新载入本地后台');
    const linked = await unwrapMasterGroups({ groups: { content: ring.content } }, masterRaw);
    const key = await importDataKey(linked.get('content'));
    const wraps = {};
    for (const [id, raw] of await unwrapMasterGroups(ring, masterRaw)) {
        wraps[id] = await wrapMasterGroup(id, ring.groups[id], raw, key);
    }
    return { ...ring, content: { ...ring.content, wraps } };
}

/** 副密码只能还原各内容组，返回值不含后台管理密钥。 */
export async function unwrapContentGroups(ring, raw) {
    if (!await matchesDataKey(ring.content, raw)) throw Error('副密码密钥不匹配');
    const groups = Object.fromEntries(Object.entries(ring.groups || {}).map(([id, group]) =>
        [id, { ...group, master_wrap: ring.content.wraps[id] }]));
    return unwrapMasterGroups({ groups }, raw);
}

/** 旧密码组没有主密码槽，接入后才参与主密码解锁。 */
export async function unwrapMasterGroups(ring, masterRaw) {
    const keys = new Map();
    const masterKey = await importDataKey(masterRaw);
    for (const [id, group] of Object.entries(ring.groups || {})) {
        if (!group.master_wrap) continue;
        const slot = await decryptRecord(group.master_wrap, masterKey, { silent: true });
        const raw = slot?.purpose === 'master-group-v1' && slot.group === id &&
            typeof slot.k === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(slot.k)
            ? fromB64(slot.k) : null;
        if (!(await matchesDataKey(group, raw))) throw new Error(`「${group.name}」的主密码密钥无法读取，请检查密钥环备份`);
        keys.set(id, raw);
    }
    return keys;
}

// ══════════════════════════════════════════════
// 3. 创建 / 修改
// ══════════════════════════════════════════════

/** 生成恢复码：32 位（160 bit），每 4 位一组 */
export function generateRecoveryCode() {
    const bytes = randomBytes(32);
    let s = '';
    for (const b of bytes) s += RC_ALPHABET[b % RC_ALPHABET.length];
    return s.match(/.{4}/g).join('-');
}

/** 规范化恢复码（忽略大小写、空格、横线） */
export function normalizeRecoveryCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * 创建新密钥环：随机 DEK + 主密码包裹 + 恢复码包裹
 * @returns {Promise<{keyring:Object, recoveryCode:string, dekRaw:Uint8Array}>}
 */
export async function createKeyring(password, mediaBase = '', { recovery = true } = {}) {
    const dekRaw = randomBytes(32);
    const recoveryCode = recovery ? generateRecoveryCode() : null;
    const keyring = {
        v: 1,
        dek_id: await _dekId(dekRaw),
        pw: await _wrap(dekRaw, password, PW_ITER),
        ...(recovery ? { rc: await _wrap(dekRaw, normalizeRecoveryCode(recoveryCode), RC_ITER) } : {}),
        media_base: mediaBase || '',
        updated: ''
    };
    return { keyring, recoveryCode, dekRaw };
}

/** 更换主密码：仅重新包裹 DEK，所有已加密数据无需改动 */
export async function rewrapPassword(keyring, dekRaw, newPassword) {
    if ((await _dekId(dekRaw)) !== keyring.dek_id) throw new Error('密钥不匹配');
    return { ...keyring, pw: await _wrap(dekRaw, newPassword, PW_ITER) };
}

/** 更新当前恢复槽；历史密钥环的访问撤销需执行完整数据密钥轮换。 */
export async function regenerateRecovery(keyring, dekRaw) {
    if ((await _dekId(dekRaw)) !== keyring.dek_id) throw new Error('密钥不匹配');
    const recoveryCode = generateRecoveryCode();
    return {
        keyring: { ...keyring, rc: await _wrap(dekRaw, normalizeRecoveryCode(recoveryCode), RC_ITER) },
        recoveryCode
    };
}

/** 私密图片 Worker 地址（密钥环中配置） */
export async function getMediaBase() {
    const k = await loadKeyring();
    return (k?.media_base || '').replace(/\/+$/, '');
}
