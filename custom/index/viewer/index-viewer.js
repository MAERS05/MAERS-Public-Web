/**
 * MAERS Index Viewer (index-viewer.js)
 * Clean namespace implementation for Index page interactions
 */
(function(global) {
    'use strict';

    document.addEventListener('DOMContentLoaded', () => {
        // Navigation Cards
        const navMap = {
            'nav-notes': 'notes.html',
            'nav-record': 'record.html',
            'nav-literature': 'literature.html',
            'nav-album': 'album.html',
            'nav-music': 'music.html',
            'nav-ai': 'https://ai.maersy.com'
        };

        Object.keys(navMap).forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.style.cursor = 'pointer';
                el.addEventListener('click', () => {
                    window.location.href = navMap[id];
                });
            }
        });

        // Brand Interactions
        const logo = document.getElementById('brand-logo');
        if (logo && typeof toggleGlobalShrink === 'function') {
            logo.addEventListener('click', (e) => toggleGlobalShrink(e));
        }

        const brandMaers = document.getElementById('brand-maers');
        if (brandMaers) {
            brandMaers.addEventListener('click', () => window.location.href = 'me.html');
        }

        const brandSpace = document.getElementById('brand-space');
        if (brandSpace) {
            brandSpace.addEventListener('click', () => window.location.href = 'space.html');
        }
    });

})(typeof window !== 'undefined' ? window : this);
