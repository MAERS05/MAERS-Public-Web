/** 模块元数据：统一提供图标、标题和数据文件，前后台通过显式导入共用。 */
import { Utils } from './utils.module.js';

const MODULE_CONFIG = {
    notes: { icon: 'ui/notes-icon.svg', title: 'Study Notes', dataFile: 'data/notes-tree.json' },
    literature: { icon: 'ui/literature-icon.svg', title: 'Literature', dataFile: 'data/literature-tree.json' },
    record: { icon: 'ui/record-icon.svg', title: 'Records', dataFile: 'data/record-tree.json' },
    album: { icon: 'ui/album-icon.svg', title: 'Album', dataFile: 'data/album-config.json' },
    music: { icon: 'ui/music-icon.svg', title: 'Music', dataFile: 'data/music-data.json' },
    games: { icon: 'ui/games-icon.svg', title: 'Games', dataFile: 'data/games-tree.json' },
    videos: { icon: 'ui/music-icon.svg', title: 'Videos', dataFile: 'data/videos-tree.json' }
};

export const ModuleConfig = {
    get(moduleName = 'notes') {
        return Object.hasOwn(MODULE_CONFIG, moduleName) ? MODULE_CONFIG[moduleName] : { icon: null, title: moduleName.toUpperCase(),
            dataFile: `data/${moduleName}-tree.json` };
    },

    getTitle(moduleName, isAdmin = false) {
        const { icon, title } = this.get(moduleName);
        const fallback = ['games', 'videos'].includes(moduleName)
            ? " onerror=\"this.src='ui/literature-icon.svg'\"" : '';
        const image = icon ? `<img src="${Utils.escapeAttr(icon)}" alt="${Utils.escapeAttr(title)}"${fallback} style="height: 1.25em; width: auto; vertical-align: middle;">` : '📂';
        const text = moduleName === 'videos' && !isAdmin ? ['music', 'videos'].map(name =>
            `<span class="music-mode-btn${name === moduleName ? ' active' : ''}" onclick="window.location.href='${name}.html'">${Utils.escapeHtml(this.get(name).title)}</span>`
        ).join(' & ') : Utils.escapeHtml(title);
        return `${image} ${text}`;
    }
};
