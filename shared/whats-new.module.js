/**
 * MAERS What's New (whats-new.module.js)
 * 职责：读取 changelog.json，在首页注入"更新日志"按钮与悬浮红点
 *
 * 规则：
 * - localStorage 存储用户最后阅读的日期（maers_changelog_seen）
 * - changelog.json 中最新条目日期 > 上次阅读日期 → 显示红点
 * - 用户首次访问（无记录）→ 直接显示红点
 * - 点击按钮 → 打开日志面板，红点消失，更新 localStorage
 */

const STORAGE_KEY = 'maers_changelog_seen';

/**
 * 主入口：注入按钮并启动逻辑
 */
export function initWhatsNew() {
    const init = async () => {
        const data = await _loadChangelog();

        // 按日期降序排列（最新在前）
        const sorted = Array.isArray(data) ? [...data].sort((a, b) => b.date.localeCompare(a.date)) : [];
        const latestDate = sorted[0]?.date || '';
        let lastSeen = '';
        try { lastSeen = localStorage.getItem(STORAGE_KEY) || ''; } catch { /* 存储不可用时仍显示入口。 */ }
        const hasNew = Boolean(latestDate && latestDate > lastSeen);

        _injectButton(hasNew, sorted, latestDate);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
}

/**
 * 加载 changelog.json
 */
async function _loadChangelog() {
    try {
        const res = await fetch('data/changelog.json', { cache: 'no-cache' });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.warn('[WhatsNew] 加载 changelog.json 失败:', e);
        return null;
    }
}

/**
 * 注入日志按钮（自适应对齐顶栏胶囊规范）
 * @param {boolean} hasNew - 是否有未读更新
 * @param {Array} logs - 排序后的日志列表
 * @param {string} latestDate - 最新日期字符串
 */
function _injectButton(hasNew, logs, latestDate) {
    // 防止重复注入
    if (document.getElementById('whats-new-btn')) return;

    _injectStyles();

    // 遮罩
    const overlay = document.createElement('div');
    overlay.id = 'whats-new-overlay';

    // 触发按钮
    const btn = document.createElement('button');
    btn.id = 'whats-new-btn';
    btn.className = 'wn-trigger-btn';
    btn.setAttribute('aria-label', '更新日志');
    btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <span class="wn-btn-text">更新日志</span>
        <span id="whats-new-dot" style="display:${hasNew ? 'block' : 'none'}"></span>
    `;

    // 弹窗卡片
    const panel = document.createElement('div');
    panel.id = 'whats-new-panel';
    panel.innerHTML = `
        <div id="whats-new-header">
            <div class="wn-title-box">
                <span class="wn-title">网站更新动态</span>
                <span class="wn-subtitle">记录近期功能变动与内容发布</span>
            </div>
            <button id="whats-new-close" aria-label="关闭">✕</button>
        </div>
        <div id="whats-new-body">
            ${_renderLogs(logs)}
        </div>
        <div id="whats-new-footer">
            <button id="whats-new-confirm-btn" class="wn-confirm-btn">我知道了</button>
        </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(btn);
    document.body.appendChild(overlay);

    // 标记已读处理
    const markAsRead = () => {
        const dot = document.getElementById('whats-new-dot');
        if (dot) dot.style.display = 'none';
        try {
            localStorage.setItem(STORAGE_KEY, latestDate);
        } catch (e) { /* 无痕模式下忽略 */ }
    };

    // 打开面板
    const openModal = () => {
        overlay.classList.add('open');
        markAsRead();
    };

    // 关闭面板
    const closeModal = () => {
        overlay.classList.remove('open');
    };

    btn.addEventListener('click', openModal);
    panel.querySelector('#whats-new-close').addEventListener('click', closeModal);
    panel.querySelector('#whats-new-confirm-btn').addEventListener('click', closeModal);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
}

/**
 * 渲染日志 HTML（时间轴卡片风格）
 */
function _renderLogs(logs) {
    if (!logs.length) return '<p class="wn-subtitle">暂无更新日志</p>';
    return logs.map(group => {
        const entriesHtml = group.entries
            .map(e => `
                <li class="wn-entry-item">
                    <span class="wn-bullet"></span>
                    <span class="wn-entry-text">${_escHtml(e)}</span>
                </li>
            `)
            .join('');
        return `
            <div class="wn-group">
                <div class="wn-date-badge">${_formatDate(group.date)}</div>
                <ul class="wn-entries">${entriesHtml}</ul>
            </div>
        `;
    }).join('');
}

/**
 * 日期格式化：2026-10-12 → 2026年10月12日
 */
function _formatDate(dateStr) {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return `${parts[0]}年${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日`;
    }
    return dateStr;
}

function _escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 注入前台按钮与弹窗的完整高质感 CSS
 */
