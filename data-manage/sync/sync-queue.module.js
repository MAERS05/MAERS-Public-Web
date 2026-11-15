/**
 * 中继草稿合并与 CMS 树回放 (sync-queue.module.js)
 * 合并：按时间顺序执行，失败时选择跳过、原地重试或关闭；只确认实际成功项。
 * 回放：页面刷新后把尚未合并的草稿叠加到内存状态，保持界面与队列一致。
 */
import { confirmAction } from "../admin/admin-confirm.module.js";

import { localFetch } from '../api-client.module.js';
import { Toast } from '../../shared/toast.module.js';
import { operationFetch } from '../operation-progress.module.js';
import { RelayDependencies } from './sync-dependencies.module.js';
import { AdminModal } from '../admin/admin-modal.module.js';
import {
    resolveMergeRequest, documentSpec, contentHash, byTimestamp, docsAffectedBy,
    applyCmsNodeAction, applyTagChange, hasProtectedCmsContent, walkTree, isRetiredPhotoUpload
} from './relay-actions.module.js';

/** 比对电脑当前内容与编辑基线，已是目标内容时可安全重试。 */
async function readDocumentBase(data, spec) {
    const response = await fetch(spec.source, { cache: 'no-store' });
    if (!response.ok && response.status !== 404 && data.baseCaptured) {
        throw new Error(`无法读取「${data.doc}」的电脑版本`);
    }
    const missing = data.doc === 'space-tree' ? { root: [] } : [];
    const current = response.ok ? await response.json() : data.baseCaptured ? missing : null;
    const currentHash = await contentHash(current);
    return { current, conflict: currentHash !== data.baseHash && currentHash !== await contentHash(data.content) };
}

function confirmDocumentOverwrite(doc, confirmOverwrite) {
    const overwrite = confirmOverwrite(
        `「${doc}」当前电脑版本与开始编辑时的版本不同，覆盖可能丢失其他修改。\n\n` +
        '确定：用手机暂存的版本覆盖电脑版本\n取消：保留该草稿，再选择是否继续处理其他内容'
    );
    if (!overwrite) throw new Error(`「${doc}」存在版本冲突，草稿已保留`);
}

