/** 私密 CMS 的管理视图与密文编辑，正文和图片键留在当前管理会话。 */
import { syncManager } from '../../../data-manage/sync/sync-manager.module.js';
import { encryptRecord, getSessionKey, isEncryptedRecord, sha256Hex, unwrapRecord } from '../../../data-manage/encrypt/crypto.module.js';
import { cmsMediaReferences, getPrivateUrlBuilder } from '../../../data-manage/encrypt/private-media.module.js';
import { validateCmsNodeAction } from '../../../data-manage/sync/relay-actions.module.js';

function locate(nodes, id, includeLocked = false) {
    for (const node of nodes) {
        if (isEncryptedRecord(node) && !includeLocked) continue;
        if (node.id === id) return { node, nodes };
        if (isEncryptedRecord(node)) continue;
        const child = locate(node.children || [], id, includeLocked);
        if (child) return child;
    }
    return null;
}

async function update(node, fields) {
    if (fields.expectedRevision && fields.expectedRevision !== await sha256Hex(node.md || '')) {
        throw Error('正文已修改，请重新打开后再保存');
    }
    if (typeof fields.title === 'string' && fields.title.trim()) node.title = fields.title.trim();
    if (Array.isArray(fields.tags)) node.tags = [...new Set(fields.tags)];
    if (fields.content !== undefined) {
        if (node.type !== 'note' || typeof fields.content !== 'string') throw Error('正文格式无效');
        const allowed = new Set([node.coverRow, ...(node.mediaRows || [])].filter(Boolean)
            .flatMap(row => [row.path, row.thumb, row.preview]));
        if (cmsMediaReferences(fields.content).some(({ key }) => !allowed.has(key))) {
            throw Error('私密正文中的站内图片请通过本文的上传按钮添加');
        }
        node.md = fields.content;
    }
    if (fields.coverImage !== undefined) {
        if (fields.coverImage) throw Error('请通过上传按钮添加私密封面');
        node.coverImage = null;
        delete node.coverRow;
    }
}

function editTree(payload, action, data) {
    const root = [payload];
    validateCmsNodeAction(root, action, data);
    const hit = locate(root, data.id);
    const destination = locate(root, data.targetParentId || data.parentId)?.node;
    if (action === 'update' && hit) return update(hit.node, data.data);
    if (action === 'add' && destination?.type === 'folder') {
        const { title, type } = data;
        (destination.children ||= []).unshift({
            id: 'n_' + crypto.randomUUID(), title: title.trim(), type, tags: [], mediaRows: [],
            ...(type === 'note' ? { md: '', children: null } : { children: [] })
        });
        return;
    }
    if (action === 'delete' && hit && hit.node !== payload) {
        hit.nodes.splice(hit.nodes.indexOf(hit.node), 1);
        return;
    }
    if (action === 'move' && hit && hit.node !== payload && destination?.type === 'folder' &&
        !locate([hit.node], destination.id)) {
        hit.nodes.splice(hit.nodes.indexOf(hit.node), 1);
        (destination.children ||= []).push(hit.node);
        return;
    }
    if (action === 'reorder' && data.ids?.length) {
        const matches = data.ids.map(id => locate(root, id));
        const siblings = matches[0]?.nodes;
        const order = matches.map(match => match?.node);
        if (siblings && siblings !== root && new Set(order).size === order.length &&
            matches.every(match => match?.nodes === siblings)) {
            const selected = new Set(order);
            let index = 0;
            siblings.forEach((node, i) => { if (selected.has(node)) siblings[i] = order[index++]; });
            return;
        }
    }
    throw Error('此操作会改变加密范围或包含未解锁的内容，请在电脑本地后台操作');
}

async function openNested(entry, envelope) {
    const group = envelope._group || 'default';
    const key = await getSessionKey(group);
    const payload = key && await unwrapRecord(envelope, key);
    if (!payload) return null;
    return {
        group,
        payload,
        edit: change => entry.edit(async root => {
            const node = locate([root], envelope.id, true)?.node;
            const currentKey = await getSessionKey(group);
            const current = currentKey && node && (node._group || 'default') === group && await unwrapRecord(node, currentKey);
            if (!current) throw Error('请先解锁内容所属的密码组');
            const before = JSON.stringify(current);
            const result = await change(current);
            if (JSON.stringify(current) !== before) node._enc = await encryptRecord(current, currentKey);
            return result;
        })
    };
}

export async function openCmsDrafts(module, root) {
    const entries = await syncManager.openPrivateDrafts(module, { root });
    const byId = new Map();
    const builders = new Map();

    async function open(nodes, entry = null, toUrl = null, envelopeRoot = false) {
        const result = [];
        for (let node of nodes) {
            if (isEncryptedRecord(node)) {
                const opened = entry ? await openNested(entry, node) : entries.get(node);
                if (!opened || opened.payload.id !== node.id) { result.push(node); continue; }
                if (!builders.has(opened.group)) builders.set(opened.group, getPrivateUrlBuilder(opened.group).catch(() => null));
                const builder = await builders.get(opened.group);
                result.push(...await open([opened.payload], opened, builder, true));
                continue;
            }
            if (entry) {
                byId.set(node.id, entry);
                const row = node.coverRow;
                const body = node.md || '';
                node = {
                    id: node.id, title: node.title, type: node.type, tags: [...(node.tags || [])],
                    content: '', _draftContent: body, _sourceRevision: await sha256Hex(body),
                    coverImage: row ? toUrl?.(row.path) : node.coverImage,
                    coverPreview: row && toUrl?.(row.preview || row.path),
                    coverThumb: row && toUrl?.(row.thumb || row.path),
                    children: node.children, _private: true, _private_group: entry.group, _cloudEnvelope: envelopeRoot
                };
            }
            if (node.children) node.children = await open(node.children, entry, toUrl);
            result.push(node);
        }
        return result;
    }

    return { root: await open(root), byId };
}

export function editCmsDraft(entry, action, data) {
    return entry.edit(payload => editTree(payload, action, data));
}

export function uploadCmsDraft(entry, id, file, cover) {
    return entry.edit(async payload => {
        const node = locate([payload], id)?.node;
        if (!node) throw Error('找不到私密内容，请重新打开页面');
        const row = await syncManager.uploadPrivatePhoto(file, entry.group);
        (node.mediaRows ||= []).push(row);
        if (cover) {
            node.coverRow = row;
            node.coverImage = row.path;
        }
        return row;
    });
}