function _injectStyles() {
    if (document.getElementById('whats-new-styles')) return;
    const style = document.createElement('style');
    style.id = 'whats-new-styles';
    style.textContent = `
        /* ── 前台顶栏胶囊触发按钮 ── */
        .wn-trigger-btn {
            position: fixed;
            top: 5px;
            left: 130px; /* 紧随左上角网站引导旁边 */
            z-index: 10000;
            height: 28px;
            padding: 0 12px;
            border-radius: 50px;
            background: var(--toggle-bg, rgba(30,30,35,0.75));
            border: 1px solid rgba(255,255,255,0.2);
            color: var(--text-sub, #aaa);
            font-size: 0.75rem;
            font-weight: 800;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
            user-select: none;
        }
        .wn-trigger-btn:hover {
            transform: scale(1.05);
            border-color: rgba(255,255,255,0.5);
            color: var(--text-main, #fff);
        }
        html.light-mode .wn-trigger-btn {
            border-color: rgba(0, 0, 0, 0.15) !important;
            background: rgba(255, 255, 255, 0.6) !important;
            color: #333 !important;
        }
        html.light-mode .wn-trigger-btn:hover {
            background: #fff !important;
            color: #000 !important;
        }

        /* 呼吸小红点 */
        #whats-new-dot {
            position: absolute;
            top: 2px;
            right: 2px;
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #ff4757;
            box-shadow: 0 0 8px rgba(255,71,87,0.8);
            animation: wn-pulse 1.8s ease-in-out infinite;
        }
        @keyframes wn-pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50%       { transform: scale(1.35); opacity: 0.75; }
        }

        /* 移动端/小屏幕自适应 */
        @media (max-width: 680px) {
            .wn-trigger-btn {
                left: auto;
                right: 130px; /* 移动端可自动回缩到右侧工具区 */
                padding: 0 8px;
            }
            .wn-btn-text {
                display: none;
            }
        }

        /* ── 模态遮罩 ── */
        #whats-new-overlay {
            position: fixed;
            inset: 0;
            z-index: 20000;
            background: rgba(0,0,0,0.65);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.25s ease;
        }
        #whats-new-overlay.open {
            opacity: 1;
            pointer-events: all;
        }

        /* ── 弹窗卡片 ── */
        #whats-new-panel {
            width: min(440px, 92vw);
            max-height: 75vh;
            background: rgba(24, 24, 28, 0.95);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border-radius: 18px;
            border: 1px solid rgba(255,255,255,0.12);
            box-shadow: 0 24px 60px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            transform: scale(0.95) translateY(10px);
            transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        #whats-new-overlay.open #whats-new-panel {
            transform: scale(1) translateY(0);
        }
        html.light-mode #whats-new-panel {
            background: rgba(255, 255, 255, 0.96);
            border-color: rgba(0,0,0,0.1);
            box-shadow: 0 20px 50px rgba(0,0,0,0.12);
        }

        /* ── 头部 ── */
        #whats-new-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 18px 20px 14px;
            border-bottom: 1px solid rgba(255,255,255,0.08);
            flex-shrink: 0;
        }
        html.light-mode #whats-new-header {
            border-bottom-color: rgba(0,0,0,0.08);
        }
        .wn-title-box {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .wn-title {
            font-size: 15px;
            font-weight: 700;
            color: var(--text-main, #eee);
        }
        html.light-mode .wn-title { color: #111; }
        .wn-subtitle {
            font-size: 11.5px;
            color: var(--text-sub, #888);
        }
        #whats-new-close {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            border: none;
            background: transparent;
            cursor: pointer;
            font-size: 16px;
            color: var(--text-sub, #888);
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s;
        }
        #whats-new-close:hover {
            background: rgba(255,255,255,0.1);
            color: var(--text-main, #fff);
        }
        html.light-mode #whats-new-close:hover {
            background: rgba(0,0,0,0.06);
            color: #000;
        }

        /* ── 正文内容 ── */
        #whats-new-body {
            overflow-y: auto;
            padding: 16px 20px;
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        #whats-new-body::-webkit-scrollbar { width: 4px; }
        #whats-new-body::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.15);
            border-radius: 2px;
        }

        .wn-group {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .wn-date-badge {
            align-self: flex-start;
            font-size: 11px;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 6px;
            background: rgba(100, 150, 255, 0.15);
            color: rgba(130, 180, 255, 1);
            letter-spacing: 0.02em;
        }
        html.light-mode .wn-date-badge {
            background: rgba(0, 102, 204, 0.1);
            color: #0066cc;
        }
        .wn-entries {
            margin: 0;
            padding: 0;
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .wn-entry-item {
            display: flex;
            align-items: baseline;
            gap: 8px;
            font-size: 13px;
            line-height: 1.6;
            color: var(--text-main, #ddd);
        }
        html.light-mode .wn-entry-item { color: #333; }
        .wn-bullet {
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: rgba(255,255,255,0.4);
            flex-shrink: 0;
            transform: translateY(-2px);
        }
        html.light-mode .wn-bullet {
            background: rgba(0,0,0,0.3);
        }

        /* ── 底部 ── */
        #whats-new-footer {
            padding: 12px 20px 16px;
            border-top: 1px solid rgba(255,255,255,0.08);
            display: flex;
            justify-content: flex-end;
            flex-shrink: 0;
        }
        html.light-mode #whats-new-footer {
            border-top-color: rgba(0,0,0,0.08);
        }
        .wn-confirm-btn {
            width: 100%;
            padding: 8px 0;
            border-radius: 10px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            border: 1px solid rgba(255,255,255,0.12);
            background: rgba(255,255,255,0.08);
            color: var(--text-main, #eee);
            transition: all 0.2s;
        }
        .wn-confirm-btn:hover {
            background: rgba(255,255,255,0.15);
            border-color: rgba(255,255,255,0.25);
        }
        html.light-mode .wn-confirm-btn {
            background: #f0f0f4;
            border-color: rgba(0,0,0,0.12);
            color: #222;
        }
        html.light-mode .wn-confirm-btn:hover {
            background: #e4e4ea;
        }
    `;
    document.head.appendChild(style);
}
