/**
 * MAERS Spatial Navigation (spatial-nav.module.js)
 * Adds 3D floating navigation cards to the sides of the screen.
 * Dynamically fetches content from index.html to ensure synchronization.
 * Includes fallback data if fetch fails (e.g. local file system restrictions).
 * @version 2.0.0 - ES6 Module
 */

const NAV_CONFIG = {
    // Keep legacy ID mapping if needed for specific logic,
    // otherwise we rely on dynamic data order.
    // If IDs are found in JSON, we can respect them.
};

// Helper to create element
function u(tag, className, html) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (html) el.innerHTML = html;
    return el;
}

async function getNavData() {
    try {
        // Fetch source of truth JSON
        const response = await fetch('data/index-cards.json?v=' + Date.now());
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                return data;
            }
        }
    } catch (e) {
        console.warn('Spatial Nav: JSON fetch failed', e);
    }
    return [];
}

function createCardElement(data) {
    const card = u('div', 'spatial-card');
    if (data.style) {
        card.setAttribute('style', data.style);
    }

    let iconContent = data.icon;
    if (data.icon && (data.icon.includes('/') || data.icon.endsWith('.svg'))) {
        // If it looks like a path and NOT an HTML tag (check for <)
        if (!data.icon.trim().startsWith('<')) {
            iconContent = `<img src="${data.icon}" class="nav-icon-img"/>`;
        }
    }

    card.innerHTML = `
        <div class="card-bg-text">${data.bgText}</div>
        <div class="card-icon">${iconContent}</div>
        <div class="card-title">${data.title}</div>
        <div class="card-desc">${data.desc}</div>
    `;

    card.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = data.url;
        if (target) window.location.href = target;
    });

    return card;
}

function createBrandHeader() {
    const header = u('div', 'spatial-brand-header');
    header.innerHTML = `
        <img src="ui/index.svg" alt="Logo" class="spatial-brand-logo" />
        <div class="spatial-brand-title">
            <span class="spatial-interactive" data-link="me.html">MAERS</span>
            <span class="spatial-interactive" data-link="space.html">SPACE</span>
        </div>
        <div class="spatial-brand-subtitle">Personal Knowledge & Creative Hub</div>
    `;

    // Event Listeners
    const logo = header.querySelector('.spatial-brand-logo');
    if (logo) {
        logo.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.location.href = 'index.html';
        });
    }

    const interactives = header.querySelectorAll('.spatial-interactive');
    interactives.forEach(span => {
        span.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const link = span.getAttribute('data-link');
            if (link) window.location.href = link;
        });
    });

    return header;
}

/**
 * 初始化空间导航系统
 * Replicated from init() in original spatial-nav.js
 */
export async function initSpatialNav() {
    if (window.self !== window.top) return;
    if (document.getElementById('spatial-nav-container')) return;

    const navData = await getNavData();
    if (!navData || navData.length === 0) return;

    const container = u('div');
    container.id = 'spatial-nav-container';

    if (document.querySelector('.nav-grid')) {
        container.classList.add('on-index-page');
    }

    // Add Brand Header
    const header = createBrandHeader();
    container.appendChild(header);

    const leftGroup = u('div', 'spatial-group');
    leftGroup.id = 'spatial-left-group';

    const rightGroup = u('div', 'spatial-group');
    rightGroup.id = 'spatial-right-group';

    // Automatic Split Logic:
    // Distribute cards evenly between left and right groups
    const half = Math.ceil(navData.length / 2);

    navData.forEach((item, index) => {
        const cardEl = createCardElement(item);
        if (index < half) {
            leftGroup.appendChild(cardEl);
        } else {
            rightGroup.appendChild(cardEl);
        }
    });

    container.appendChild(leftGroup);
    container.appendChild(rightGroup);
    document.body.appendChild(container);

    if (!document.querySelector('link[href*="spatial-nav.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'static-style/spatial-nav.css';
        document.head.appendChild(link);
    }
}
