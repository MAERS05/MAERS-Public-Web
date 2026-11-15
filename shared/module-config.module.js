/** 模块元数据：统一提供图标、标题和数据文件，前后台通过显式导入共用。 */
import { Utils } from './utils.module.js';
import { icon as appIcon } from './icons.module.js';

const MODULE_CONFIG = {
    notes: { icon: 'ui/notes-icon.svg', title: '笔记', dataFile: 'data/notes-tree.json' },
    literature: { icon: 'ui/literature-icon.svg', title: '文学', dataFile: 'data/literature-tree.json' },
    record: { icon: 'ui/record-icon.svg', title: '记录', dataFile: 'data/record-tree.json' },
    album: { icon: 'ui/album-icon.svg', title: '相册', dataFile: 'data/album-config.json' },
    music: { icon: 'ui/music-icon.svg', title: '音乐', dataFile: 'data/music-data.json' },
    games: { icon: 'ui/games-icon.svg', title: '游戏', dataFile: 'data/games-tree.json' },
    videos: { icon: 'ui/music-icon.svg', title: '影视', dataFile: 'data/videos-tree.json' }
};

export const ModuleConfig = {
    get(moduleName = 'notes') {
        return Object.hasOwn(MODULE_CONFIG, moduleName) ? MODULE_CONFIG[moduleName] : { icon: null, title: moduleName.toUpperCase(),
            dataFile: `data/${moduleName}-tree.json` };
    },

    getTitle(moduleName, isAdmin = false) {
        const { title } = this.get(moduleName);
        const symbols = { notes: 'note', literature: 'book', record: 'clock', album: 'photo', music: 'music', games: 'game', videos: 'video' };
        const symbol = appIcon(symbols[moduleName] || 'folder', 24);
        const text = moduleName === 'videos' && !isAdmin
            ? '<a class="music-mode-btn" href="music.html">音乐</a><span class="music-section-divider" aria-hidden="true"></span><a class="music-mode-btn active" href="videos.html" aria-current="page">影视</a>'
            : '<span>' + Utils.escapeHtml(title) + '</span>';
        return symbol + text;
    }
};
