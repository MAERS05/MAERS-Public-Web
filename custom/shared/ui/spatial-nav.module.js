/**
 * MAERS Spatial Navigation (spatial-nav.module.js)
 * Adds 3D floating navigation cards to the sides of the screen.
 * Dynamically fetches content from index.html to ensure synchronization.
 * Includes fallback data if fetch fails (e.g. local file system restrictions).
 * @version 2.0.0 - ES6 Module
 */

const NAV_CONFIG = {
    leftIds: ['nav-notes', 'nav-record', 'nav-literature'],
    rightIds: ['nav-album', 'nav-music', 'nav-games'],
    navMap: {
        "nav-notes": "notes.html",
        "nav-record": "record.html",
        "nav-literature": "literature.html",
        "nav-album": "album.html",
        "nav-music": "music.html",
        "nav-games": "games.html",
    }
};

const DEFAULT_NAV_DATA = [
    {
        id: "nav-notes",
        bgText: "KNOW",
        icon: "ui/notes-icon.svg",
        title: "Notes",
        desc: "Building a mental framework for learning."
    },
    {
        id: "nav-record",
        bgText: "IDEA",
        icon: "ui/record-icon.svg",
        title: "Record",
        desc: "Recording resonance sentence and insights."
    },
    {
        id: "nav-literature",
        bgText: "BOOK",
        icon: "ui/literature-icon.svg",
        title: "Literature",
        desc: "Private bookshelf for golden lines and thoughts."
    },
    {
        id: "nav-album",
        bgText: "PHOT",
        icon: "ui/album-icon.svg",
        title: "Lens",
        desc: "Personal visual photography archive album."
    },
    {
        id: "nav-music",
        bgText: "FLOW",
        icon: "ui/music-icon.svg",
        title: "Music",
        desc: "Personal playlist and rhythm. Listen to the vibe."
    },
    {
        id: "nav-games",
        bgText: "GAME",
        icon: "ui/games-icon.svg",
        title: "Games",
        desc: "Digital playground and interactive experiences.",
        style: "border-color: rgba(0, 255, 255, 0.2)"
    }
];

// Helper to create element
function u(tag, className, html) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (html) el.innerHTML = html;
    return el;
}

// Parse nav data from a document object (modal or current)
function parseNavData(doc) {
    const cards = Array.from(doc.querySelectorAll('.nav-card'));
    if (cards.length === 0) return null;

    return cards.map(card => ({
        id: card.id,
        bgText: card.querySelector('.card-bg-text')?.innerText || '',
        icon: card.querySelector('.card-icon')?.innerHTML || '',
        title: card.querySelector('.card-title')?.innerText || '',
        desc: card.querySelector('.card-desc')?.innerText || '',
        style: card.getAttribute('style') || ''
    }));
}

async function getNavData() {
    const localCards = parseNavData(document);
    if (localCards && localCards.length >= 6) {
        return localCards;
    }

    try {
        const response = await fetch('index.html');
        if (response.ok) {
            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            const data = parseNavData(doc);

            if (data && data.length > 0) {
                return data;
            }
        }
    } catch (e) {
        console.warn('Spatial Nav: Fetch failed, using fallback.');
    }

    return DEFAULT_NAV_DATA;
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
        const target = NAV_CONFIG.navMap[data.id];
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

    navData.forEach(item => {
        const cardEl = createCardElement(item);
        if (NAV_CONFIG.leftIds.includes(item.id)) {
            leftGroup.appendChild(cardEl);
        } else if (NAV_CONFIG.rightIds.includes(item.id)) {
            rightGroup.appendChild(cardEl);
        }
    });

    if (leftGroup.children.length === 0 && rightGroup.children.length === 0 && navData.length > 0) {
        const half = Math.ceil(navData.length / 2);
        navData.forEach((item, index) => {
            const cardEl = createCardElement(item);
            if (index < half) leftGroup.appendChild(cardEl);
            else rightGroup.appendChild(cardEl);
        });
    }

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
