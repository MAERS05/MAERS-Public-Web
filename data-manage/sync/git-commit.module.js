/**
 * MAERS Git Commit Manager (git-commit.module.js)
 * 职责：提供跨端统一的一键 Git 提交与推送能力
 * 1. 局域网/本地模式：调用桌面 Python 后端原生执行 git add . && git commit && git push
 * 2. 纯云端/移动端模式：调用 GitHub REST API 将暂存草稿原子化提交并推送到 GitHub 仓库
 * @version 1.0.0
 */
import { localFetch } from '../api-client.module.js';

import { Toast } from '../../shared/toast.module.js';
import { Utils } from '../../shared/utils.module.js';
import { githubSync } from './github-sync.module.js';
import { cloudflareRelay } from './cloudflare-relay.module.js';

const GITHUB_CONFIG_KEY = 'maers_github_config';
const PHOTO_LOCAL_GIT_MESSAGE = '图片请在电脑本地 Git。请先在电脑后台“拉取合并”，生成 WebP/AVIF 后再提交。';

const DEFAULT_GITHUB_CONFIG = {
    token: '',
    repo: '',
    branch: 'main'
};

export class GitCommitManager {
    constructor() {
        this.githubConfig = this._loadGitHubConfig();
        this.isCommitting = false;
    }

    _loadGitHubConfig() {
        try {
            const raw = localStorage.getItem(GITHUB_CONFIG_KEY);
            if (!raw) return { ...DEFAULT_GITHUB_CONFIG };
            return { ...DEFAULT_GITHUB_CONFIG, ...JSON.parse(raw) };
        } catch (e) {
            console.error('[GitCommitManager] 读取 GitHub 配置失败:', e);
            return { ...DEFAULT_GITHUB_CONFIG };
        }
    }

