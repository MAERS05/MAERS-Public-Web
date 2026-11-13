/** 云端私密相册与标签共用同一条密文草稿基线。 */
import { isOnlineAdminPage, localFetch } from '../../../data-manage/api-client.module.js';
import { isEncryptedRecord } from '../../../data-manage/encrypt/crypto.module.js';
import { syncManager } from '../../../data-manage/sync/sync-manager.module.js';
import { applyTagChange } from '../../../data-manage/sync/relay-actions.module.js';

let albumsRequest;

export function loadCloudAlbums() {
    if (!albumsRequest) albumsRequest = readAlbums().catch(error => {
        albumsRequest = null;
        throw error;
    });
    return albumsRequest;
}

async function readAlbums() {
    const response = await localFetch('data/album-config.json', { cache: 'no-cache' });
    if (!response.ok) throw Error('相册分类读取失败，请刷新后重试');
    const records = await response.json();
    if (!Array.isArray(records) || records.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw Error('相册分类格式无效');
    }
    return { records, drafts: await syncManager.openPrivateDrafts('album', records) };
}

/** 先确认分类归属，避免密码组锁定或相册不存在时回退到公开上传。 */
export async function getCloudAlbumDraft(category) {
    if (!isOnlineAdminPage()) return null;
    const { records, drafts } = await loadCloudAlbums();
    for (const entry of drafts.values()) {
        if (entry.payload.category?.id === category) return entry;
    }
    if (records.some(row => !isEncryptedRecord(row) && row.id === category)) return null;
    throw Error('相册不存在或所属密码组尚未解锁');
}

export function photoTags(row) {
    const tags = typeof row.tags === 'string' ? JSON.parse(row.tags || '[]') : row.tags;
    return Array.isArray(tags) ? tags : [];
}

export function albumTagCategories(payload) {
    return JSON.parse(payload.tags_file || '[]');
}

export function editAlbumTags(entry, scope, action, data) {
    return entry.edit(payload => {
        const categories = albumTagCategories(payload);
        const rows = payload.photos.map(row => ({ tags: photoTags(row) }));
        applyTagChange({ module: 'tags', action, data }, scope, { nodes: rows, categories });
        let count = 0;
        for (const [index, row] of payload.photos.entries()) {
            if (JSON.stringify(photoTags(row)) === JSON.stringify(rows[index].tags)) continue;
            row.tags = rows[index].tags;
            count++;
        }
        payload.tags_file = JSON.stringify(categories);
        return count;
    });
}

export function editAlbumOrder(entry, deletePaths, newOrder) {
    return entry.edit(payload => {
        const removed = new Set(deletePaths);
        const rank = new Map(newOrder.map(({ path }, index) => [path, index]));
        payload.photos = payload.photos.filter(row => !removed.has(row.path))
            .sort((a, b) => (rank.get(a.path) ?? rank.size) - (rank.get(b.path) ?? rank.size));
        payload.photos.forEach((row, index) => { row.sort_order = index; });
    });
}
