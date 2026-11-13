/** 中继同步设置：配置输入、连接测试与面板交互。 */
import { Toast } from '../../shared/toast.module.js';
import { cloudflareRelay } from './cloudflare-relay.module.js';
import { openFormModal } from '../encrypt/lock-dialog.module.js';
import { describeDraft } from './git-commit.module.js';

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
        const pending = manager.pendingItemsCount ?? '读取失败';

        const modal = document.createElement('div');
        modal.id = 'maers-sync-modal';
        modal.className = 'mlock-overlay';
        modal.innerHTML = `
            <div class="mlock-box" style="width: min(540px, 94vw);">
                <div class="mlock-header">
                    <div class="mlock-title-group">
                        <span class="mlock-title">跨端中继同步设置</span>
                        <span class="mlock-sub">云端暂存 · 电脑合并后发布</span>
                    </div>
                </div>
                <div class="mlock-body" style="gap: 14px; padding-bottom: 14px;">

                    <!-- 多设备编辑提醒 -->
                    <div class="sync-info-banner">
                        <strong>请保持单一设备编辑，多设备同时编辑可能造成数据问题，在电脑本地合并且发布后再换设备编辑。</strong><br>
                        云端草稿保留 30 天。
                    </div>

                    <!-- Cloudflare 配置 -->
                    <div class="sync-section">
                        <div class="sync-field">
                            <label class="sync-field__label">Worker 中继网关地址</label>
                            <input type="url" id="sync-relay-url" class="mlock-input" value="" placeholder="https://sync.example.com">
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
                            <button type="button" id="btn-preview-drafts" class="mlock-btn-secondary">查看草稿</button>
                            <button type="button" id="btn-manual-pull" class="mlock-btn-primary${isLocal ? '' : ' maers-local-disabled'}" ${isLocal ? 'style="background: linear-gradient(135deg,#f97316,#ea580c);"' : 'disabled aria-disabled="true" title="仅限电脑本地后台合并草稿"'}>拉取合并 (${pending})</button>
                        </div>
                    </div>

                    <!-- Git 提交 -->
                    <div class="sync-section sync-section--git">
                        <div class="sync-section__header">
                            <div>
                                <div class="sync-section__title" data-role="git-count-title">${isLocal ? `Git 一键提交(${manager.pendingGitCount})` : `待电脑合并草稿(${pending})`}</div>
                                <div class="sync-section__desc">${isLocal ? '将所有改动（含草稿）提交并推送到 GitHub 仓库' : '查看待电脑拉取合并的草稿'}</div>
                            </div>
                            <button type="button" id="btn-open-git-commit" class="mlock-btn-primary" style="white-space:nowrap;">${isLocal ? '提交' : '查看草稿'}</button>
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

        const preview = modal.querySelector('#btn-preview-drafts');
        preview.onclick = async () => {
            preview.disabled = true;
            try {
                const endpoint = modal.querySelector('#sync-relay-url').value.trim();
                const secret = modal.querySelector('#sync-relay-secret').value.trim();
                const invalid = validateRelayEndpoint(endpoint);
                if (invalid) throw Error(invalid);
                if (!secret) throw Error('请先输入访问密码');
                const result = await cloudflareRelay.pull(endpoint, secret);
                if (!result.success) throw Error(result.msg || '读取云端草稿失败');
                if (!modal.isConnected) return;
                const dialog = openFormModal({
                    title: `云端草稿（${result.items.length} 条）`,
                    sub: '图片上传、编辑和排序都会产生草稿，列表按暂存时间排列。',
                    bodyHtml: '<div data-draft-list></div>', confirmText: '关闭', cancelText: '', onSubmit: () => true
                });
                const list = dialog.el.querySelector('[data-draft-list]');
                for (const item of [...result.items].sort((a, b) => (a.data?.timestamp || 0) - (b.data?.timestamp || 0))) {
                    const row = document.createElement('p');
                    const timestamp = Number(item.data?.timestamp);
                    const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString('zh-CN') : '时间未知';
                    row.textContent = `${date} · ${describeDraft(item)}`;
                    list.appendChild(row);
                }
                if (!result.items.length) list.textContent = '当前没有待合并的云端草稿。';
            } catch (error) {
                Toast.error(error.message);
            } finally { preview.disabled = false; }
        };

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
        if (isLocal && pullBtn) {
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

