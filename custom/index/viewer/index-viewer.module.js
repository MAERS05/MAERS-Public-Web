import { initLayout } from '../../../shared/layout.module.js';
import { initTheme, toggleGlobalShrink } from '../../../shared/theme.module.js';

// Initialize core UI immediately (safe for layout/theme)
initLayout();
initTheme();

document.addEventListener("DOMContentLoaded", () => {
    // Dynamic Card Rendering
    const navGrid = document.querySelector(".nav-grid");

    if (navGrid) {
        fetch('custom/index/index-cards.json')
            .then(response => response.json())
            .then(data => {
                navGrid.innerHTML = '';
                let delay = 0.1;

                data.forEach(item => {
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
