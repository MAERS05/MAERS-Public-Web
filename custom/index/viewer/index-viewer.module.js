/**
 * MAERS Index Viewer - 首页访客端入口
 * 初始化布局 / 主题 / 更新日志，动态渲染导航卡片并处理加密卡片的原位解锁。
 */
import { initLayout } from '../../../shared/layout.module.js';
import { initTheme } from '../../../shared/theme.module.js';
import { getNavData } from '../../../shared/spatial-nav.module.js';
import { initWhatsNew } from '../../../shared/whats-new.module.js';
import { isEncryptedRecord } from '../../../data-manage/encrypt/crypto.module.js';
import { revealInPlace } from '../../../data-manage/encrypt/secret-unlock.module.js';

// Initialize core UI immediately (safe for layout/theme)
initLayout();
initTheme();
initWhatsNew();

document.addEventListener("DOMContentLoaded", () => {
    // Dynamic Card Rendering
    const navGrid = document.querySelector(".nav-grid");

    if (navGrid) {
        getNavData()
            .then(async data => {
                await revealInPlace(data); // 已有会话密钥时，在内存中还原密文卡片
                navGrid.innerHTML = '';
                let delay = 0.1;

                // 过滤加密记录：_enc 字段存在的卡片完全不渲染
                const visibleData = data.filter(item => !isEncryptedRecord(item));

                visibleData.forEach(item => {
                    const card = document.createElement("div");
                    card.className = "nav-card";
                    card.id = item.id;
                    card.style.animationDelay = `${delay}s`;
                    delay += 0.05;

                    card.innerHTML = `
                        <div class="card-bg-text">${item.bgText}</div>
                        <div class="card-icon"><img src="${item.icon}" class="nav-icon-img" alt="${item.title}" /></div>
                        <div class="card-title">${item.title}</div>
                        <div class="card-desc">${item.description}</div>
                    `;

                    card.style.cursor = "pointer";
                    card.addEventListener("click", () => {
                        window.location.href = item.url;
                    });

                    navGrid.appendChild(card);
                });
            })
            .catch(err => {
                console.error("Failed to load navigation cards:", err);
                if (navGrid.children.length === 0) {
                    navGrid.innerHTML = `<p style="color:var(--text-sub); text-align:center; width:100%;">无法加载导航数据</p>`;
                }
            });
    }

    // Brand Interactions
    const brandMaers = document.getElementById("brand-maers");
    if (brandMaers) {
        brandMaers.addEventListener(
            "click",
            () => (window.location.href = "me.html"),
        );
    }

    const brandSpace = document.getElementById("brand-space");
    if (brandSpace) {
        brandSpace.addEventListener(
            "click",
            () => (window.location.href = "space.html"),
        );
    }
});
