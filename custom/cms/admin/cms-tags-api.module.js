/**
 * @module custom/cms/admin/cms-tags-api.module.js
 * @description 标签系统统一数据通道：本地模式直连后端，云端模式经中继暂存。
 *   CMS、空间、图库共用；作用域为 CMS 模块名、'space' 或 'photos-<分类>'。
 *   所有写操作返回真实结果，禁止在失败时伪装成功。
 * @version 1.0.0
 */
import { isOnlineAdminPage, localFetch } from '../../../data-manage/api-client.module.js';
import { syncManager } from '../../../data-manage/sync/sync-manager.module.js';
import { applySpaceDraft, tagCategoriesFile } from '../../../data-manage/sync/relay-actions.module.js';

const isRelay = () => syncManager.getEffectiveMode() === 'relay';
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** 读取响应 JSON；非 JSON 时返回空对象，调用方依据 HTTP 状态判断 */
const readJson = response => response.json().catch(() => ({}));

async function privateAlbumTags(scope) {
    if (!scope.startsWith('photos-') || !isOnlineAdminPage()) return null;
    const helpers = await import('../../photos/admin/photos-private-drafts.module.js');
    const entry = await helpers.getCloudAlbumDraft(scope.slice('photos-'.length));
    return entry ? { entry, ...helpers } : null;
}

async function editPrivateTags(scope, action, data) {
    try {
        const album = await privateAlbumTags(scope);
        if (!album) return null;
        const count = await album.editAlbumTags(album.entry, scope, action, data);
        return { success: true, count };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export function includesPrivateTags(scope, nodes, tags) {
    return !scope.startsWith('photos-') && isOnlineAdminPage() &&
        nodes?.some(node => node._private && Array.isArray(node.tags) && node.tags.some(tag => tags.includes(tag)));
}

/** 空间标签变更也写入网站树，推进本页已读取的基线。 */
function updateSpaceBase(action, data) {
    if (data.scope !== 'space') return;
    syncManager.updateDocumentBase('space-tree', content => applySpaceDraft({ module: 'tags', action, data }, content));
}

export const TagsApi = {
    /**
     * 重命名标签
     * @returns {Promise<{success:boolean, count?:number|null, error?:string}>} 云端模式无法预知受影响数量，count 为 null
     */
    async renameTag(moduleName, oldName, newName) {
        const data = { scope: moduleName, oldName, newName };
        const privateResult = await editPrivateTags(moduleName, 'rename', data);
        if (privateResult) return privateResult;
        if (isRelay()) {
            const result = await syncManager.enqueue('tags', 'rename', data);
            if (result.success) updateSpaceBase('rename', data);
            return result.success ? { success: true, count: null } : { success: false, error: result.msg };
        }
        try {
            const res = await localFetch(`/api/cms/rename_tag?module=${encodeURIComponent(moduleName)}`,
                json({ old_name: oldName, new_name: newName }));
            const result = await readJson(res);
            if (res.ok && result.success) {
                updateSpaceBase('rename', data);
                return { success: true, count: result.updated_count };
            }
            return { success: false, error: result.error || `HTTP ${res.status}` };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /** 删除标签，返回形状同 renameTag */
    async deleteTag(moduleName, tagName) {
        const data = { scope: moduleName, tag: tagName };
        const privateResult = await editPrivateTags(moduleName, 'delete', data);
        if (privateResult) return privateResult;
        if (isRelay()) {
            const result = await syncManager.enqueue('tags', 'delete', data);
            if (result.success) updateSpaceBase('delete', data);
            return result.success ? { success: true, count: null } : { success: false, error: result.msg };
        }
        try {
            const res = await localFetch(`/api/cms/delete_tag?module=${encodeURIComponent(moduleName)}`,
                json({ tag_name: tagName }));
            const result = await readJson(res);
            if (res.ok && result.success) {
                updateSpaceBase('delete', data);
                return { success: true, count: result.updated_count };
            }
            return { success: false, error: result.error || `HTTP ${res.status}` };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 保存标签分类（含顺序）。云端模式以整份快照暂存，电脑合并时检测版本冲突。
     * @returns {Promise<boolean>}
     */
    async saveCategories(moduleName, categories) {
        try {
            const album = await privateAlbumTags(moduleName);
            if (album) {
                await album.entry.edit(payload => { payload.tags_file = JSON.stringify(categories); });
                return true;
            }
        } catch (error) {
            window.MAERS?.Toast?.error?.(error.message);
            return false;
        }
        return (await syncManager.writeDocument(`tags:${moduleName}`, categories)).success;
    },

    /** 清理未使用的标签：需要扫描全部内容，仅电脑本地可用 */
    async cleanupTags(moduleName) {
        if (isRelay()) return { success: false, error: '清理未使用标签需要扫描全部内容，请在电脑本地后台操作' };
        try {
            const res = await localFetch(`/api/cms/cleanup_tags?module=${encodeURIComponent(moduleName)}`, json({}));
            const result = await readJson(res);
            if (res.ok) return result;
            return { success: false, error: result.error || `HTTP ${res.status}` };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /** 获取标签分类：本地读后端；云端读已发布文件并叠加尚未合并的草稿 */
    async getCategories(moduleName) {
        try {
            const album = await privateAlbumTags(moduleName);
            if (album) return album.albumTagCategories(album.entry.payload);
            const relay = isRelay();
            const url = relay ? tagCategoriesFile(moduleName) : `/api/cms/tag_categories?module=${encodeURIComponent(moduleName)}`;
            const res = await localFetch(url, { cache: 'no-cache' });
            if (!res.ok && !(relay && res.status === 404)) throw new Error(`HTTP ${res.status}`);
            const base = res.ok ? await res.json() : [];
            if (!Array.isArray(base)) throw new Error('标签分类格式无效');
            return await syncManager.loadTagCategories(moduleName, base);
        } catch (e) {
            syncManager.rememberDocument(`tags:${moduleName}`, undefined);
            console.error('Failed to fetch categories:', e);
            return [];
        }
    }
};
