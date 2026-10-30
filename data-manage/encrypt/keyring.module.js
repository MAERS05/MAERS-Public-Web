/**
 * MAERS Keyring Module (keyring.module.js)
 * 职责：管理数据密钥（DEK）的包裹与解包
 *
 * 公开文件：data/crypto-keyring.json（仅含 v、dek_id、pw、media_base）
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
    toB64, fromB64, sha256Hex
} from './crypto.module.js';

const KEYRING_URL = 'data/crypto-keyring.json';
const PW_ITER = 600_000;
const RC_ITER = 100_000;
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆字符 I/O/0/1

let _cache;

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

/** 读取密钥环；不存在或格式无效时返回 null */
export async function loadKeyring(force = false) {
    if (_cache !== undefined && !force) return _cache;
    try {
        const res = await localFetch(canWriteKeyring() ? '/api/crypto/keyring' : KEYRING_URL, { cache: 'no-cache' });
        if (canWriteKeyring() && !res.ok) throw new Error('读取本机密钥环失败，请重启后台或恢复完整备份');
        const data = res.ok ? await res.json() : null;
        _cache = isValidKeyring(data) ? data : null;
    } catch (error) {
        if (canWriteKeyring()) throw error;
        _cache = null;
    }
    return _cache;
}

export function isValidKeyring(k) {
    return !!(k && k.v === 1 && k.dek_id && k.pw?.wrap && k.pw?.salt);
}

/**
 * 保存密钥环（仅本地后端可用）
 * 后端会拒绝 dek_id 不同的覆盖，避免把已加密数据变成不可解
 */
export async function saveKeyring(keyring) {
    keyring.updated = new Date().toISOString();
    const res = await localFetch('/api/crypto/keyring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keyring)
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
        const plain = await decryptRecord(slot.wrap, kek);
        return plain?.k ? fromB64(plain.k) : null;
    } catch {
        return null;
    }
}

async function _dekId(dekRaw) {
    return (await sha256Hex('maers-dek-id|' + toB64(dekRaw))).slice(0, 16);
}

/** 用主密码解出 DEK，密码错误返回 null */
export function unlockWithPassword(keyring, password) {
    return _unwrap(keyring?.pw, password);
}

/** 用恢复码解出 DEK，恢复码错误返回 null */
export function unlockWithRecovery(keyring, code) {
    return _unwrap(keyring?.rc, normalizeRecoveryCode(code));
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
export async function createKeyring(password, mediaBase = '') {
    const dekRaw = randomBytes(32);
    const recoveryCode = generateRecoveryCode();
    const keyring = {
        v: 1,
        dek_id: await _dekId(dekRaw),
        pw: await _wrap(dekRaw, password, PW_ITER),
        rc: await _wrap(dekRaw, normalizeRecoveryCode(recoveryCode), RC_ITER),
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