/** 执行单条草稿；新快照逐条校验，旧快照沿用首次校验规则。 */
async function applyRelayItem(item, source, secret, checkedDocs, confirmOverwrite, progress, overwriteRevision) {
    const payload = item.data;
    if (isRetiredPhotoUpload(payload)) {
        const response = await localFetch('/api/relay/archive-upload', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source, item })
        });
        const result = await response.json();
        if (!response.ok || result.archived !== true) throw Error(result.error || '旧上传记录备份失败，已保留');
        return [];
    }
    const data = payload.data;
    const doc = data?.doc;
    const spec = payload.module === 'doc' && payload.action === 'replace' ? documentSpec(doc) : null;
    let baseline;
    if (spec && (data.baseCaptured || spec.checkEachDraft || !checkedDocs.has(doc))) {
        if (data.baseCaptured || data.baseHash) baseline = await readDocumentBase(data, spec);
        if (!data.baseCaptured && baseline?.conflict) confirmDocumentOverwrite(doc, confirmOverwrite);
    }
    const { endpoint, body } = resolveMergeRequest(payload);
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${endpoint}${separator}_relay_source=${encodeURIComponent(source)}&_relay_key=${encodeURIComponent(item.key)}`;
    const headers = { 'Content-Type': 'application/json' };
    if (endpoint === '/api/photos/register' || endpoint === '/api/private/relay-edit' ||
        (endpoint.startsWith('/api/cms/node?') && payload.action === 'update')) {
        headers['X-MAERS-Relay-Key'] = secret.trim();
    }
    const post = async requestBody => {
        const options = {
            method: 'POST', headers, body: JSON.stringify(requestBody)
        };
        const response = progress ? await operationFetch(url, options, progress) : await localFetch(url, options);
        return [response, await response.json().catch(() => ({}))];
    };
    // 冲突时仍检查本地回执，已入库的草稿可以直接确认；未执行的草稿才要求确认覆盖。
    const guarded = baseline && data.baseCaptured;
    let [response, result] = await post(overwriteRevision ? { ...body, _overwriteRevision: overwriteRevision } :
        guarded ? { _snapshot: body, _base: baseline.conflict ? null : baseline.current } : body);
    if (guarded && baseline.conflict && response.status === 409 && result?.code === 'snapshot_conflict') {
        if (data.privateEdit) throw Error('加密内容的电脑版本已变化，草稿已保留');
        confirmDocumentOverwrite(doc, confirmOverwrite);
        [response, result] = await post({ _snapshot: body, _base: baseline.current });
    }
    if (!response.ok || result?.success === false || result?.error) {
        const error = new Error(result?.error || result?.msg || `HTTP ${response.status}`);
        if (response.status === 409 && result?.code === 'markdown_conflict' && /^[0-9a-f]{64}$/.test(result.currentRevision)) {
            error.overwriteRevision = result.currentRevision;
        }
        throw error;
    }
    if (spec) checkedDocs.add(doc);
    docsAffectedBy(payload).forEach(doc => checkedDocs.add(doc));
    return result._draft_media || [];
}

/**
 * 电脑端合并云端队列。
 * @returns {Promise<boolean>} 全部草稿均已执行且确认时为 true
 */
export async function mergeRelayQueue(manager, driver, {
    confirmOverwrite = message => confirmAction({ confirmText: "用云端内容覆盖", cancelText: "保留本机内容", description: message, danger: true }),
    chooseFailure = (message, overwriteRevision, hasItem = false) => AdminModal.choose({ title: '拉取失败，请选择处理方式', message,
        primary: { text: '从失败项开始重新拉取', value: 'retry' },
        secondary: { text: '跳过失败项继续拉取', value: 'skip' },
        extraChoices: [
            ...(overwriteRevision ? [{ text: '备份并用云端草稿覆盖', value: 'overwrite' }] : []),
            ...(hasItem ? [{ text: '删除这条草稿并继续', value: 'delete' }] : [])
        ] }),
    onAcknowledged, progress
} = {}) {
    const { relay } = manager.config;
    if (!relay?.endpoint || !relay?.secret) {
        Toast.error('未配置中继网关信息'); manager.openSettingsModal(); return false;
    }
    Toast.info('正在从云端拉取待同步草稿...');
    let response = await driver.pull(relay.endpoint, relay.secret);
    while (!response.success) {
        if (manager.config.relay === relay) {
            manager.pendingItemsCount = null;
            manager.updateButtonBadge();
        }
        const choice = await chooseFailure(`无法读取云端草稿列表：${response.msg}\n\n` +
            '尚未取得草稿列表，重新拉取会再次读取列表；跳过或关闭将结束本次拉取，云端草稿保持原样。');
        if (choice !== 'retry') return false;
        response = await driver.pull(relay.endpoint, relay.secret);
    }
    const items = byTimestamp((response.items || []).map(item => ({ ...item, timestamp: item.data?.timestamp })));
    if (!items.length) {
        manager.pendingItemsCount = 0; manager.updateButtonBadge();
        Toast.info('云端暂存队列为空，无需合并'); return true;
    }
    const applied = manager._appliedRelayKeys;
    const source = relay.endpoint.trim().replace(/\/+$/, '');
    const identity = key => JSON.stringify([relay.endpoint, key]);
    const checkedDocs = new Set();
    const ackItems = [];
    const ackMedia = new Set();
    const dependencies = new RelayDependencies();
    const issues = [];
    const deletedItems = [];
    const overwrites = new Map();
    let stopped = '';
    let changed = false;
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        progress?.update(index, items.length, '正在合并草稿');
        if (stopped || dependencies.isBlocked(item.data)) {
            issues.push({ item, index, deferred: true, reason: stopped || '依赖尚未合并的草稿，已暂缓' });
            if (!stopped) await dependencies.hold(item.data);
            continue;
        }
        try {
            const label = `正在合并第 ${index + 1}/${items.length} 条草稿`;
            const detail = progress && { update: (done, total, message) => progress.update(done, total, `${label} · ${message}`) };
            if (!applied.has(identity(item.key))) {
                const media = await applyRelayItem(item, source, relay.secret, checkedDocs, confirmOverwrite, detail, overwrites.get(item.key));
                applied.set(identity(item.key), media);
                changed = true;
            }
            dependencies.track(item.data);
            ackItems.push(item);
            for (const path of applied.get(identity(item.key))) ackMedia.add(path);
        } catch (error) {
            console.error('[SyncManager] 草稿合并失败，已保留:', item.key, error);
            const data = item.data?.data;
            const name = data?.name || data?.title || data?.data?.title || data?.doc || data?.id || item.key;
            let message = `第 ${index + 1}/${items.length} 条草稿「${name}」失败：${error.message}\n\n` +
                '跳过失败项可能改变数据顺序，不会损坏数据。失败项及其依赖会保留在云端，可稍后重试。\n\n' +
                '重新拉取将从当前失败项重试，前面已成功的项目不会重复执行。关闭弹窗则结束本次拉取。\n\n' +
                '删除将直接放弃当前草稿并继续拉取，无法撤销；电脑已有内容不受影响，依赖该项的后续草稿仍会保留。';
            if (error.overwriteRevision) message += '\n\n用云端草稿覆盖会替换电脑正文，覆盖前会自动备份电脑原文。';
            let choice;
            while (true) {
                choice = await chooseFailure(message, error.overwriteRevision, true);
                if (choice !== 'delete') break;
                // 仅确认删除当前记录，不清理可能仍被其他草稿引用的图片。
                const removed = await driver.ack(relay.endpoint, relay.secret, [item.key]);
                if (!removed.success) {
                    message = `删除未确认：${removed.msg || '请检查网络后重试'}\n\n${message}`;
                    continue;
                }
                deletedItems.push(item);
                changed = true;
                await dependencies.hold(item.data);
                break;
            }
            if (choice === 'delete') continue;
            if (choice === 'overwrite' && error.overwriteRevision) {
                overwrites.set(item.key, error.overwriteRevision);
                index--;
                continue;
            }
            if (choice === 'retry') {
                index--;
                continue;
            }
            issues.push({ item, index, deferred: false, reason: error.message });
            if (choice === 'skip') await dependencies.hold(item.data);
            else stopped = '已停止本次拉取，后续草稿已保留';
        }
    }
    const ackKeys = ackItems.map(item => item.key);
    const pending = issues.map(issue => issue.item);
    const media = dependencies.mediaToAcknowledge(ackMedia, pending);
    let acknowledged = false;
    if (ackKeys.length) {
        progress?.update(0, 0, `正在确认已合并的 ${ackKeys.length} 条草稿`);
        const result = await driver.ack(relay.endpoint, relay.secret, ackKeys, media);
        acknowledged = result.success;
        if (acknowledged) ackKeys.forEach(key => applied.delete(identity(key)));
        else Toast.error(`本地已入库，云端确认失败。${result.msg || '可刷新后重试同步'}`);
    }
    manager.pendingItemsCount = items.length - deletedItems.length - (acknowledged ? ackKeys.length : 0);
    const complete = manager.pendingItemsCount === 0;
    const retired = ackItems.filter(item => isRetiredPhotoUpload(item.data)).length;
    const completedMessage = [
        ackKeys.length > retired && `已合并并确认 ${ackKeys.length - retired} 条草稿`,
        retired && `已备份并清理 ${retired} 条旧上传记录`,
        deletedItems.length && `已删除 ${deletedItems.length} 条云端草稿`
    ].filter(Boolean).join('，');
    if (acknowledged || deletedItems.length) {
        const confirmed = new Set([...deletedItems, ...(acknowledged ? ackItems : [])].map(item => JSON.stringify(item.data)));
        manager.localPendingSessionItems = manager.localPendingSessionItems.filter(pending =>
            !confirmed.has(JSON.stringify(pending)));
        onAcknowledged?.(new Set(acknowledged ? media : []));
    }
    try {
        progress?.update(0, 0, '正在刷新合并结果');
        manager.updateButtonBadge();
        if (changed && manager.Controller?.refreshView) {
            const loaded = await manager.Controller.loadData();
            if (loaded === false) throw new Error('未能重新加载数据');
            await manager.Controller.refreshView(false, true);
        }
    } catch (error) {
        console.warn('[SyncManager] 合并后刷新页面失败:', error);
        Toast.warning(complete ? `${completedMessage}，请手动刷新页面` : '页面刷新失败，请手动刷新');
    }
    if (issues.length) Toast.warning(`已合并 ${ackKeys.length} 条，失败 ${issues.filter(issue => !issue.deferred).length} 条，暂缓 ${issues.filter(issue => issue.deferred).length} 条；未完成草稿已保留`, 5000);
    if (complete) {
        Toast.success(completedMessage);
        if (!manager.Controller?.refreshView) setTimeout(() => window.location.reload(), 1000);
    }
    return complete;
}

/** 重建 CMS 扁平索引与父级引用 */
function rebuildIndex(AppState) {
    AppState.allNodes = [];
    walkTree(AppState.root, () => {});
    const flatten = (list, parentId = 'root') => list.forEach(node => {
        node.parentId = parentId;
        AppState.allNodes.push(node);
        if (node.children) flatten(node.children, node.id);
    });
    flatten(AppState.root);
}

/** 入队成功后应用当前操作，保持即时反馈 */
export function applyRelayState(module, action, data, AppState) {
    if (!AppState?.root) return;
    if (applyCmsNodeAction(module, AppState.root, action, data)) rebuildIndex(AppState);
}

/**
 * 按时间顺序回放 CMS 草稿：节点动作、本模块的标签变更，以及加解锁等扩展动作。
 * @param {Function} [onCustomAction] - 扩展动作回调（如加锁/解锁的占位同步）
 */
export function replayQueuedDrafts(module, AppState, itemsToApply, onCustomAction = null, protectPrivate = false) {
    for (const item of byTimestamp(itemsToApply)) {
        const nodes = [];
        walkTree(AppState.root, node => { if (!protectPrivate || !node._private) nodes.push(node); });
        if (applyTagChange(item, module, { nodes })) continue;
        if (item.module !== module) continue;
        const { id, parentId, targetParentId } = item.data || {};
        if (item.action === 'delete') {
            const locked = AppState.lockedNodes || [];
            if (locked.some(node => node.id === id) ||
                hasProtectedCmsContent(AppState.allNodes.find(node => node.id === id), locked)) continue;
        }
        if (protectPrivate && AppState.allNodes.some(node => node._private &&
            [id, parentId, targetParentId].includes(node.id))) continue;
        try { applyCmsNodeAction(module, AppState.root, item.action, item.data); }
        catch (error) {
            console.warn('[SyncManager] 草稿与当前目录名称冲突，已保留待电脑处理:', error);
            continue;
        }
        rebuildIndex(AppState);
        if (onCustomAction) {
            try { onCustomAction(item); } catch (e) { console.warn('[SyncManager] 扩展动作回放失败:', e); }
        }
    }
    rebuildIndex(AppState);
}
