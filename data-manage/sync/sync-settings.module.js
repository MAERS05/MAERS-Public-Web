/** 中继同步设置：配置输入、连接测试与面板交互。 */
import { Toast } from '../../shared/toast.module.js';
import { cloudflareRelay } from './cloudflare-relay.module.js';

export function validateRelayEndpoint(value) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '请填写不含账号、查询参数或片段的 HTTP(S) 网关地址';
    } catch { return '请填写有效的网关地址'; }
    return null;
}

export function openSyncSettings(manager) {
        const existing = document.getElementById('maers-sync-modal');
        if (existing) existing.remove();

        const cfg = manager.getConfig();
        const isLocal = manager.isLocalHost();

        const modal = document.createElement('div');
        modal.id = 'maers-sync-modal';
        modal.className = 'mlock-overlay';
        modal.innerHTML = `
            <div class="mlock-box" style="width: min(540px, 94vw);">
                <div class="mlock-header">
                    <div class="mlock-title-group">
                        <span class="mlock-title">跨端中继同步设置</span>
                        <span class="mlock-sub">Cloudflare Relay · 方案 3</span>
                    </div>
                </div>
                <div class="mlock-body" style="gap: 14px; padding-bottom: 14px;">

                    <!-- 模式说明 -->
                    <div class="sync-info-banner">
                        <strong>手机端</strong>：保存即存入 Cloudflare KV，0.1 秒完成，无需等待部署。<br>
                        <strong>电脑端</strong>：打开管理后台，点击按钮一键拉取合并入库。
                    </div>

                    <!-- Cloudflare 配置 -->
                    <div class="sync-section">
                        <div class="sync-field">
                            <label class="sync-field__label">Worker 中继网关地址</label>
                            <input type="url" id="sync-relay-url" class="mlock-input" value="" placeholder="https://your-worker.example.com">
                        </div>
                        <div class="sync-field">
                            <label class="sync-field__label">访问密码 (SECRET_KEY)</label>
                            <div class="sync-field__row">
                                <input type="password" id="sync-relay-secret" class="mlock-input" value="" placeholder="在 Worker 设置中填写的密码" style="flex:1;">
                                <button type="button" id="btn-toggle-relay-secret" class="mlock-btn-secondary" style="padding: 0 14px; flex-shrink:0;">显示</button>
                            </div>
                        </div>
                        <div class="sync-section__actions">
                            <button type="button" id="btn-test-relay" class="mlock-btn-secondary">测试连接</button>
                            ${isLocal ? `<button type="button" id="btn-manual-pull" class="mlock-btn-primary" style="background: linear-gradient(135deg,#f97316,#ea580c);">拉取合并 (${manager.pendingItemsCount})</button>` : '<span></span>'}
                        </div>
                    </div>

                    <!-- Git 提交 -->
                    <div class="sync-section sync-section--git">
                        <div class="sync-section__header">
                            <div>
                                <div class="sync-section__title" data-role="git-count-title">Git 一键提交(${isLocal ? manager.pendingGitCount : manager.pendingItemsCount})</div>
                                <div class="sync-section__desc">将所有改动（含草稿）提交并推送到 GitHub 仓库</div>
                            </div>
                            <button type="button" id="btn-open-git-commit" class="mlock-btn-primary" style="white-space:nowrap;">提交</button>
                        </div>
                    </div>

                </div>
                <div class="mlock-footer">
                    <button type="button" id="sync-modal-cancel" class="mlock-btn-secondary">关闭</button>
                    <button type="button" id="sync-modal-save" class="mlock-btn-primary">保存配置</button>
                </div>
            </div>
        `;

        modal.querySelector('#sync-relay-url').value = cfg.relay.endpoint || '';
        modal.querySelector('#sync-relay-secret').value = cfg.relay.secret || '';
        document.body.appendChild(modal);

        const closeModal = () => { secretInput.value = ''; modal.remove(); };
        // 点击遮罩层关闭
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
        modal.querySelector('#sync-modal-cancel').onclick = closeModal;

        // 打开 Git 提交弹窗
        const gitCommitBtn = modal.querySelector('#btn-open-git-commit');
        if (gitCommitBtn) {
            gitCommitBtn.onclick = () => {
                closeModal();
                manager.openGitCommitModal();
            };
        }

        // 密码显隐切换
        const secretInput = modal.querySelector('#sync-relay-secret');
        const toggleSecretBtn = modal.querySelector('#btn-toggle-relay-secret');
        toggleSecretBtn.onclick = () => {
            const isPwd = secretInput.type === 'password';
            secretInput.type = isPwd ? 'text' : 'password';
            toggleSecretBtn.textContent = isPwd ? '隐藏' : '显示';
        };

        // 测试网关连接
        const testBtn = modal.querySelector('#btn-test-relay');
        testBtn.onclick = async () => {
            const url = modal.querySelector('#sync-relay-url').value.trim();
            const secret = secretInput.value.trim();
            if (!secret) {
                Toast.warning('请先输入访问密码');
                return;
            }
            testBtn.textContent = '测试中...';
            testBtn.disabled = true;

            try {
            const res = await cloudflareRelay.ping(url, secret);
            if (res.success) {
                Toast.success(res.msg);
            } else {
                Toast.error(res.msg);
            }
            } catch (error) { Toast.error(error.message); } finally {
                testBtn.textContent = '测试连接';
                testBtn.disabled = false;
            }
        };

        // 电脑端手动拉取
        const pullBtn = modal.querySelector('#btn-manual-pull');
        if (pullBtn) {
            pullBtn.onclick = async () => {
                closeModal();
                await manager.pullAndMerge();
            };
        }

        // 保存配置
        modal.querySelector('#sync-modal-save').onclick = () => {
            const updated = {
                relay: {
                    endpoint: modal.querySelector('#sync-relay-url').value.trim(),
                    secret: secretInput.value.trim()
                }
            };
            const error = validateRelayEndpoint(updated.relay.endpoint);
            if (error) { Toast.error(error); return; }
            if (!manager.saveConfig(updated)) { Toast.error('配置保存失败，请检查浏览器存储权限'); return; }
            Toast.success('配置已保存');
            closeModal();
        };
    }

