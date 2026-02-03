import { initLayout } from '../../shared/ui/layout.module.js';
import { initTheme, toggleGlobalShrink } from '../../shared/ui/theme.module.js';

// 初始化核�?UI (Layout, Theme, Spatial Nav)
initLayout();
initTheme();

document.addEventListener("DOMContentLoaded", () => {
    // Navigation Cards
    const navMap = {
        "nav-notes": "notes.html",
        "nav-record": "record.html",
        "nav-literature": "literature.html",
        "nav-album": "album.html",
        "nav-music": "music.html",
        "nav-games": "games.html",
    };

    Object.keys(navMap).forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.style.cursor = "pointer";
            el.addEventListener("click", () => {
                window.location.href = navMap[id];
            });
        }
    });

    // Brand Interactions
    // Brand Interactions
    // Note: brand-logo Zoom trigger is handled by theme.module.js (Zoom System)
    // Duplicate binding here would cause the toggle to cancel itself (On -> Off instantly)


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
