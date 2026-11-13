/** 同步媒体流水线：本地上传、相册批量登记及重试复用；仅由同步门面协调。 */
import { localFetch } from '../api-client.module.js';
import { sha256Hex } from '../encrypt/crypto.module.js';
import { Toast } from '../../shared/toast.module.js';
import { cloudflareRelay, cloudImageError } from './cloudflare-relay.module.js';
import { photoPathKey } from './relay-actions.module.js';
import { operationFetch } from '../operation-progress.module.js';
import { uploadMeter } from '../upload-progress.module.js';
import { openProgress } from '../encrypt/lock-dialog.module.js';
import { photoDateLabel } from '../../shared/photo-date.module.js';

export async function uploadLocalFile(file, category, target, progress) {
    try {
        const ext = file.name ? file.name.split('.').pop() : 'jpg';
        const safeName = `img_${crypto.randomUUID()}.${/^[a-z0-9]{1,10}$/i.test(ext) ? ext : 'bin'}`;
        const query = new URLSearchParams({ category, name: safeName, dateLabel: await photoDateLabel(file), ...target });
        const options = { method: 'POST', body: file, onUploadProgress: progress && uploadMeter(progress) };
        const res = progress ? await operationFetch(`/upload?${query}`, options, progress)
            : await localFetch(`/upload?${query}`, options);
        const data = await res.json().catch(() => null);
        if (!res.ok || data?.success === false || data?.error || !data?.path) {
            return { success: false, msg: data?.error || data?.msg || (res.ok ? '上传未返回文件路径' : '本地上传失败') };
        }
        if (data.sync?.state === 'pending') {
            Toast.warning('图片已保存到本机，云端同步尚未完成；请在后台备份与恢复中重试');
        }
        return {
            success: true,
            path: data.path,
            relPath: data.relPath || data.path,
            sync: data.sync,
            name: data.name
        };
    } catch (e) {
        return { success: false, msg: e.message };
    }
}

export async function uploadPhotoBatch(manager, files, category, loadedData, tags, bucketId) {
    const relayConfig = manager.getConfig().relay;
    if (!relayConfig?.secret?.trim()) {
        Toast.error('未配置同步密码，请点击顶栏「同步」按钮设置后重试');
        manager.openSettingsModal();
        return { success: false, dupCount: 0 };
    }

    const progress = openProgress('正在准备上传图片', '');
    let uploadedCount = 0, failedCount = 0;
    try {
        for (const file of files) {
            const label = `第 ${uploadedCount + failedCount + 1}/${files.length} 张图片`;
            progress.update(0, 0, `正在准备${label}`);
            try {
                await uploadSinglePhoto(manager, relayConfig, file, category, tags, loadedData, uploadMeter(progress, label), bucketId);
                uploadedCount++;
            } catch (error) {
                failedCount++;
                Toast.error(`${file.name} 暂存失败：${error.message}`);
            }
        }
    } finally { progress.close(); }
    if (uploadedCount) {
        void manager.checkPendingRelayItems();
        Toast.success(`已暂存 ${uploadedCount} 张图片，待电脑合并${failedCount ? `，${failedCount} 张失败` : ''}`);
    }
    return { success: uploadedCount > 0, dupCount: 0, uploadedCount, failedCount };
}

async function uploadSinglePhoto(manager, relay, file, category, tags, loadedData, onProgress, bucketId) {
    const invalid = cloudImageError(file);
    if (invalid) throw Error(invalid);
    // 同一个文件重新选择或刷新后重试，仍能找回原上传编号。
    const digest = await sha256Hex(await file.arrayBuffer());
    const retry = await manager.reserveRelayRequest(relay, ['photo', category, file.name, digest, tags], bucketId);
    if (bucketId && retry.bucketId && retry.bucketId !== bucketId) {
        throw Error(`请使用原桶组「${retry.bucketId === 'default' ? '默认桶组' : retry.bucketId}」重试`);
    }
    const { requestId, timestamp } = retry;
    const res = await cloudflareRelay.uploadFile(relay.endpoint, relay.secret, file, category,
        { requestId, timestamp, tags }, onProgress, retry.bucketId || bucketId);
    if (!res.success) throw new Error(res.msg);
    manager.finishRelayRequest(retry);
    if (!manager._isCurrentRelay(relay)) throw Error('同步设置已变化，请重新加载页面');
    manager.rememberDraftImage(res.relPath, res.draftPreview);
    manager.recordRelayDraft(res.draft, relay, { refresh: false });

    if (Array.isArray(loadedData) && !loadedData.some(item => photoPathKey(item.path) === res.relPath)) {
        loadedData.unshift({ id: `relay_${res.relPath}`, path: res.path,
            thumb: res.path, preview: res.path, name: res.name, tags: [...tags], _pendingRelay: true,
            ...(res.bucketId ? { bucketId: res.bucketId } : {}) });
    }
}
