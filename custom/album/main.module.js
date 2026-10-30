/**
 * MAERS Album Main Entry
 * @version 2.0.0 - ES6 Module
 */

// 0. Shared Utilities (Required for Layout/Theme safety)
import { Utils, Search as UrlSearch } from '../../shared/utils.module.js';
import { isEncryptedRecord } from '../../data-manage/encrypt/crypto.module.js';
import { revealInPlace } from '../../data-manage/encrypt/secret-unlock.module.js';

// 1. UI Infrastructure
import { initLayout, renderPageHeader } from '../../shared/layout.module.js';
import { initTheme } from '../../shared/theme.module.js';

// 2. Album Specific
let CATEGORY_CONFIG = [];

// --- Initialization ---

// Utils is now imported directly by modules that need it

// B. Initialize Core UI
initLayout();
initTheme();

// C. Render Logic
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Load Album Config
    try {
        const response = await fetch('data/album-config.json', { cache: 'no-cache' });
        if (response.ok) {
            CATEGORY_CONFIG = await response.json();
        } else {
            console.error('Failed to load album config');
        }
    } catch (err) {
        console.error('Error loading album config:', err);
    }

    // 已有会话密钥时，在内存中还原密文分类
    await revealInPlace(CATEGORY_CONFIG, { transform: (plain) => plain.category || plain });

    // 2. Render Header
    renderPageHeader('<img src="ui/album-icon.svg" alt="Album" style="height: 1.25em; width: auto; vertical-align: middle;"> My Gallery');

    // 3. Render Grid
    const grid = document.getElementById('category-grid');
    if (!grid) return;

    // Clear existing (if any)
    grid.innerHTML = '';

    // 过滤加密记录（_enc 字段存在的分类完全不渲染）
    const visibleCats = CATEGORY_CONFIG.filter(c => !isEncryptedRecord(c));
    visibleCats.forEach((cat, index) => {
        const a = document.createElement('a');

        // Construct Link
        // Propagate 'mode' if present in current URL to maintain theme consistency (optional but good practice)
        const currentMode = new URLSearchParams(window.location.search).get('mode');
        const url = `photos.html?id=${cat.id}${currentMode ? `&mode=${currentMode}` : ''}`;

        a.href = url;
        a.className = `category-card ${cat.style_class || ''}`;
        a.style.animationDelay = `${index * -0.1}s`; // Adjusted timing slightly or keep -1s? 
        // Original was index * -1s (which seems fast? or pre-calculated offset for loop?)
        // CSS animation usually uses positive delay. Negative delay starts animation "in the past".
        // Let's keep original behavior:
        a.style.animationDelay = `${index * -1}s`;

        a.innerHTML = `
            <div class="card-bg-glow"></div>
            <div class="card-icon">${cat.icon}</div>
            <div class="text-group">
                <div class="card-title">${cat.title}</div>
                <div class="card-subtitle">${cat.subtitle}</div>
            </div>
        `;

        grid.appendChild(a);
    });
});
