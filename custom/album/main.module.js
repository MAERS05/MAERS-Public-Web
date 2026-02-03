/**
 * MAERS Album Main Entry
 * @version 2.0.0 - ES6 Module
 */

// 0. Shared Utilities (Required for Layout/Theme safety)
import { Utils, Search as UrlSearch } from '../../shared/utils.module.js';

// 1. UI Infrastructure
import { initLayout, renderPageHeader } from '../shared/ui/layout.module.js';
import { initTheme } from '../shared/ui/theme.module.js';

// 2. Album Specific
// 2. Album Specific
import './viewer/album-config.module.js';
const CATEGORY_CONFIG = window.CATEGORY_CONFIG || [];

// --- Initialization ---

// Utils is now imported directly by modules that need it

// B. Initialize Core UI
initLayout();
initTheme();

// C. Render Logic
document.addEventListener('DOMContentLoaded', () => {
    // 1. Render Header
    renderPageHeader("📷 My Gallery");

    // 2. Render Grid
    const grid = document.getElementById('category-grid');
    if (!grid) return;

    // Clear existing (if any)
    grid.innerHTML = '';

    CATEGORY_CONFIG.forEach((cat, index) => {
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
