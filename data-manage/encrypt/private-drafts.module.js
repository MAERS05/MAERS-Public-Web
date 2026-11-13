/** 云端私密草稿：只在管理会话内解包，按原密文版本提交同组的新密文。 */
import { isOnlineAdminPage } from '../api-client.module.js';
import { encryptRecord, getSessionKey, getSessionKeyRaw, isEncryptedRecord, sha256Hex, unwrapRecord } from './crypto.module.js';
import { canonicalJson, byTimestamp } from '../sync/relay-actions.module.js';

export { isOnlineAdminPage as isCloudPrivateAdmin };

export async function requireCloudAdmin() {
    if (!isOnlineAdminPage()) throw Error('请在线上后台编辑私密内容');
    const { ensureOnlineAdminEntry } = await import('./admin-session.module.js');
    await ensureOnlineAdminEntry();
    if (!getSessionKeyRaw()) throw Error('请先验证主密码');
}

export function hasPrivateEditorState(value) {
    return Boolean(value && typeof value === 'object' && (value._private === true ||
        value._cloudEnvelope || Object.values(value).some(hasPrivateEditorState)));
}

/** 遍历公开结构中最外层的密文，保留封装字段及位置。 */
function* envelopes(value) {
    if (isEncryptedRecord(value)) yield value;
    else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) yield* envelopes(child);
    }
}

export function hasPrivateEnvelopes(value) {
    return !envelopes(value).next().done;
}

/** 按顺序套用同组、同基线的密文；冲突项由电脑合并时报告。 */
export async function replayPrivateDrafts(source, value, items) {
    const drafts = byTimestamp(items).filter(item => item.module === 'private' &&
        item.action === 'replace' && item.data?.source === source);
    if (!drafts.length) return;
    const slots = new Map();
    for (const item of envelopes(value)) {
        const key = (item._group || 'default') + ':' + await sha256Hex(item._enc);
        slots.set(key, slots.has(key) ? null : item);
    }
    for (const { data } of drafts) {
        const key = data.group + ':' + data.revision;
        const item = slots.get(key);
        if (!item || typeof data.enc !== 'string' || !data.enc.startsWith('enc:')) continue;
        const next = data.group + ':' + await sha256Hex(data.enc);
        slots.delete(key);
        item._enc = data.enc;
        slots.set(next, slots.has(next) ? null : item);
    }
}

class PrivateDraft {
    constructor(source, envelope, payload, enqueue) {
        this.source = source;
        this.group = envelope._group || 'default';
        this.envelope = { ...envelope };
        this.payload = payload;
        this.enqueue = enqueue;
        this.pending = Promise.resolve();
        this.retry = null;
    }

    /** 同一记录的并发改动依次应用，失败的同一份内容重试时复用原密文。 */
    edit(change) {
        const job = this.pending.then(() => this._edit(change));
        this.pending = job.catch(() => {});
        return job;
    }

    async _edit(change) {
        await requireCloudAdmin();
        const key = await getSessionKey(this.group);
        if (!key) throw Error('请先解锁内容所属的密码组');
        const next = structuredClone(this.payload);
        const result = await change(next);
        const serialized = canonicalJson(next);
        if (serialized === canonicalJson(this.payload)) return result;
        const revision = await sha256Hex(this.envelope._enc);
        const enc = this.retry?.serialized === serialized && this.retry.revision === revision
            ? this.retry.enc : await encryptRecord(next, key);
        this.retry = { serialized, revision, enc };
        if (!(await getSessionKey(this.group)) || !getSessionKeyRaw()) throw Error('解锁状态已变化，请重新解锁');
        const saved = await this.enqueue({ source: this.source, group: this.group, revision, enc });
        if (!saved.success) throw Error(saved.msg || '私密修改暂存失败');
        this.envelope._enc = enc;
        this.payload = next;
        this.retry = null;
        return result;
    }
}

/** 解包已解锁记录，未知组与损坏的密文保持占位。 */
export async function openPrivateDrafts(source, value, items, enqueue) {
    const drafts = new Map();
    if (!hasPrivateEnvelopes(value)) return drafts;
    await requireCloudAdmin();
    await replayPrivateDrafts(source, value, items);
    for (const envelope of envelopes(value)) {
        const key = await getSessionKey(envelope._group);
        const payload = key ? await unwrapRecord(envelope, key) : null;
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            drafts.set(envelope, new PrivateDraft(source, envelope, payload, enqueue));
        }
    }
    return drafts;
}

/** 音乐和空间的编辑视图。快照保存前使用同一组密钥重新封装。 */
export class PrivateDocument {
    constructor(children) {
        this.children = children;
        this.entries = new Map();
        this.locked = new Map();
        this.next = 0;
    }

    async open(nodes, parent = '') {
        const result = [];
        for (const envelope of nodes) {
            let node = envelope;
            let scope = parent;
            if (isEncryptedRecord(envelope)) {
                const key = await getSessionKey(envelope._group);
                const plain = key && await unwrapRecord(envelope, key);
                if (!plain) {
                    this.locked.set(envelope._enc, parent);
                    result.push(envelope);
                    continue;
                }
                scope = String(++this.next);
                this.entries.set(scope, { envelope, plain, parent });
                node = { ...plain, _cloudEnvelope: scope };
            } else node = { ...node };
            node._cloudScope = scope;
            if (scope) {
                node._private = true;
                node._private_group = this.entries.get(scope).envelope._group || 'default';
            }
            for (const field of this.children) {
                if (Array.isArray(node[field])) node[field] = await this.open(node[field], scope);
            }
            result.push(node);
        }
        return result;
    }

    async seal(nodes) {
        const used = new Set();
        const result = await this._seal(nodes, '', used);
        for (const cipher of this.locked.keys()) {
            if (!used.has(cipher)) throw Error('此操作包含未解锁内容，请先解锁对应密码组');
        }
        for (const [scope, { envelope }] of this.entries) {
            if (!used.has(scope) && !await getSessionKey(envelope._group)) {
                throw Error('请先解锁内容所属的密码组');
            }
        }
        return result;
    }

    async _seal(nodes, parent, used) {
        const result = [];
        for (const node of nodes) {
            if (isEncryptedRecord(node)) {
                if (this.locked.get(node._enc) !== parent) throw Error('加密范围已改变，请在电脑本地后台操作');
                used.add(node._enc);
                result.push(node);
                continue;
            }
            const scope = node._cloudEnvelope || parent;
            const entry = node._cloudEnvelope && this.entries.get(scope);
            if ((node._cloudEnvelope && !entry) || (entry && (entry.parent !== parent || used.has(scope))) ||
                (node._cloudScope !== undefined && node._cloudScope !== scope) ||
                (node._private && !scope)) {
                throw Error('不能跨加密边界移动内容，请在电脑本地后台操作');
            }
            if (entry) used.add(scope);
            const clean = Object.fromEntries(Object.entries(node).filter(([name]) => !name.startsWith('_')));
            for (const field of this.children) {
                if (Array.isArray(clean[field])) clean[field] = await this._seal(clean[field], scope, used);
            }
            if (!entry) { result.push(clean); continue; }
            const key = await getSessionKey(entry.envelope._group);
            if (!key) throw Error('请先解锁内容所属的密码组');
            if (canonicalJson(clean) === canonicalJson(entry.plain)) result.push(entry.envelope);
            else {
                const serialized = canonicalJson(clean);
                if (entry.last?.serialized !== serialized) {
                    entry.last = { serialized, enc: await encryptRecord(clean, key) };
                }
                result.push({ ...entry.envelope, _enc: entry.last.enc });
            }
        }
        return result;
    }
}
