/**
 * MAERS Sync Manager (sync-manager.module.js)
 * 职责：中继暂存同步管理器 (方案 3)
 * 实现手机端 0.1 秒存入 Cloudflare Worker，电脑端一键拉取合并入库
 * @version 2.0.0
 */
import { localFetch } from '../api-client.module.js';

import { Toast } from '../../shared/toast.module.js';
import { cloudflareRelay } from './cloudflare-relay.module.js';
import { openSyncSettings } from './sync-settings.module.js';
import { mergeRelayQueue, applyRelayState, replayQueuedDrafts, replayQueuedPhotos } from './sync-queue.module.js';
import { gitCommitManager } from './git-commit.module.js';

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
        this._relayRequests = new Map();
        this._relayTail = Promise.resolve();
        this._mergeRequest = null;
        this._appliedRelayKeys = new Set();
        this._photoUploads = new WeakMap();
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
            console.error('[SyncManager] Failed to load config:', e);
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
            this.config = next;
            this.updateButtonBadge();
            this.checkPendingRelayItems();
            return true;
        } catch (e) {
            console.error('[SyncManager] Failed to save config:', e);
            return false;
        }
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

        if (mode === 'relay') return 'relay';
        if (mode === 'local') return 'local';

        // 'auto' 模式下的策略：
        // 如果是 localhost 且处于本地环境，走本地 Python 后端
        if (this.isLocalHost()) {
            return 'local';
        }

        // 线上/移动端环境，优先走云端中继暂存
        if (relay?.endpoint) {
            return 'relay';
        }

        return 'local';
    }

    /**
     * 手机端：通过 Cloudflare Worker 进行 0.1 秒极速草稿入队
     * @param {string} module - 模块名 (record, notes 等)
     * @param {string} action - 操作类型: 'add' | 'update' | 'delete' | 'move' | 'reorder'
     * @param {Object} data - 数据载荷
     * @param {Object} AppState - 控制器状态
     */
    handleRelayAction(module, action, data, AppState) {
        if (action === 'add' && !data.id) data.id = `${(data.type || 'n')[0]}_${crypto.randomUUID()}`;
        const snapshot = JSON.parse(JSON.stringify(data));
        const key = JSON.stringify([module, action, snapshot]);
        if (this._relayRequests.has(key)) return this._relayRequests.get(key);
        const pending = this._relayTail.then(() => this._handleRelayAction(module, action, snapshot, AppState))
            .catch(error => ({ success: false, msg: error.message }))
            .finally(() => this._relayRequests.delete(key));
        this._relayRequests.set(key, pending);
        this._relayTail = pending;
        return pending;
    }

    async _handleRelayAction(module, action, data, AppState) {
        const { relay } = this.config;
        if (!relay?.secret?.trim()) {
            Toast.error('未配置中继访问密码，请点击顶栏「同步」设置');
            this.openSettingsModal();
            return { success: false, msg: 'No Secret' };
        }

        // 规范化数据，为新建节点预置 ID
        if (action === 'add' && !data.id) {
            data.id = `${(data.type || 'n')[0]}_${Date.now()}`;
        }

        // 构建待暂存的增量草稿包
        const payload = {
            module,
            action,
            data,
            timestamp: Date.now()
        };

        // 2. 0.1 秒极速推入 Cloudflare KV
        const res = await cloudflareRelay.push(relay.endpoint, relay.secret, payload);

        if (!res.success) {
            Toast.error(`暂存失败: ${res.msg}`);
            return { success: false, msg: res.msg };
        }
        // 远端确认接收后才更新本地状态，失败时保留编辑草稿。
        // 1. 同步维护前端内存状态（让手机端立刻看到卡片变化）
        applyRelayState(module, action, data, AppState);

        this.localPendingSessionItems.push(payload);
        this.pendingItemsCount++;
        this.updateButtonBadge();
        await this.checkPendingRelayItems();
        if (res.success) {
            Toast.success('⚡ 已存入云端暂存队列 (待电脑端合并)');
            return { success: true };
        } else {
            Toast.error(`暂存失败: ${res.msg}`);
            return { success: false, msg: res.msg };
        }
    }

    /** 拉取并合并云端与本会话草稿；完整载荷去重，保留同毫秒的不同上传。 */
    async getPendingItems() {
        const { relay } = this.config;
        const itemsToApply = [...this.localPendingSessionItems];

        // 若配置了中继密钥，异步拉取云端暂存队列
        if (relay?.endpoint && relay?.secret) {
            try {
                const res = await cloudflareRelay.pull(relay.endpoint, relay.secret);
                if (res.success && Array.isArray(res.items)) {
                    const seen = new Set(itemsToApply.map(x => JSON.stringify(x)));
                    for (const remoteItem of res.items) {
                        const d = remoteItem.data;
                        if (!d) continue;
                        const sig = JSON.stringify(d);
                        if (!seen.has(sig)) {
                            itemsToApply.push(d);
                            seen.add(sig);
                        }
                    }
                }
            } catch (e) {
                console.warn('[SyncManager] 拉取云端暂存队列失败:', e);
            }
        }

        return itemsToApply;
    }

    /** 回放 CMS 草稿，保留扩展动作（如加锁/解锁）回调。 */
    async applyPendingToState(module, AppState, onCustomAction = null) {
        if (!AppState) return;
        replayQueuedDrafts(module, AppState, await this.getPendingItems(), onCustomAction);
    }

    /** 将尚未合并的公开上传恢复到当前相册，刷新后仍可查看原图。 */
    async applyPendingPhotos(category, photos) {
        replayQueuedPhotos(category, photos, await this.getPendingItems());
    }

    /**
     * 检查云端待提交草稿数量，供本地合并与云端提交入口展示
     */
    async checkPendingRelayItems() {
        const { relay } = this.config;
        if (!relay?.endpoint || !relay?.secret) return 0;

        try {
            const res = await cloudflareRelay.pull(relay.endpoint, relay.secret);
            if (res.success && Array.isArray(res.items)) {
                this.pendingItemsCount = res.items.length;
                this.updateButtonBadge();
                return this.pendingItemsCount;
            }
        } catch (e) {
            console.warn('[SyncManager] Check pending items failed:', e);
        }
        return 0;
    }

    /**
     * 电脑端：拉取云端草稿并一键合并写入本地数据库及文件
     */
    pullAndMerge() {
        if (!this._mergeRequest) {
            this._mergeRequest = mergeRelayQueue(this, cloudflareRelay)
                .catch(error => { Toast.error('合并失败: ' + error.message); return false; })
                .finally(() => { this._mergeRequest = null; });
        }
        return this._mergeRequest;
    }

    /**
     * 在页面顶栏注入同步控制按钮
     * @param {HTMLElement} targetContainer 
     */
    injectSyncButton(targetContainer) {
        if (!targetContainer || document.getElementById('maers-sync-btn')) return;

        // 模式、同步与 Git 提交共用一个设置入口
        const btn = document.createElement('button');
        btn.id = 'maers-sync-btn';
        btn.className = 'maers-toolbar-btn';
        btn.onclick = (e) => {
            e.stopPropagation();
            this.openSettingsModal();
        };

        targetContainer.insertBefore(btn, targetContainer.firstChild);
        this.updateButtonBadge();

        // 启动时异步检测状态与草稿
        setTimeout(() => {
            this.checkPendingRelayItems();
        }, 1200);
    }

    /**
     * 异步刷新 Git 按钮徽章数量
     */
    async refreshGitStatusBadge() {
        if (!this.isLocalHost() || !document.getElementById('maers-sync-btn')) return;
        const gitStatus = await gitCommitManager.getLocalGitStatus();
        if (gitStatus.success) {
            this.pendingGitCount = Number(gitStatus.change_count) || 0;
            this.updateButtonBadge(false);
        }
    }

    /**
     * 生成顶栏按钮文案：本地模式同时展示云端待合并数与本地待 Git 数，二者互不遮挡
     * @returns {string}
     */
    getButtonLabel() {
        if (!this.isLocalHost()) {
            return this.pendingItemsCount > 0 ? `云端待Git(${this.pendingItemsCount})` : '云端模式';
        }
        const parts = [];
        if (this.pendingItemsCount > 0) parts.push(`待合并(${this.pendingItemsCount})`);
        if (this.pendingGitCount > 0) parts.push(`待Git(${this.pendingGitCount})`);
        return parts.length ? parts.join(' · ') : '本地模式';
    }

    /**
     * 刷新按钮展示状态
     */
    updateButtonBadge(refreshGit = true) {
        const modal = document.getElementById('maers-sync-modal');
        const gitTitle = modal?.querySelector('[data-role="git-count-title"]');
        if (gitTitle) gitTitle.textContent = `Git 一键提交(${this.isLocalHost() ? this.pendingGitCount : this.pendingItemsCount})`;
        const pullBtn = modal?.querySelector('#btn-manual-pull');
        if (pullBtn) pullBtn.textContent = `拉取合并 (${this.pendingItemsCount})`;
        const btn = document.getElementById('maers-sync-btn');
        if (!btn) return;

        // 清除所有状态类，再按当前状态设置
        btn.classList.remove('maers-toolbar-btn--sync-local', 'maers-toolbar-btn--sync-relay', 'maers-toolbar-btn--sync-pending');

        if (this.isLocalHost()) {
            btn.textContent = this.getButtonLabel();
            btn.title = this.pendingItemsCount > 0
                ? `有 ${this.pendingItemsCount} 条云端草稿待合并；点击打开设置，可拉取合并或提交 Git`
                : '点击打开设置，可配置同步或提交 Git';
            btn.classList.add(this.pendingGitCount > 0 || this.pendingItemsCount > 0
                ? 'maers-toolbar-btn--sync-pending' : 'maers-toolbar-btn--sync-local');
        } else {
            btn.textContent = this.getButtonLabel();
            btn.title = '点击打开设置，可配置同步或将云端草稿提交到 GitHub';
            btn.classList.add('maers-toolbar-btn--sync-relay');
        }

        if (refreshGit) this.refreshGitStatusBadge();
    }

    /**
     * 上传图片（自动分流：本地走 Python / 移动端走 Cloudflare R2，支持公私桶分流）
     * @param {File|Blob} file 
     * @param {string} category 
     * @param {'public'|'private'} scope 
     */
    async uploadFile(file, category = '_notes', scope = 'public', target = {}) {
        const mode = this.getEffectiveMode();
        if (scope === 'private' || (!target.node_id && mode === 'relay') || !this.isLocalHost()) {
            const { relay } = this.config;
            if (!relay?.secret?.trim()) {
                Toast.error('未配置中继访问密码，请点击顶栏「同步」设置');
                this.openSettingsModal();
                return { success: false, msg: 'No Secret' };
            }
            return await cloudflareRelay.uploadFile(relay.endpoint, relay.secret, file, category, scope);
        }

        // 本地环境：走本地 Python /upload 接口
        try {
            const ext = file.name ? file.name.split('.').pop() : 'jpg';
            const safeName = `img_${crypto.randomUUID()}.${/^[a-z0-9]{1,10}$/i.test(ext) ? ext : 'bin'}`;
            const query = new URLSearchParams({ category, name: safeName, ...target });
            const res = await localFetch(`/upload?${query}`, {
                method: 'POST',
                body: file
            });
            if (res.ok) {
                const data = await res.json();
                if (data.success === false || data.error || !data.path) return { success: false, msg: data.error || data.msg || '上传未返回文件路径' };
                if (data.sync?.state === 'pending') Toast.warning('图片已保存到本机，云端同步尚未完成；请在后台备份与恢复中重试');
                return {
                    success: true,
                    path: data.path,
                    relPath: data.relPath || data.path,
                    sync: data.sync,
                    name: data.name
                };
            } else {
                return { success: false, msg: '本地上传失败' };
            }
        } catch (e) {
            return { success: false, msg: e.message };
        }
    }

    /**
     * 打开同步设置弹窗
     */
    openSettingsModal() {
        this.refreshGitStatusBadge();
        this.checkPendingRelayItems();
        openSyncSettings(this);
    }

    /**
     * 打开 Git 一键提交面板
     */
    openGitCommitModal() {
        gitCommitManager.openCommitModal({
            syncManager: this,
            currentController: this.Controller
        });
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
    async uploadPhotosBatch(files, category, loadedData) {
        const relayConfig = this.getConfig().relay;
        if (!relayConfig?.secret?.trim()) {
            Toast.error('未配置同步密码，请点击顶栏「同步」按钮设置后重试');
            this.openSettingsModal();
            return { success: false, dupCount: 0 };
        }

        let uploadedCount = 0, failedCount = 0;
        for (const file of files) {
            Toast.info(`上传中: ${file.name}...`);
            let pending = this._photoUploads.get(file);
            if (!pending || pending.category !== category) {
                pending = { category, upload: this.uploadFile(file, category, 'public') };
                this._photoUploads.set(file, pending);
            }
            try {
                const res = await pending.upload;
                if (!res.success) { this._photoUploads.delete(file); throw new Error(res.msg); }
                // R2 已收到文件但登记失败时，保留结果供同一文件重试，避免重复上传。
                const registration = await this.handleRelayAction('photos', 'upload', {
                    category, path: res.relPath || res.path, name: res.name, scope: 'public'
                }, null);
                if (!registration.success) throw new Error(registration.msg || '图片登记失败');
                this._photoUploads.delete(file);
                uploadedCount++;
                if (Array.isArray(loadedData) && !loadedData.some(item => item.path === res.path)) {
                    loadedData.unshift({ id: `relay_${crypto.randomUUID()}`, path: res.path,
                        thumb: res.path, preview: res.path, name: res.name, tags: [], _pendingRelay: true });
                }
            } catch (error) {
                failedCount++;
                Toast.error(`${file.name} 上传或登记失败: ${error.message}`);
            }
        }
        if (uploadedCount) Toast.success(`已上传并登记 ${uploadedCount} 张图片${failedCount ? `，${failedCount} 张失败` : ''}`);
        return { success: uploadedCount > 0, dupCount: 0, uploadedCount, failedCount };

    }
}

export const syncManager = new SyncManager();
