/**
 * MAERS Git Commit Manager (git-commit.module.js)
 * 职责：电脑本地的一键 发布更新与推送。
 * 发布只有一条通道：云端草稿先由电脑「拉取合并」写入本地文件，再由本地 发布更新。
 * 云端（手机）模式不直接提交：浏览器无法完整执行加密迁移、图片衍生图与跨模块文件组装，
 * 任何绕过本地合并的提交都会造成漏提交或误确认草稿。
 * @version 1.0.0
 */
import { localFetch } from '../api-client.module.js';

import { Toast } from '../../shared/toast.module.js';
import { Utils } from '../../shared/utils.module.js';
import { cloudflareRelay } from './cloudflare-relay.module.js';
import { getLocalGitStatus } from './sync-requests.module.js';

/** 草稿摘要：模块 + 动作 + 可读标识 */
export function describeDraft(item) {
    const draft = item.data || item;
    if (draft.module === 'photos' && draft.action === 'upload') {
        return `图片上传 · 分类 ${draft.data?.category || '未知'} · ${draft.data?.name || draft.data?.path || '未命名图片'}`;
    }
    if (draft.module === 'private' && draft.action === 'replace') {
        const labels = { notes: '笔记', record: '记录', literature: '文学', games: '游戏', videos: '影视', album: '相册' };
        return `${labels[draft.data?.source] || '内容'} · 加密修改`;
    }
    if (draft.data?.privateEdit) return draft.data.doc === 'music' ? '音乐 · 含加密内容的修改' : '空间 · 含加密内容的修改';
    const detail = draft.data?.title || draft.data?.doc || draft.data?.scope || draft.data?.id || draft.data?.path || '';
    return `[${draft.module || 'data'}] ${draft.action}${detail ? `: ${detail}` : ''}`;
}

