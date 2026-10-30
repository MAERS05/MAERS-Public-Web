/** 中继草稿：内存树操作、顺序回放，以及入库合并、失败停止和确认去重。 */
import { localFetch } from '../api-client.module.js';
import { Toast } from '../../shared/toast.module.js';

async function applyRelayItem(item, source) {
    const { module, action, data } = item.data;
    const endpoint = module === 'photos' && action === 'upload'
        ? '/api/photos/register'
        : `/api/cms/node?module=${encodeURIComponent(module)}&action=${encodeURIComponent(action)}`;
    const response = await localFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, _relay: { source, key: item.key } })
    });
    const result = await response.json();
    if (!response.ok || result.success === false || result.error) {
        throw new Error(result.error || result.msg || `HTTP ${response.status}`);
    }
}

export async function mergeRelayQueue(manager, driver) {
    const { relay } = manager.config;
    if (!relay?.endpoint || !relay?.secret) {
        Toast.error('未配置中继网关信息'); manager.openSettingsModal(); return false;
    }
    Toast.info('正在从云端拉取待同步草稿...');
    const response = await driver.pull(relay.endpoint, relay.secret);
    if (!response.success) { Toast.error(`拉取失败: ${response.msg}`); return false; }
    const items = (response.items || []).slice().sort((a, b) => (a.data.timestamp || 0) - (b.data.timestamp || 0));
    if (!items.length) {
        manager.pendingItemsCount = 0; manager.updateButtonBadge();
        Toast.info('云端暂存队列为空，无需合并'); return true;
    }
    const applied = manager._appliedRelayKeys;
    const identity = key => JSON.stringify([relay.endpoint, key]);
    const ackKeys = [];
    let changed = false;
    for (const item of items) {
        try {
            if (!applied.has(identity(item.key))) {
                await applyRelayItem(item, relay.endpoint.trim().replace(/\/+$/, ''));
                applied.add(identity(item.key));
                changed = true;
            }
            ackKeys.push(item.key);
        } catch (error) {
            console.error('[SyncManager] 合并中断:', item.key, error);
            Toast.error(`合并中断，后续草稿已保留: ${error.message}`);
            break;
        }
    }
    let acknowledged = false;
    if (ackKeys.length) {
        const result = await driver.ack(relay.endpoint, relay.secret, ackKeys);
        acknowledged = result.success;
        if (acknowledged) ackKeys.forEach(key => applied.delete(identity(key)));
        else Toast.error('本地已入库，但云端确认失败；可刷新后重试同步');
    }
    manager.pendingItemsCount = items.length - (acknowledged ? ackKeys.length : 0);
    manager.updateButtonBadge();
    if (changed && manager.Controller?.refreshView) {
        await manager.Controller.loadData(); manager.Controller.refreshView(true);
    }
    const complete = acknowledged && ackKeys.length === items.length;
    if (complete) {
        manager.localPendingSessionItems = manager.localPendingSessionItems.filter(pending =>
            !items.some(item => JSON.stringify(item.data) === JSON.stringify(pending)));
        Toast.success(`成功合并并确认 ${ackKeys.length} 条草稿`);
        if (!manager.Controller?.refreshView) setTimeout(() => window.location.reload(), 1000);
    }
    return complete;
}

/**
 * 辅助递归查找节点
 */
function findNode(treeList, targetId) {
    for (const node of treeList) {
        if (node.id === targetId) return node;
        if (node.children && node.children.length > 0) {
            const found = findNode(node.children, targetId);
            if (found) return found;
        }
    }
    return null;
}

/**
 * 辅助递归查找并删除节点
 */
function removeNode(treeList, targetId) {
    for (let i = 0; i < treeList.length; i++) {
        if (treeList[i].id === targetId) {
            treeList.splice(i, 1);
            return true;
        }
        if (treeList[i].children && treeList[i].children.length > 0) {
            const found = removeNode(treeList[i].children, targetId);
            if (found) return true;
        }
    }
    return false;
}


