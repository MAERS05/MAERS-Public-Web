/**
 * MAERS Sync Manager (sync-manager.module.js)
 * 职责：协调草稿、快照和媒体的同步入口与界面状态。
 */
import { injectSyncControl, syncControlLabel, updateSyncModalBadge, updateSyncToolbarButton } from './sync-toolbar.module.js';
import { uploadLocalFile, uploadPhotoBatch } from './sync-media.module.js';

import { Toast } from '../../shared/toast.module.js';
import { cloudflareRelay } from './cloudflare-relay.module.js';
import { mergeRelayQueue, applyRelayState, replayQueuedDrafts } from './sync-queue.module.js';
import { canonicalJson, replayDocument, replayPhotos, applyTagChange, validateCmsNodeAction } from './relay-actions.module.js';
import { getLocalGitStatus, RelayRequests } from './sync-requests.module.js';
import { DocumentSnapshots } from './sync-documents.module.js';
import { openProgress } from '../encrypt/lock-dialog.module.js';
import { uploadMeter } from '../upload-progress.module.js';
import { hasPrivateEditorState, hasPrivateEnvelopes, isCloudPrivateAdmin, openPrivateDrafts, PrivateDocument, requireCloudAdmin } from '../encrypt/private-drafts.module.js';
import { getAccessToken } from '../encrypt/crypto.module.js';
import { clearDraftPhotos, rememberDraftPhoto } from '../data-provider.module.js';

const STORAGE_KEY = 'maers_sync_config';

const DEFAULT_CONFIG = {
    mode: 'auto', // 'auto' | 'relay' | 'local'
    relay: {
        endpoint: '',
        secret: ''
    }
};

export class SyncManager {
    constructor() {
        this.config = this._loadConfig();
        this.pendingItemsCount = 0;
        this.pendingGitCount = 0;
        this.Controller = null;
        this._requests = new RelayRequests();
        this._documents = new DocumentSnapshots(data => this.enqueue('doc', 'replace', data));
        this._privateDocs = new Map();
        this._relayRevision = 0;
        this._replayRevision = 0; // 合并或切换配置前的草稿不能再次回放
        this._mergeRequest = null;
        this._appliedRelayKeys = new Map();
        this.localPendingSessionItems = []; // 记录当前会话已推送的暂存项
    }

    setController(controller) {
        this.Controller = controller;
    }