    saveGitHubConfig(newConfig) {
        this.githubConfig = { ...this.githubConfig, ...newConfig };
        try {
            localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify(this.githubConfig));
            return true;
        } catch (e) {
            console.error('[GitCommitManager] 保存 GitHub 配置失败:', e);
            return false;
        }
    }

    getGitHubConfig() {
        return { ...this.githubConfig };
    }

    /**
     * 检查本地 Git 接口版本；忙碌或旧版后台都不能误判成云端模式。
     */
    async checkLocalBackendAvailable() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        try {
            const res = await fetch('/api/git/progress', {
                signal: controller.signal,
                cache: 'no-store', redirect: 'error'
            });
            if (res.status === 404 || (res.ok && (await res.json()).api_version !== 1)) {
                return { success: false, msg: '本地后台版本未更新，请完整退出后台后重新打开；仅刷新网页无效。' };
            }
            return { success: res.ok, msg: res.ok ? '' : `本地后台检查失败（HTTP ${res.status}），请重新打开后台。` };
        } catch {
            return { success: false, msg: '本地后台暂时没有响应，请确认后台服务已启动后重新打开此窗口。' };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * 获取本地 Git 详细状态
     */
    async getLocalGitStatus() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
            // Git 元数据不需要私密内容解锁，避免进度读取等待加密管理初始化。
            const res = await fetch('/api/git/status', { cache: 'no-store', signal: controller.signal, redirect: 'error' });
            if (res.ok) {
                return await res.json();
            }
            return { success: false, msg: `HTTP ${res.status}` };
        } catch (e) {
            return { success: false, msg: e.message };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * 本地模式：调用 Python 后端执行一键提交并推送
     * @param {string} message - 提交说明
     */
    async commitAndPushLocal(message, onProgress = () => {}) {
        let finished = false;
        let timer;
        let polling;
        const poll = async () => {
            polling = new AbortController();
            const timeout = setTimeout(() => polling.abort(), 2000);
            try {
                const response = await fetch('/api/git/progress', { cache: 'no-store', signal: polling.signal, redirect: 'error' });
                if (response.ok) {
                    const progress = await response.json();
                    if (!finished) onProgress(progress);
                }
            } catch { /* 进度读取失败不等于提交失败，最终结果以提交请求为准。 */ }
            finally {
                clearTimeout(timeout);
                if (!finished) timer = setTimeout(poll, 1000);
            }
        };
        timer = setTimeout(poll, 1000);
        try {
            const res = await localFetch('/api/git/commit-push', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message || '' })
            });

            const data = await res.json();
            return data;
        } catch (e) {
            return { success: false, step: 'unknown', msg: '连接中断，后台可能仍在执行；请核对 Git 状态后再操作' };
        } finally {
            finished = true;
            clearTimeout(timer);
            polling?.abort();
        }
    }

    /**
     * 云端模式：将 Cloudflare KV 中的未合并草稿通过 GitHub REST API 提交至仓库
     * @param {Object} options
     * @param {Array} options.items - 云端待合并草稿列表
     * @param {string} options.message - 提交说明
     * @param {Object} options.relayConfig - Cloudflare 配置 (用于后续 ack 清空)
     */
    async commitDraftsViaGitHub({ items = [], message, relayConfig, currentModuleTree = null, currentModuleName = null }) {
        // 图片必须先经过本地图像流水线；提示后完整保留队列，不提交也不确认删除。
        if (items.some(item => {
            const payload = item?.module ? item : item?.data;
            return payload?.module === 'photos' && payload?.action === 'upload';
        })) return { success: false, msg: PHOTO_LOCAL_GIT_MESSAGE };
        const { token, repo, branch } = this.githubConfig;
        if (!token?.trim()) {
            return { success: false, needToken: true, msg: '未配置 GitHub Token' };
        }

        if (!items.length && !currentModuleTree) {
            return { success: false, msg: '没有检测到可提交的草稿改动' };
        }

        // 整理待提交的文件列表
        const filesMap = new Map();

        // 1. 如果传入了当前页面的最新树结构
        if (currentModuleTree && currentModuleName) {
            const treePath = `data/${currentModuleName}-tree.json`;
            // 统一写入标准格式 { root: [...] }，防止裸数组覆盖导致线上数据为空
            const treePayload = Array.isArray(currentModuleTree)
                ? { root: currentModuleTree }
                : currentModuleTree;
            filesMap.set(treePath, {
                path: treePath,
                content: JSON.stringify(treePayload, null, 2)
            });
        }

        // 2. 解析草稿项中的正文更新与新增
        const ackKeys = [];
        for (const item of items) {
            const payload = item.data || item;
            const { module, action, data } = payload;
            if (item.key) ackKeys.push(item.key);

            if (module && action === 'add' && data?.type === 'note' && data?.content) {
                const safeTitle = (data.title || 'Untitled').replace(/[\\/*?:"<>|]/g, '').trim();
                const notePath = `data/${module}/${safeTitle}.md`;
                filesMap.set(notePath, {
                    path: notePath,
                    content: data.content || ''
                });
            } else if (module && action === 'update' && data?.data?.content !== undefined) {
                const safeTitle = (data.data.title || data.title || 'Untitled').replace(/[\\/*?:"<>|]/g, '').trim();
                const notePath = `data/${module}/${safeTitle}.md`;
                filesMap.set(notePath, {
                    path: notePath,
                    content: data.data.content || ''
                });
            }
        }

        const filesToCommit = Array.from(filesMap.values());
        if (filesToCommit.length === 0) {
            return { success: false, msg: '未能从草稿中提取出有效的文件变更' };
        }

        // 调用 GitHub API 批量提交
        const commitRes = await githubSync.commitFiles({
            token,
            repo,
            branch,
            files: filesToCommit,
            message: message || `chore: 云端同步 ${filesToCommit.length} 个文件`
        });

        if (commitRes.success) {
            // 清理已提交的 Cloudflare KV 暂存项
            if (ackKeys.length > 0 && relayConfig?.endpoint && relayConfig?.secret) {
                try {
                    await cloudflareRelay.ack(relayConfig.endpoint, relayConfig.secret, ackKeys);
                } catch (e) {
                    console.warn('[GitCommitManager] 清理 KV 暂存失败:', e);
                }
            }
            return {
                success: true,
                commitHash: commitRes.commitSha ? commitRes.commitSha.substring(0, 7) : '',
                filesCount: filesToCommit.length,
                msg: `成功提交 ${filesToCommit.length} 个文件到 GitHub 仓库 (${branch} 分支)！`
            };
        } else {
            return {
                success: false,
                msg: commitRes.msg || 'GitHub API 提交失败'
            };
        }
    }

    /**
     * 生成默认的语义化提交信息
     */
    getDefaultCommitMessage(isLocalMode = true) {
        const now = new Date();
        const YYYY = now.getFullYear();
        const MM = String(now.getMonth() + 1).padStart(2, '0');
        const DD = String(now.getDate()).padStart(2, '0');
        const HH = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        return `chore: ${isLocalMode ? '本地改动' : '云端同步改动'} ${YYYY}-${MM}-${DD} ${HH}:${mm}`;
    }

    /**
     * 打开全端通用的 Git 提交弹窗
     * @param {Object} options
     * @param {Object} options.syncManager - 跨端同步管理器实例
     * @param {Object} options.currentController - 当前页面的 Controller（可选）
     */
    async openCommitModal({ syncManager, currentController } = {}) {
        const existing = document.getElementById('maers-git-commit-modal');
        if (existing && this.isCommitting) {
            existing.style.display = '';
            return;
        }
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'maers-git-commit-modal';
        modal.className = 'mlock-overlay';
        modal.style.zIndex = '100000';

        modal.innerHTML = `
            <div class="mlock-box" style="width: min(560px, 94vw);">
                <div class="mlock-header">
                    <div class="mlock-title-group">
                        <span class="mlock-title">一键提交所有改动到 Git</span>
                        <span class="mlock-sub">提交改动并推送到仓库；本地模式会先执行检查</span>
                    </div>
                </div>
                <div class="mlock-body" style="gap: 14px; padding-bottom: 14px;">

                    <div class="git-env-badge" id="git-env-badge">
                        <span id="git-env-text">正在检测 Git 运行环境...</span>
                        <span class="git-env-badge__branch" id="git-branch-text"></span>
                    </div>

                    <div class="git-changes-panel" id="git-changes-panel">
                        <div style="text-align:center;">正在获取改动列表...</div>
                    </div>

                    <div class="sync-field">
                        <label class="sync-field__label">提交说明 (Commit Message)</label>
                        <input type="text" id="git-commit-msg-input" class="mlock-input" value="${this.getDefaultCommitMessage()}" placeholder="输入提交说明">
                    </div>

                    <div class="git-cloud-drawer" id="git-cloud-config-drawer">
                        <div class="git-cloud-drawer__warn">
                            未检测到电脑本地后端。当前为<strong>移动端直连模式</strong>，改动将直接通过 GitHub REST API 提交到远端仓库。
                            <br>${PHOTO_LOCAL_GIT_MESSAGE}
                        </div>
                        <div class="sync-field">
                            <label class="sync-field__label">GitHub Token (具有 repo 读写权限)</label>
                            <input type="password" id="git-cloud-token" class="mlock-input" value="${this.githubConfig.token || ''}" placeholder="ghp_xxxxxxxxxxxx">
                        </div>
                        <div class="sync-field__row" style="gap:10px; align-items:flex-end;">
                            <div class="sync-field" style="flex:2;">
                                <label class="sync-field__label">仓库 (owner/repo)</label>
                                <input type="text" id="git-cloud-repo" class="mlock-input" value="${this.githubConfig.repo || ''}" placeholder="owner/repository">
                            </div>
                            <div class="sync-field" style="flex:1;">
                                <label class="sync-field__label">分支</label>
                                <input type="text" id="git-cloud-branch" class="mlock-input" value="${this.githubConfig.branch || 'main'}">
                            </div>
                        </div>
                    </div>

                    <div class="git-log-area" id="git-log-area"></div>

                </div>
                <div class="mlock-footer">
                    <button type="button" id="git-modal-cancel" class="mlock-btn-secondary">取消</button>
                    <button type="button" id="git-modal-submit" class="mlock-btn-primary" style="background:linear-gradient(135deg,#2ed573,#00b894);">
                        提交并推送到 GitHub
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);


        const closeModal = () => {
            if (this.isCommitting) modal.style.display = 'none';
            else modal.remove();
        };
        // 点击遮罩层关闭
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
        modal.querySelector('#git-modal-cancel').onclick = closeModal;

        const envBadge = modal.querySelector('#git-env-badge');
        const envText = modal.querySelector('#git-env-text');
        const branchText = modal.querySelector('#git-branch-text');
        const changesPanel = modal.querySelector('#git-changes-panel');
        const cloudDrawer = modal.querySelector('#git-cloud-config-drawer');
        const submitBtn = modal.querySelector('#git-modal-submit');
        const logArea = modal.querySelector('#git-log-area');
        const msgInput = modal.querySelector('#git-commit-msg-input');

        const isLocalMode = syncManager?.isLocalHost?.() ?? ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
        let localStatusData = null;

        // 步骤 1：检测环境与状态
        if (isLocalMode) {
            envText.textContent = '本地模式';
            const backend = await this.checkLocalBackendAvailable();
            if (!backend.success) {
                changesPanel.textContent = backend.msg;
                submitBtn.disabled = true;
                submitBtn.textContent = '本地后台未就绪';
                return;
            }
            localStatusData = await this.getLocalGitStatus();

            if (localStatusData.success) {
                envText.innerHTML = `<strong>本地后端已连接</strong> (局域网/开发模式)`;
                branchText.textContent = `分支: ${localStatusData.branch || 'main'}`;

                // 如果有未合并的云端草稿，一并显示
                const pendingRelayCount = syncManager?.pendingItemsCount || 0;
                let html = '';
                if (pendingRelayCount > 0) {
                    html += `<div style="color: #ffa502; font-weight: bold; margin-bottom: 6px;">包含 ${pendingRelayCount} 条未合并的云端草稿 (提交前将自动合并入库)</div>`;
                }

                if (localStatusData.change_count > 0) {
                    html += `<div style="font-weight: 600; margin-bottom: 4px;">待提交的本地变动 (${localStatusData.change_count} 项):</div>`;
                    localStatusData.changes.slice(0, 15).forEach(c => {
                        const color = c.status.includes('M') ? '#1e90ff' : (c.status.includes('A') || c.status === '??' ? '#2ed573' : '#ff4757');
                        html += `<div style="color: ${color}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">[${Utils.escapeHtml(c.status)}] ${Utils.escapeHtml(c.file)}</div>`;
                    });
                    if (localStatusData.change_count > 15) {
                        html += `<div style="color: var(--text-sub, #888);">... 以及其余 ${localStatusData.change_count - 15} 项文件</div>`;
                    }
                } else if (pendingRelayCount === 0) {
                    html += `<div style="color: #2ed573; text-align: center; padding: 10px 0;">本地工作区干净，无未提交改动</div>`;
                }
                changesPanel.innerHTML = html;
            } else {
                changesPanel.textContent = `Git 状态查询失败: ${localStatusData.msg}`;
                submitBtn.disabled = true;
                return;
            }
        } else {
            // 云端模式
            cloudDrawer.classList.add('visible');
            envText.innerHTML = `<strong>云端中继模式</strong> (移动端 / 无本地后端)`;
            branchText.textContent = `目标: ${this.githubConfig.branch || 'main'}`;

            // 查询 Cloudflare KV 中的草稿
            const relayCfg = syncManager?.getConfig()?.relay;
            let pendingItems = [];
            if (relayCfg?.endpoint && relayCfg?.secret) {
                try {
                    const pullRes = await cloudflareRelay.pull(relayCfg.endpoint, relayCfg.secret);
                    if (pullRes.success && Array.isArray(pullRes.items)) {
                        pendingItems = pullRes.items;
                    }
                } catch (e) {
                    console.warn(e);
                }
            }

            if (pendingItems.length > 0) {
                let html = `<div style="color: #2ed573; font-weight: 600; margin-bottom: 6px;">检测到 ${pendingItems.length} 条云端暂存草稿待提交至 Git:</div>`;
                pendingItems.slice(0, 10).forEach(it => {
                    const d = it.data || it;
                    html += `<div>• [${d.module || 'data'}] ${d.action}: ${d.data?.title || d.data?.id || '未命名'}</div>`;
                });
                if (pendingItems.length > 10) {
                    html += `<div>... 以及其余 ${pendingItems.length - 10} 条</div>`;
                }
                changesPanel.innerHTML = html;
            } else {
                changesPanel.innerHTML = `<div style="color: var(--text-sub, #aaa); text-align: center; padding: 10px 0;">当前暂存队列为空。若当前页面有编辑中的内容，也将包含在提交中。</div>`;
            }
        }

        msgInput.value = this.getDefaultCommitMessage(isLocalMode);
        // 步骤 2：提交按钮逻辑
        submitBtn.onclick = async () => {
            if (this.isCommitting) return;
            const message = msgInput.value.trim() || this.getDefaultCommitMessage(isLocalMode);

            this.isCommitting = true;
            msgInput.disabled = true;
            submitBtn.disabled = true;
            submitBtn.textContent = '正在准备…';
            modal.querySelector('#git-modal-cancel').textContent = '关闭（任务继续）';
            logArea.classList.add('visible');
            logArea.textContent = '开始准备提交任务...\n';

            try {
                if (isLocalMode) {
                    // 本地模式：先合并云端草稿（如果有）
                    if (syncManager && syncManager.pendingItemsCount > 0) {
                        logArea.textContent += '正在将云端草稿拉取合并入本地库...\n';
                        await syncManager.pullAndMerge();
                    }

                    let lastStep = '';
                    const res = await this.commitAndPushLocal(message, progress => {
                        if (progress.step === lastStep || !['prepare', 'pre_check', 'commit', 'push'].includes(progress.step)) return;
                        lastStep = progress.step;
                        logArea.textContent += `${progress.msg}\n`;
                        submitBtn.textContent = { prepare: '正在准备…', pre_check: '正在检查…',
                            commit: '正在本地提交…', push: '已提交，正在校验并推送…' }[progress.step];
                        if (progress.step === 'push') changesPanel.textContent = '本地提交已保存，正在校验并推送到远端。';
                    });
                    if (res.success) {
                        logArea.textContent += `\n${res.msg}\n`;
                        if (res.commit_hash) logArea.textContent += `Commit: ${res.commit_hash}\n`;
                        if (res.push_output) {
                            logArea.textContent += `[Push Output]:\n${res.push_output}\n`;
                        }
                        Toast.success(res.msg);
                        submitBtn.textContent = res.step === 'none' ? '无需提交' : '推送成功';
                        setTimeout(() => closeModal(), 2000);
                    } else {
                        logArea.textContent += `\n${res.msg}\n`;
                        const uncertain = ['unknown', 'push_unknown'].includes(res.step);
                        if (uncertain) Toast.warning(res.msg);
                        else Toast.error(res.msg);
                        submitBtn.disabled = false;
                        submitBtn.textContent = uncertain ? '核对状态后重试' : res.step === 'push' ? '重试推送' : '重试提交';
                    }
                } else {
                    // 云端模式：保存 GitHub 配置
                    const token = modal.querySelector('#git-cloud-token').value.trim();
                    const repo = modal.querySelector('#git-cloud-repo').value.trim();
                    const branch = modal.querySelector('#git-cloud-branch').value.trim();

                    if (!token) {
                        Toast.warning('请先输入 GitHub Token');
                        modal.querySelector('#git-cloud-token').focus();
                        this.isCommitting = false;
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = `<span>提交并推送到 GitHub</span>`;
                        return;
                    }

                    this.saveGitHubConfig({ token, repo, branch });

                    logArea.textContent += '正在拉取云端草稿队列...\n';
                    const relayCfg = syncManager?.getConfig()?.relay;
                    let pendingItems = [];
                    if (relayCfg?.endpoint && relayCfg?.secret) {
                        const pullRes = await cloudflareRelay.pull(relayCfg.endpoint, relayCfg.secret);
                        if (pullRes.success && Array.isArray(pullRes.items)) {
                            pendingItems = pullRes.items;
                        }
                    }

                    logArea.textContent += `组装文件变动 (共 ${pendingItems.length} 项草稿)...\n`;
                    logArea.textContent += '正在通过 GitHub REST API 原子化提交...\n';

                    const res = await this.commitDraftsViaGitHub({
                        items: pendingItems,
                        message,
                        relayConfig: relayCfg,
                        currentModuleTree: currentController?.AppState?.root || null,
                        currentModuleName: currentController?.CONFIG?.CURRENT_MODULE || null
                    });

                    if (res.success) {
                        logArea.textContent += `\n提交成功！Commit SHA: ${res.commitHash}\n`;
                        logArea.textContent += `${res.msg}\n`;
                        Toast.success('已成功提交至 GitHub！Vercel 即将自动触发构建上线。');
                        submitBtn.innerHTML = `<span>提交成功</span>`;
                        setTimeout(() => closeModal(), 2000);
                    } else {
                        logArea.textContent += `\n提交失败: ${res.msg}\n`;
                        Toast.error(`提交失败: ${res.msg}`);
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = `<span>重试提交</span>`;
                    }
                }
            } catch (err) {
                logArea.textContent += `\n发生异常: ${err.message}\n`;
                Toast.error(`操作异常: ${err.message}`);
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<span>重试提交</span>`;
            } finally {
                this.isCommitting = false;
                msgInput.disabled = false;
                modal.querySelector('#git-modal-cancel').textContent = '关闭';
                syncManager?.refreshGitStatusBadge();
                syncManager?.checkPendingRelayItems();
            }
        };
    }
}

export const gitCommitManager = new GitCommitManager();
