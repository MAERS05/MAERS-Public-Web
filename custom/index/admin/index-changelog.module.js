/** 首页更新日志管理：读取、编辑分组和条目、保存及弹窗生命周期。 */
import { icon } from '../../../shared/icons.module.js';
import { confirmAction } from '../../../data-manage/admin/admin-confirm.module.js';
import { localFetch } from '../../../data-manage/api-client.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { isLocalOnlyUnavailable } from '../../../data-manage/admin/local-only.module.js';
import { syncManager } from '../../../data-manage/sync/sync-manager.module.js';
export function initChangelogEditor() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _injectChangelogBtn, { once: true });
    else _injectChangelogBtn();
}

function _injectChangelogBtn() {
    // 注入顶栏胶囊按钮（与 auto-mode-btn 和 site-guide 保持一致的规范与位置）
    if (document.getElementById('changelog-edit-btn')) return;

    _injectAdminStyles();

    const btn = document.createElement('button');
    btn.id = 'changelog-edit-btn';
    btn.className = 'cl-admin-trigger';
    btn.type = 'button';
    btn.title = '编辑更新日志';
    btn.innerHTML = icon('clock', 18) + '<span>更新日志</span>';
    btn.onclick = () => _openChangelogModal();

    (document.querySelector('.page-header-bar') || document.querySelector('.app-sidebar-actions') || document.body).appendChild(btn);
}

/**
 * 注入后台更新日志专用的毛玻璃与响应式样式
 */
function _injectAdminStyles() {
    if (document.getElementById('cl-admin-styles')) return;

    const style = document.createElement('link');
    style.id = 'cl-admin-styles';
    style.rel = 'stylesheet';
    style.href = new URL('./index-changelog.css', import.meta.url).href;

    document.head.appendChild(style);
}

/**
 * 打开更新日志编辑模态框
 */