    _loadConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
            const parsed = JSON.parse(raw);
            return {
                ...DEFAULT_CONFIG,
                ...parsed,
                relay: { ...DEFAULT_CONFIG.relay, ...(parsed.relay || {}) }
            };
        } catch (e) {
            console.error('[MAERS.Sync] 读取同步设置失败，使用默认配置:', e);
            return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        }
    }

    saveConfig(newConfig) {
        const next = {
            ...this.config,
            ...newConfig,
            relay: { ...this.config.relay, ...(newConfig.relay || {}) }
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch (e) {
            console.error('[MAERS.Sync] 保存同步设置失败:', e);
            return false;
        }
        if (!this._isCurrentRelay(next.relay)) {
            this._replayRevision = ++this._relayRevision;
            this.pendingItemsCount = 0;
            this.localPendingSessionItems = [];
            clearDraftPhotos();
        }
        this.config = next;
        this.updateButtonBadge();
        void this.checkPendingRelayItems();
        return true;
    }

    getConfig() {
        return JSON.parse(JSON.stringify(this.config));
    }

    /**
     * 判断当前是否在本地开发服务器环境
     */
    isLocalHost() {
        const host = window.location.hostname;
        return ['localhost', '127.0.0.1', '[::1]', ''].includes(host) ||
            /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host);
    }

    /**
     * 计算当前生效的数据同步模式
     * @returns {'local' | 'relay'}
     */
    getEffectiveMode() {
        const { mode, relay } = this.config;

        if (mode === 'relay' || mode === 'local') return mode;
        return !this.isLocalHost() && relay?.endpoint ? 'relay' : 'local';
    }

    /**
     * 通用入队：串行推送到 Cloudflare Worker，远端确认接收后才执行 onQueued 更新内存状态。
     * 失败时不触碰内存，调用方据返回值保留编辑内容并提示。
     * @param {string} module - 业务域 (notes/photos/tags/doc 等)
     * @param {string} action - 动作名，需在 relay-actions 注册表登记
     * @param {Object} data - 动作载荷
     * @param {Function} [onQueued] - 入队成功后的内存状态更新
     * @returns {Promise<{success:boolean,msg?:string}>}
     */
    enqueue(module, action, data, onQueued = null, validate = null) {
        const { relay } = this.config;
        const request = [module, action, JSON.parse(canonicalJson(data))];
        return this._requests.enqueue(relay, request, async () => {
            try {
                validate?.();
                return await this._enqueue(relay, request, onQueued);
            } catch (error) {
                Toast.error(`暂存失败: ${error.message}`);
                return { success: false, msg: error.message };
            }
        });
    }

    reserveRelayRequest(relay, request, bucketId) {
        return this._requests.reserve(relay, request, bucketId);
    }

    finishRelayRequest(retry) {
        this._requests.finish(retry);
    }

    _missingRelaySecret() {
        Toast.error('未配置中继访问密码，请点击顶栏「同步」设置');
        this.openSettingsModal();
        return { success: false, msg: 'No Secret' };
    }

    async _enqueue(relay, request, onQueued) {
        if (!relay?.secret?.trim()) return this._missingRelaySecret();
        const retry = await this.reserveRelayRequest(relay, request);
        const { requestId, timestamp } = retry;
        const [module, action, data] = request;
        const queuedData = action === 'add' && !data.id ? { ...data, id: `${(data.type || 'n')[0]}_${requestId}` } : data;
        const payload = { module, action, data: queuedData, timestamp, requestId };
        const res = await cloudflareRelay.push(relay.endpoint, relay.secret, payload);
        if (!res.success) {
            Toast.error(`暂存失败: ${res.msg}`);
            return { success: false, msg: res.msg };
        }
        this.finishRelayRequest(retry);
        this.recordRelayDraft(payload, relay);
        try { onQueued?.(queuedData); } catch (error) {
            console.warn('[SyncManager] 草稿已暂存，页面状态更新失败:', error);
            Toast.warning('草稿已暂存，请手动刷新页面');
            return { success: true };
        }
        Toast.success(' 已存入云端暂存队列 (待电脑端合并)');
        return { success: true };
    }

    /** 只在云端确认后更新当前会话，徽章刷新与保存结果相互独立。 */
    recordRelayDraft(payload, relay, { refresh = true } = {}) {
        if (!this._isCurrentRelay(relay)) return;
        if (this.localPendingSessionItems.some(item => item.requestId === payload.requestId)) return;
        this._relayRevision++;
        this.localPendingSessionItems.push(payload);
        if (this.pendingItemsCount !== null) this.pendingItemsCount++;
        this.updateButtonBadge();
        if (refresh) void this.checkPendingRelayItems();
    }

    /**
     * CMS 节点动作入队（新建节点时预置 ID，入队成功后更新内存树）
     * @param {string} module - CMS 模块名
     * @param {string} action - 'add' | 'update' | 'delete' | 'move' | 'reorder' | 'lock' | 'unlock'
     */
    handleRelayAction(module, action, data, AppState) {
        return this.enqueue(module, action, data, queued => applyRelayState(module, action, queued, AppState),
            () => validateCmsNodeAction(AppState?.root || [], action, data));
    }

    /**
     * 保存整份文档：使用编辑前读取的版本检测冲突。
     * @param {string} doc - 文档标识
     * @param {*} content - 完整文档内容
     * @param {Object} options
     * @param {*} [options.base] - 编辑时实际读取的基线
     */
    async writeDocument(doc, content, { base, apiBase = '', mode = this.getEffectiveMode() } = {}) {
        try {
            const editor = this._privateDocs.get(doc);
            if (editor) {
                if (mode !== 'relay' || !this._isCurrentRelay(editor.relay)) throw Error('同步设置已变化，请重新加载页面');
                await requireCloudAdmin();
                content = doc === 'music' ? await editor.seal(content) : { ...content, root: await editor.seal(content.root) };
            } else if ((mode === 'relay' || isCloudPrivateAdmin()) && hasPrivateEditorState(content)) {
                throw Error('请重新加载已解锁的加密内容后再保存');
            }
            return await this._documents.write(doc, content, { base, apiBase, mode });
        } catch (error) {
            Toast.error(error.message);
            return { success: false, msg: error.message };
        }
    }

    /** 私密网站的标签从已保存快照中修改，保留当前视图尚未保存的排序和删除。 */
    async writePrivateSpaceTags(id, tags) {
        await requireCloudAdmin();
        const doc = 'space-tree';
        const current = this._privateDocs.get(doc);
        const base = this._documents.base(doc, 'relay');
        if (!base || this.getEffectiveMode() !== 'relay' || !current || !this._isCurrentRelay(current.relay)) {
            throw Error('请重新加载空间数据后再保存');
        }
        const editor = new PrivateDocument(['children']);
        const nodes = await editor.open(base.root);
        const find = list => {
            for (const node of list) {
                if (node.id === id) return node;
                const nested = find(node.children || []);
                if (nested) return nested;
            }
            return null;
        };
        const node = find(nodes);
        if (!node?._private) throw Error('请先解锁网站所属密码组');
        node.tags = tags;
        return this._documents.write(doc, { ...base, root: await editor.seal(nodes) }, { mode: 'relay', base });
    }

    /** 编辑基线独立于可变的页面数据，也区分本地和中继模式。 */
    rememberDocument(doc, content, mode = this.getEffectiveMode()) {
        this._documents.remember(doc, content, mode);
    }

    /** 已保存的单项变更同步到基线，保留页面上其余未保存的编辑。 */
    updateDocumentBase(doc, apply) {
        this._documents.update(doc, this.getEffectiveMode(), apply);
    }

    /**
     * 在已发布内容上叠加尚未合并的草稿，返回当前应显示的文档。
     * @param {string} doc - 文档标识
     * @param {*} base - 已发布内容
     * @param {Function} [onOther] - 处理文档快照以外的草稿 (item, content)
     */
    async loadDocument(doc, base, onOther = null, mode = this.getEffectiveMode()) {
        const relay = this.config.relay;
        const content = mode === 'relay' ? replayDocument(doc, base, await this.getPendingItems(), onOther) : base;
        this._privateDocs.delete(doc);
        this.rememberDocument(doc, content, mode);
        if (mode === 'relay' && ['music', 'space-tree'].includes(doc) && isCloudPrivateAdmin() && hasPrivateEnvelopes(content)) {
            await requireCloudAdmin();
            const editor = new PrivateDocument(doc === 'music' ? ['collections', 'albums'] : ['children']);
            editor.relay = relay;
            const nodes = await editor.open(doc === 'music' ? content : content.root);
            this._privateDocs.set(doc, editor);
            return doc === 'music' ? nodes : { ...content, root: nodes };
        }
        return content;
    }

    /** 管理视图读取和保存只经当前中继配置，工作明文留在调用方内存。 */
    async openPrivateDrafts(source, snapshot) {
        if (!hasPrivateEnvelopes(snapshot)) return new Map();
        const relay = this.config.relay;
        return openPrivateDrafts(source, snapshot, await this.getPendingItems(), data => {
            if (!this._isCurrentRelay(relay)) throw Error('同步设置已变化，请重新加载页面');
            return this.enqueue('private', 'replace', data);
        });
    }

    async uploadPrivatePhoto(file, group, progress = null, bucketId) {
        await requireCloudAdmin();
        const token = await getAccessToken(group);
        if (!token) throw Error('请先解锁内容所属的密码组');
        const relay = this.config.relay;
        const { endpoint, secret } = relay || {};
        if (!endpoint || !secret?.trim()) throw Error('请先设置云端中继地址和访问密码');
        const meter = progress || openProgress('正在上传私密图片', '');
        try {
            const { draftPreview, ...row } = await cloudflareRelay.uploadPrivatePhoto({ endpoint, secret, file, group, token, bucketId,
                onProgress: uploadMeter(meter) });
            if (!this._isCurrentRelay(relay)) throw Error('同步设置已变化，请重新加载页面');
            this.rememberDraftImage(row.path, draftPreview);
            return row;
        } finally {
            if (!progress) meter.close();
        }
    }

    /** 叠加未合并草稿后的标签分类（快照整份替换，改名/删除按序应用） */
    loadTagCategories(scope, base) {
        return this.loadDocument(`tags:${scope}`, base,
            (item, categories) => applyTagChange(item, scope, { categories }));
    }

    _isCurrentRelay(relay) {
        const current = this.config.relay;
        return relay?.endpoint === current?.endpoint && relay?.secret === current?.secret;
    }

    rememberDraftImage(path, preview) {
        rememberDraftPhoto(path, preview, this.config.relay.endpoint);
        this._relayRevision++;
    }

    /** 记录拉取开始时的配置和写入代次，供计数与回放分别校验。 */
    async _readPending() {
        const { relay } = this.config;
        if (!relay?.endpoint || !relay?.secret) return null;
        const revision = this._relayRevision;
        try {
            const response = await this._requests.pull(relay, revision);
            if (response?.success && Array.isArray(response.items)) {
                if (!this.isLocalHost() && this._isCurrentRelay(relay) && revision >= this._replayRevision) {
                    for (const [path, preview] of response.media) rememberDraftPhoto(path, preview, relay.endpoint);
                }
                return { relay, revision, items: response.items };
            }
        } catch (error) {
            console.warn('[MAERS.Sync] 拉取云端草稿失败:', error);
        }
        return null;
    }

    /** 合并云端与会话草稿，按完整载荷去重，保留同毫秒的不同上传。 */
    async getPendingItems() {
        const read = await this._readPending();
        const merged = [...this.localPendingSessionItems];
        if (!read || !this._isCurrentRelay(read.relay) || read.revision < this._replayRevision) return merged;
        const seen = new Set(merged.map(item => JSON.stringify(item)));
        for (const item of read.items) {
            const data = item?.data;
            if (!data) continue;
            const signature = JSON.stringify(data);
            if (seen.has(signature)) continue;
            merged.push(data);
            seen.add(signature);
        }
        return merged;
    }

    /** 回放 CMS 草稿，保留扩展动作（如加锁/解锁）回调。 */
    async applyPendingToState(module, AppState, onCustomAction = null) {
        if (!AppState) return;
        replayQueuedDrafts(module, AppState, await this.getPendingItems(), onCustomAction, isCloudPrivateAdmin());
    }

    /** 将尚未合并的上传、删除、排序与标签恢复到当前相册，刷新后仍保持一致。 */
    async applyPendingPhotos(category, photos) {
        replayPhotos(category, photos, await this.getPendingItems());
    }

    /**
     * 检查云端待合并草稿数量
     */
    async checkPendingRelayItems() {
        const { relay } = this.config;
        if (!relay?.endpoint || !relay?.secret) {
            this.pendingItemsCount = 0;
            this.updateButtonBadge();
            return 0;
        }
        const revision = this._relayRevision;
        const read = await this._readPending();
        if (!this._isCurrentRelay(relay) || revision !== this._relayRevision) return this.pendingItemsCount;
        this.pendingItemsCount = read ? read.items.length : null;
        this.updateButtonBadge();
        return this.pendingItemsCount;
    }

    /**
     * 电脑端：拉取云端草稿并一键合并写入本地数据库及文件
     */
    pullAndMerge() {
        if (!this._mergeRequest) {
            const progress = openProgress('正在拉取云端草稿', '');
            this._mergeRequest = mergeRelayQueue(this, cloudflareRelay, {
                progress,
                onAcknowledged: paths => {
                    clearDraftPhotos(paths);
                    this._replayRevision = ++this._relayRevision;
                }
            })
                .catch(error => { Toast.error('合并失败: ' + error.message); return false; })
                .finally(() => { progress.close(); this._mergeRequest = null; });
        }
        return this._mergeRequest;
    }

    /**
     * 在页面顶栏注入同步控制按钮
     * @param {HTMLElement} targetContainer 
     */
    injectSyncButton(targetContainer) {
        injectSyncControl(this, targetContainer);
    }

    /**
     * 异步刷新 Git 按钮徽章数量
     */
    async refreshGitStatusBadge() {
        try {
            if (!this.isLocalHost() || !document.getElementById('maers-sync-btn')) return;
            const gitStatus = await getLocalGitStatus();
            if (!gitStatus.success) return;
            this.pendingGitCount = Number(gitStatus.change_count) || 0;
            this.updateButtonBadge(false);
        } catch (error) {
            console.warn('[MAERS.Sync] 刷新 Git 计数失败:', error);
        }
    }

    /**
     * 生成顶栏按钮文案：本地模式同时展示云端待合并数与本地待 Git 数，二者互不遮挡
     * @returns {string}
     */
    getButtonLabel() {
        return syncControlLabel(this);
    }

    /**
     * 刷新按钮展示状态
     */
    updateButtonBadge(refreshGit = true) {
        try {
            updateSyncModalBadge(this);
            updateSyncToolbarButton(this);
            if (refreshGit) void this.refreshGitStatusBadge();
        } catch (error) {
            console.warn('[MAERS.Sync] 刷新同步徽章失败:', error);
        }
    }

    /**
     * 上传图片（本地保存，云端暂存至 KV）
     * @param {File|Blob} file 
     * @param {string} category 
     * @param {Object} target - 本地文章的模块和节点。
     */
    async uploadFile(file, category = '_notes', target = {}) {
        const progress = openProgress('正在上传图片', '');
        try {
            const mode = this.getEffectiveMode();
            if ((!target.node_id && mode === 'relay') || !this.isLocalHost()) {
                return await this._uploadToRelay(file, category, uploadMeter(progress));
            }
            // 本地环境：走本地 Python /upload 接口
            return await uploadLocalFile(file, category, target, progress);
        } finally { progress.close(); }
    }

    /**
     * 通过同步 Worker 暂存公开正文图片
     * @param {File|Blob} file - 待上传文件
     * @param {string} category - 分类
     */
    async _uploadToRelay(file, category, onProgress) {
        const { relay } = this.config;
        if (!relay?.secret?.trim()) return this._missingRelaySecret();
        const result = await cloudflareRelay.uploadFile(relay.endpoint, relay.secret, file, category, null, onProgress);
        if (!this._isCurrentRelay(relay)) return { success: false, msg: '同步设置已变化，请重新加载页面' };
        if (result.success) this.rememberDraftImage(result.relPath, result.draftPreview);
        return result;
    }

    /**
     * 打开同步设置弹窗
     */
    async openSettingsModal() {
        try {
            const { openSyncSettings } = await import('./sync-settings.module.js');
            void this.refreshGitStatusBadge();
            void this.checkPendingRelayItems();
            openSyncSettings(this);
        } catch (error) {
            console.error('[MAERS.Sync] 加载同步设置失败:', error);
            Toast.error('同步设置加载失败，请重试');
        }
    }

    /**
     * 打开 发布更新面板
     */
    async openGitCommitModal() {
        try {
            const { gitCommitManager } = await import('./git-commit.module.js');
            await gitCommitManager.openCommitModal({ syncManager: this });
        } catch (error) {
            console.error('[MAERS.Sync] 加载 发布面板失败:', error);
            Toast.error('发布面板加载失败，请重试');
        }
    }

    /**
     * 初始化图库后台（admin-photos.html）的统一模式入口
     * @param {Object} Controller - Photos Controller 实例
     */
    async initPhotosSyncBar(Controller) {
        this.Controller = {
            loadData: () => Controller.reloadData(),
            refreshView: () => window.location.reload()
        };
        this.injectSyncButton(document.querySelector('.header-actions'));
    }

    /**
     * 图库移动端/远程环境：批量直传图片至 Cloudflare R2 并推送 KV 暂存记录
     * @param {FileList|Array<File>} files - 待上传文件列表
     * @param {string} category - 相册分类 ID
     * @param {Array} loadedData - 前端当前图片状态列表（原地头部插入预览项）
     * @returns {Promise<{success:boolean, dupCount:number}>}
     */
    async uploadPhotosBatch(files, category, loadedData, tags = [], bucketId) {
        return uploadPhotoBatch(this, files, category, loadedData, tags, bucketId);
    }

}

export const syncManager = new SyncManager();
