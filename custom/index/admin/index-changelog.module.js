/** 首页更新日志管理：读取、编辑分组和条目、保存及弹窗生命周期。 */
import { localFetch } from '../../../data-manage/api-client.module.js';
import { Toast } from '../../../shared/toast.module.js';
export function initChangelogEditor() {
    document.addEventListener('DOMContentLoaded', () => {
        // 等待 layout 注入后在顶栏找位置放按钮
        _injectChangelogBtn();
    });
}

function _injectChangelogBtn() {
    // 注入顶栏胶囊按钮（与 auto-mode-btn 和 site-guide 保持一致的规范与位置）
    if (document.getElementById('changelog-edit-btn')) return;

    _injectAdminStyles();

    const btn = document.createElement('button');
    btn.id = 'changelog-edit-btn';
    btn.className = 'cl-admin-trigger';
    btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <span>更新日志</span>
    `;
    btn.onclick = () => _openChangelogModal();

    document.body.appendChild(btn);
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
    // 优先从后端接口拉取，失败时降级读取静态文件
    let logs = [];
    try {
        const res = await localFetch('/api/changelog', { cache: 'no-cache' });
        if (res.ok) {
            logs = await res.json();
        } else {
            const fallbackRes = await localFetch('data/changelog.json', { cache: 'no-cache' });
            if (fallbackRes.ok) logs = await fallbackRes.json();
        }
    } catch (e) {
        try {
            const fallbackRes = await localFetch('data/changelog.json', { cache: 'no-cache' });
            if (fallbackRes.ok) logs = await fallbackRes.json();
        } catch (err) {
            Toast.error('读取更新日志数据失败');
            return;
        }
    }

    // 防止重复弹窗
    const existing = document.getElementById('changelog-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'changelog-modal-overlay';
    overlay.className = 'cl-modal-overlay';

    overlay.innerHTML = `
        <div id="changelog-modal-box" class="cl-modal-box">
            <!-- 弹窗头部 -->
            <div class="cl-modal-header">
                <div class="cl-header-title">
                    <span>更新日志管理</span>
                    <span class="cl-header-sub">发布网站变动，前台将主动提示访客</span>
                </div>
                <button id="cl-close-btn" class="cl-close-btn" title="关闭">✕</button>
            </div>

            <!-- 新增记录面板 -->
            <div class="cl-add-panel">
                <div class="cl-panel-row">
                    <span class="cl-panel-label">＋ 记录新发布</span>
                    <input type="date" id="cl-new-date" class="cl-date-input"
                        value="${new Date().toISOString().slice(0, 10)}">
                </div>
                <textarea id="cl-new-entries" class="cl-textarea" placeholder="每行一条更新内容，例如：&#10;• 新增摄影作品 8 张&#10;• 优化手机端交互排版"></textarea>
                <button id="cl-add-btn" class="cl-add-btn">＋ 加入列表</button>
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
                    <button id="cl-cancel-btn" class="cl-btn-secondary">取消</button>
                    <button id="cl-save-btn" class="cl-btn-primary">保存发布</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // 深拷贝数据，用于本地修改缓冲
    let workingLogs = JSON.parse(JSON.stringify(logs));

    // 关闭弹窗
    const closeModal = () => overlay.remove();
    overlay.querySelector('#cl-close-btn').onclick = closeModal;
    overlay.querySelector('#cl-cancel-btn').onclick = closeModal;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });

    // 刷新列表与统计
    const refreshUI = () => {
        overlay.querySelector('#cl-list').innerHTML = _renderChangelogList(workingLogs);
        overlay.querySelector('#cl-footer-info').textContent = `共 ${_countEntries(workingLogs)} 条更新记录`;
        _bindDeleteBtns(overlay, workingLogs, refreshUI);
    };

    // 添加记录
    overlay.querySelector('#cl-add-btn').onclick = () => {
        const dateInput = overlay.querySelector('#cl-new-date');
        const textInput = overlay.querySelector('#cl-new-entries');
        const date = dateInput.value.trim();
        const rawText = textInput.value.trim();

        if (!date || !rawText) {
            Toast.warning('请选择日期并填写更新条目');
            return;
        }

        const entries = rawText
            .split('\n')
            .map(s => s.trim().replace(/^[•\-\*]\s*/, '')) // 清理前缀符号
            .filter(Boolean);

        if (!entries.length) return;

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
    };

    // 绑定初始删除事件
    _bindDeleteBtns(overlay, workingLogs, refreshUI);

    // 保存发布
    overlay.querySelector('#cl-save-btn').onclick = async () => {
        const saveBtn = overlay.querySelector('#cl-save-btn');
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';

        try {
            const res = await localFetch('/api/save_changelog', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(workingLogs)
            });

            if (res.ok) {
                Toast.success('更新日志已成功保存！');
                closeModal();
            } else {
                Toast.error('保存失败，请确认后端 Studio 服务正在运行');
            }
        } catch (e) {
            Toast.error('网络请求失败: ' + e.message);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存发布';
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
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4;">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                </svg>
                <span>暂无更新日志记录，在上方录入后点击保存即可</span>
            </div>
        `;
    }

    return logs.map((group, gi) => `
        <div class="cl-group-card">
            <div class="cl-group-header">
                <span class="cl-group-date-badge">${group.date}</span>
                <button class="cl-group-del-btn" data-gi="${gi}" title="删除此日全部记录">删除整日</button>
            </div>
            <ul class="cl-entry-list">
                ${group.entries.map((entry, ei) => `
                    <li class="cl-entry-item">
                        <div class="cl-entry-content-box">
                            <span class="cl-entry-bullet"></span>
                            <span>${_escHtml(entry)}</span>
                        </div>
                        <button class="cl-entry-del-btn" data-gi="${gi}" data-ei="${ei}" title="删除此条">✕</button>
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