async function _openChangelogModal() {
    const relayMode = isLocalOnlyUnavailable();
    let logs;
    try {
        const local = relayMode ? null : await localFetch('/api/changelog', { cache: 'no-cache' }).catch(() => null);
        const res = local?.ok ? local : await localFetch('data/changelog.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        logs = await res.json();
        if (relayMode) logs = await syncManager.loadDocument('changelog', logs, null, 'relay');
        if (!Array.isArray(logs) || !logs.every(group => typeof group?.date === 'string' && Array.isArray(group.entries))) {
            throw new Error('更新日志格式无效');
        }
    } catch (e) {
        Toast.error('读取更新日志数据失败');
        return;
    }

    // 防止重复弹窗
    const existing = document.getElementById('changelog-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'changelog-modal-overlay';
    overlay.className = 'cl-modal-overlay';

    overlay.innerHTML = `
        <div id="changelog-modal-box" class="cl-modal-box" role="dialog" aria-modal="true" aria-label="编辑更新日志" tabindex="-1">
            <!-- 弹窗头部 -->
            <div class="cl-modal-header">
                <div class="cl-header-title">
                    <span>编辑更新日志</span>
                    <span class="cl-header-sub">${relayMode ? '修改先暂存，待电脑合并后发布' : '按日期整理网站更新'}</span>
                </div>
                <button type="button" id="cl-close-btn" class="cl-close-btn" title="关闭编辑" aria-label="关闭编辑">${icon("close", 18)}</button>
            </div>

            <!-- 新增记录面板 -->
            <div class="cl-add-panel">
                <div class="cl-panel-row">
                    <span class="cl-panel-label">记录新发布</span>
                    <input type="date" id="cl-new-date" class="cl-date-input" aria-label="更新日期"
                        value="${_today()}">
                </div>
                <textarea id="cl-new-entries" class="cl-textarea" aria-label="更新内容" placeholder="每行写一条更新内容"></textarea>
                <button id="cl-add-btn" class="cl-add-btn">加入列表</button>
            </div>

            <!-- 历史记录流 -->
            <div id="cl-list" class="cl-list-container">
                ${_renderChangelogList(logs)}
            </div>

            <!-- 底部操作栏 -->
            <div class="cl-modal-footer">
                <div id="cl-footer-info" class="cl-footer-info">
                    共 ${_countEntries(logs)} 条更新记录
                </div>
                <div class="cl-footer-actions">
                    <button id="cl-cancel-btn" class="cl-btn-secondary">不改了</button>
                    <button id="cl-save-btn" class="cl-btn-primary">${relayMode ? '暂存修改' : '保存修改'}</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // 深拷贝数据，用于本地修改缓冲
    const workingLogs = structuredClone(logs);

    // 编辑缓冲在保存之前只存在内存中；误关时保留继续编辑的选择。
    const previousFocus = document.activeElement;
    let saving = false;
    const pendingText = overlay.querySelector('#cl-new-entries');
    const hasPendingText = () => Boolean(pendingText.value.trim());
    const isDirty = () => hasPendingText() || JSON.stringify(workingLogs) !== JSON.stringify(logs);
    const closeModal = async ({ discard = false } = {}) => {
        if (saving) return;
        if (!discard && isDirty() &&
            !await confirmAction({ confirmText: '放弃修改', cancelText: '继续编辑' })) return;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
    };
    const onKey = event => {
        if (document.querySelector('.mlock-overlay')) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModal(); return; }
        if (event.key !== 'Tab') return;
        const controls = [...overlay.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')].filter(control => control.getClientRects().length);
        if (!controls.length) {
            event.preventDefault();
            overlay.querySelector('.cl-modal-box').focus();
            return;
        }
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('#cl-close-btn').onclick = () => closeModal();
    overlay.querySelector('#cl-cancel-btn').onclick = () => closeModal({ discard: true });
    overlay.addEventListener('click', event => { if (event.target === overlay) closeModal(); });
    overlay.querySelector('#cl-new-entries').focus();

    // 刷新列表与统计
    const refreshUI = () => {
        overlay.querySelector('#cl-list').innerHTML = _renderChangelogList(workingLogs);
        overlay.querySelector('#cl-footer-info').textContent = `共 ${_countEntries(workingLogs)} 条更新记录`;
        _bindDeleteBtns(overlay, workingLogs, refreshUI);
    };

    // 添加记录
    const stagePendingEntries = () => {
        if (saving) return false;
        const dateInput = overlay.querySelector('#cl-new-date');
        const textInput = overlay.querySelector('#cl-new-entries');
        const date = dateInput.value.trim();
        const rawText = textInput.value.trim();

        if (!date || !rawText) {
            Toast.warning('请选择日期并填写更新条目');
            (!date ? dateInput : textInput).focus();
            return false;
        }

        const entries = rawText
            .split('\n')
            .map(s => s.trim().replace(/^[•\-\*]\s*/, '')) // 清理前缀符号
            .filter(Boolean);

        if (!entries.length) {
            Toast.warning('请填写更新内容');
            textInput.focus();
            return false;
        }

        // 若同日期已存在则合并至最新
        const existingGroup = workingLogs.find(g => g.date === date);
        if (existingGroup) {
            existingGroup.entries = [...entries, ...existingGroup.entries];
        } else {
            workingLogs.unshift({ date, entries });
            workingLogs.sort((a, b) => b.date.localeCompare(a.date));
        }

        textInput.value = '';
        refreshUI();
        return true;
    };
    overlay.querySelector('#cl-add-btn').onclick = stagePendingEntries;

    // 绑定初始删除事件
    _bindDeleteBtns(overlay, workingLogs, refreshUI);

    // 保存发布
    overlay.querySelector('#cl-save-btn').onclick = async () => {
        if (saving) return;
        if (hasPendingText() && !stagePendingEntries()) return;
        saving = true;
        const saveBtn = overlay.querySelector('#cl-save-btn');
        const controls = [...overlay.querySelectorAll('button, input, textarea')].map(control => [control, control.disabled]);
        controls.forEach(([control]) => { control.disabled = true; });
        const dialog = overlay.querySelector('.cl-modal-box');
        dialog.setAttribute('aria-busy', 'true');
        dialog.focus();
        saveBtn.textContent = '正在保存…';

        try {
            const result = await syncManager.writeDocument('changelog', workingLogs, {
                base: logs, mode: relayMode ? 'relay' : 'local'
            });
            if (result.success) {
                if (!relayMode) Toast.success('更新日志已成功保存！');
                saving = false;
                closeModal({ discard: true });
            }
        } catch (e) {
            Toast.error('网络请求失败: ' + e.message);
        } finally {
            saving = false;
            controls.forEach(([control, disabled]) => { control.disabled = disabled; });
            dialog.removeAttribute('aria-busy');
            saveBtn.textContent = relayMode ? '暂存修改' : '保存修改';
            if (overlay.isConnected) pendingText.focus();
        }
    };
}

/**
 * 渲染日志列表 HTML（按时间轴卡片组织）
 */
function _renderChangelogList(logs) {
    if (!logs || !logs.length) {
        return `
            <div class="cl-empty-state">
                ${icon("clock", 26)}
                <span>还没有记录，写下第一条更新吧</span>
            </div>
        `;
    }

    return logs.map((group, gi) => `
        <div class="cl-group-card">
            <div class="cl-group-header">
                <span class="cl-group-date-badge">${_escHtml(group.date)}</span>
                <button class="cl-group-del-btn" data-gi="${gi}" title="移除当天全部记录">移除当天</button>
            </div>
            <ul class="cl-entry-list">
                ${group.entries.map((entry, ei) => `
                    <li class="cl-entry-item">
                        <div class="cl-entry-content-box">
                            <span class="cl-entry-bullet"></span>
                            <span>${_escHtml(entry)}</span>
                        </div>
                        <button class="cl-entry-del-btn" data-gi="${gi}" data-ei="${ei}" title="移除这条记录" aria-label="移除这条记录">${icon("trash", 16)}</button>
                    </li>
                `).join('')}
            </ul>
        </div>
    `).join('');
}

/**
 * 绑定删除按钮事件
 */
function _bindDeleteBtns(overlay, workingLogs, onUpdate) {
    const list = overlay.querySelector('#cl-list');

    // 删除整组
    list.querySelectorAll('.cl-group-del-btn').forEach(btn => {
        btn.onclick = () => {
            const gi = parseInt(btn.dataset.gi, 10);
            workingLogs.splice(gi, 1);
            onUpdate();
        };
    });

    // 删除单条
    list.querySelectorAll('.cl-entry-del-btn').forEach(btn => {
        btn.onclick = () => {
            const gi = parseInt(btn.dataset.gi, 10);
            const ei = parseInt(btn.dataset.ei, 10);
            workingLogs[gi].entries.splice(ei, 1);
            if (!workingLogs[gi].entries.length) {
                workingLogs.splice(gi, 1);
            }
            onUpdate();
        };
    });
}

/**
 * 统计总更新条数
 */
function _countEntries(logs) {
    if (!logs) return 0;
    return logs.reduce((total, group) => total + (group.entries ? group.entries.length : 0), 0);
}

function _escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}


function _today() {
    const date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