/** 入队成功后应用当前操作，保持即时反馈。 */
export function applyRelayState(module, action, data, AppState) {
    if (AppState) {
        if (action === 'add') {
            const { parentId, type, title } = data;
            const newId = data.id;
            const safeTitle = (title || '').replace(/[\\/*?:"<>|]/g, '').trim() || 'Untitled';
            const contentPath = (type === 'note') ? `${module}/${safeTitle}.md` : null;

            const newNode = {
                id: newId,
                parentId: parentId || 'root',
                type: type,
                title: title,
                tags: [],
                content: contentPath,
                coverImage: null,
                children: (type === 'folder') ? [] : null,
                _pendingRelay: true
            };

            if (!parentId || parentId === 'root') {
                AppState.root.unshift(newNode);
            } else {
                const parentNode = findNode(AppState.root, parentId);
                if (parentNode) {
                    parentNode.children = parentNode.children || [];
                    parentNode.children.unshift(newNode);
                } else {
                    AppState.root.unshift(newNode);
                }
            }
            AppState.allNodes.push(newNode);
        } else if (action === 'update') {
            const { id, data: updateFields } = data;
            const node = findNode(AppState.root, id);
            if (node) {
                if (updateFields.title) node.title = updateFields.title;
                if (updateFields.tags) node.tags = updateFields.tags;
                if (updateFields.coverImage !== undefined) node.coverImage = updateFields.coverImage;
                if (updateFields.content !== undefined) {
                    node.content = updateFields.content;
                    node._draftContent = updateFields.content;
                }
            }
        } else if (action === 'delete') {
            removeNode(AppState.root, data.id);
            AppState.allNodes = AppState.allNodes.filter(n => n.id !== data.id);
        }
    }
}

/** 按顺序回放草稿并重建扁平索引，保留扩展动作回调。 */
export function replayQueuedDrafts(module, AppState, itemsToApply, onCustomAction = null) {
    // 按时间戳升序回放操作
    itemsToApply.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    for (const item of itemsToApply) {
        if (item.module !== module) continue;
        const { action, data } = item;
        if (action === 'add') {
            const { id, parentId, type, title } = data;
            if (findNode(AppState.root, id)) continue;
            const safeTitle = (title || '').replace(/[\\/*?:"<>|]/g, '').trim() || 'Untitled';
            const contentPath = (type === 'note') ? `${module}/${safeTitle}.md` : null;

            const newNode = {
                id: id,
                parentId: parentId || 'root',
                type: type,
                title: title,
                tags: [],
                content: contentPath,
                coverImage: null,
                children: (type === 'folder') ? [] : null,
                _pendingRelay: true
            };

            if (!parentId || parentId === 'root') {
                AppState.root.unshift(newNode);
            } else {
                const parentNode = findNode(AppState.root, parentId);
                if (parentNode) {
                    parentNode.children = parentNode.children || [];
                    parentNode.children.unshift(newNode);
                } else {
                    AppState.root.unshift(newNode);
                }
            }
        } else if (action === 'update') {
            const { id, data: updateFields } = data;
            const node = findNode(AppState.root, id);
            if (node) {
                if (updateFields.title) node.title = updateFields.title;
                if (updateFields.tags) node.tags = updateFields.tags;
                if (updateFields.coverImage !== undefined) node.coverImage = updateFields.coverImage;
                if (updateFields.content !== undefined) {
                    node.content = updateFields.content;
                    node._draftContent = updateFields.content;
                }
            }
        } else if (action === 'delete') {
            removeNode(AppState.root, data.id);
        }
        if (onCustomAction) {
            try { onCustomAction(item); } catch (e) { console.warn('[SyncManager] 扩展动作回放失败:', e); }
        }
    }

    // 重新展平 allNodes
    AppState.allNodes = [];
    const flatten = (list, parentId = 'root') => {
        list.forEach(node => {
            node.parentId = parentId;
            AppState.allNodes.push(node);
            if (node.children) flatten(node.children, node.id);
        });
    };
    flatten(AppState.root);
}

/** 以原图键匹配相对路径与 CDN 地址，不混淆文件名中的字面百分号。 */
function photoPathKey(path) {
    if (typeof path !== 'string') return '';
    if (/^https?:\/\//i.test(path)) {
        try { path = decodeURIComponent(new URL(path).pathname); }
        catch { return ''; }
    }
    return path.replace(/^(?:\.\/|\/)+/, '');
}

/** 回放当前分类的公开上传，保留已发布图片的 ID、标签与真实衍生图路径。 */
export function replayQueuedPhotos(category, photos, items) {
    const seen = new Set(photos.map(photo => photoPathKey(photo.path)));
    for (const item of items.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))) {
        const data = item.data;
        if (item.module !== 'photos' || item.action !== 'upload' || data?.category !== category ||
            (data.scope && data.scope !== 'public')) continue;
        const path = photoPathKey(data.path);
        if (!path.startsWith(`photos/images/${category}/`) || seen.has(path)) continue;
        seen.add(path);
        photos.unshift({ id: `relay_${path}`, path, thumb: path, preview: path,
            name: data.name, tags: [], _pendingRelay: true });
    }
}