export class GitCommitManager {
    constructor() {
        this.isCommitting = false;
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
     * 调用 Python 后端执行一键发布更新
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
     * 生成默认的语义化提交信息
     */
    getDefaultCommitMessage() {
        const now = new Date();
        const YYYY = now.getFullYear();
        const MM = String(now.getMonth() + 1).padStart(2, '0');
        const DD = String(now.getDate()).padStart(2, '0');
        const HH = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        return `chore: 本地改动 ${YYYY}-${MM}-${DD} ${HH}:${mm}`;
    }

    /**
     * 打开 发布更新弹窗：本地模式可提交；云端模式只展示待合并草稿并说明发布流程
     * @param {Object} options
     * @param {Object} options.syncManager - 跨端同步管理器实例
     */
    async openCommitModal({ syncManager } = {}) {
        const existing = document.getElementById('maers-git-commit-modal');
        if (existing && this.isCommitting) {
            existing.style.display = '';
            return;
        }
        if (existing) existing.remove();

        const isLocalMode = syncManager?.isLocalHost?.() ?? ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
        const modal = document.createElement('div');
        modal.id = 'maers-git-commit-modal';
        modal.className = 'mlock-overlay';
        modal.style.zIndex = '100000';

        modal.innerHTML = `
            <div class="mlock-box" style="width: min(560px, 94vw);">
                <div class="mlock-header">
                    <div class="mlock-title-group">
                        <span class="mlock-title">${isLocalMode ? '一键提交所有改动到 Git' : '云端草稿'}</span>
                        <span class="mlock-sub">${isLocalMode ? '先合并云端草稿，再发布更新到仓库；提交前会执行检查' : '查看暂存记录，待电脑合并后发布'}</span>
                    </div>
                </div>
                <div class="mlock-body" style="gap: 14px; padding-bottom: 14px;">

                    <div class="git-env-badge" id="git-env-badge">
                        <span id="git-env-text">${isLocalMode ? '正在检测 Git 运行环境...' : '云端模式'}</span>
                        <span class="git-env-badge__branch" id="git-branch-text"></span>
                    </div>

                    <div class="git-changes-panel" id="git-changes-panel">
                        <div style="text-align:center;">正在获取改动列表...</div>
                    </div>

                    <div class="sync-field" id="git-message-field">
                        <label class="sync-field__label">提交说明 (Commit Message)</label>
                        <input type="text" id="git-commit-msg-input" class="mlock-input" value="${this.getDefaultCommitMessage()}" placeholder="输入提交说明">
                    </div>

                    <div class="git-log-area" id="git-log-area"></div>

                </div>
                <div class="mlock-footer">
                    <button type="button" id="git-modal-cancel" class="mlock-btn-secondary">${isLocalMode ? '取消' : '关闭'}</button>
                    <button type="button" id="git-modal-submit" class="mlock-btn-primary" style="background:linear-gradient(135deg,#2ed573,#00b894);">
                        ${isLocalMode ? '发布更新到 GitHub' : '待电脑合并后发布'}
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

        const envText = modal.querySelector('#git-env-text');
        const branchText = modal.querySelector('#git-branch-text');
        const changesPanel = modal.querySelector('#git-changes-panel');
        const submitBtn = modal.querySelector('#git-modal-submit');
        const logArea = modal.querySelector('#git-log-area');
        const msgInput = modal.querySelector('#git-commit-msg-input');

        // 云端（手机）模式：不提供提交，仅展示草稿并说明发布流程
        if (!isLocalMode) {
            envText.textContent = '云端模式';
            modal.querySelector('#git-message-field').style.display = 'none';
            submitBtn.disabled = true;
            submitBtn.setAttribute('aria-disabled', 'true');
            submitBtn.classList.add('maers-local-disabled');
            submitBtn.textContent = '待电脑合并后发布';
            const relayCfg = syncManager?.getConfig()?.relay;
            if (!relayCfg?.endpoint || !relayCfg?.secret) {
                changesPanel.textContent = '请先在同步设置中配置中继地址和访问密码，再查看草稿。';
                return;
            }
            const pullRes = await cloudflareRelay.pull(relayCfg.endpoint, relayCfg.secret);
            if (!pullRes.success) {
                changesPanel.textContent = `读取草稿失败：${pullRes.msg || '请稍后重试'}`;
                return;
            }
            const pendingItems = pullRes.items || [];
            const guide = '<div style="margin-top:8px;">在电脑本地后台拉取合并，再提交并发布，访客才能看到修改。</div>';
            changesPanel.innerHTML = pendingItems.length
                ? `<div style="color:#2ed573; font-weight:600; margin-bottom:6px;">待电脑合并草稿 ${pendingItems.length} 条：</div>` +
                  pendingItems.slice(0, 10).map(item => `<div>• ${Utils.escapeHtml(describeDraft(item))}</div>`).join('') +
                  (pendingItems.length > 10 ? `<div>... 以及其余 ${pendingItems.length - 10} 条</div>` : '') + guide
                : `<div style="color: var(--text-sub, #aaa); text-align: center; padding: 10px 0;">当前云端暂存队列为空。</div>${guide}`;
            return;
        }

        // 本地模式：检测后端与 Git 状态
        envText.textContent = '本地模式';
        const backend = await this.checkLocalBackendAvailable();
        if (!backend.success) {
            changesPanel.textContent = backend.msg;
            submitBtn.disabled = true;
            submitBtn.textContent = '本地后台未就绪';
            return;
        }
        const localStatusData = await getLocalGitStatus();
        if (!localStatusData.success) {
            changesPanel.textContent = `Git 状态查询失败: ${localStatusData.msg}`;
            submitBtn.disabled = true;
            return;
        }
        envText.innerHTML = '<strong>本地后端已连接</strong> (局域网/开发模式)';
        branchText.textContent = `分支: ${localStatusData.branch || 'main'}`;

        // 如果有未合并的云端草稿，一并显示
        const pendingRelayCount = syncManager?.pendingItemsCount || 0;
        let html = '';
        if (pendingRelayCount > 0) {
            html += `<div style="color: #ffa502; font-weight: bold; margin-bottom: 6px;">包含 ${pendingRelayCount} 条未合并的云端草稿 (提交前将自动合并入库，合并失败则中止提交)</div>`;
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
            html += '<div style="color: #2ed573; text-align: center; padding: 10px 0;">代码与索引已提交，仍可点击发布同步本机正文和图片。</div>';
        }
        changesPanel.innerHTML = html;

        // 提交按钮逻辑
        submitBtn.onclick = async () => {
            if (this.isCommitting) return;
            const message = msgInput.value.trim() || this.getDefaultCommitMessage();

            this.isCommitting = true;
            msgInput.disabled = true;
            submitBtn.disabled = true;
            submitBtn.textContent = '正在准备…';
            modal.querySelector('#git-modal-cancel').textContent = '关闭（任务继续）';
            logArea.classList.add('visible');
            logArea.textContent = '开始准备提交任务...\n';

            try {
                // 先合并云端草稿；未全部合并并确认时中止，避免提交不完整的内容
                if (syncManager && (syncManager.pendingItemsCount === null || syncManager.pendingItemsCount > 0)) {
                    logArea.textContent += '正在将云端草稿拉取合并入本地库...\n';
                    if (!(await syncManager.pullAndMerge())) {
                        logArea.textContent += '\n云端草稿未能全部合并，已中止提交；草稿仍保留在云端，请处理提示后重试。\n';
                        Toast.error('云端草稿未全部合并，已中止提交');
                        submitBtn.disabled = false;
                        submitBtn.textContent = '合并完成后重试提交';
                        return;
                    }
                }

                let lastStep = '';
                const res = await this.commitAndPushLocal(message, progress => {
                    if (progress.step === lastStep || !['prepare', 'pre_check', 'media', 'content', 'commit', 'push'].includes(progress.step)) return;
                    lastStep = progress.step;
                    logArea.textContent += `${progress.msg}\n`;
                    submitBtn.textContent = { prepare: '正在准备…', pre_check: '正在检查…', media: '正在发布图片…', content: '正在同步正文…',
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
            } catch (err) {
                logArea.textContent += `\n发生异常: ${err.message}\n`;
                Toast.error(`操作异常: ${err.message}`);
                submitBtn.disabled = false;
                submitBtn.textContent = '重试提交';
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
