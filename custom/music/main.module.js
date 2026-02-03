/**
 * MAERS Music Main Entry (main.js)
 * 用户页面入口文件 - 整合所�?Music 模块
 * @version 1.0.1 - ES6 Module with Search Utils
 */

// 0. Shared Utilities
import { Utils, Search as UrlSearch } from '../../shared/utils.module.js';

// 1. UI Modules
import { initLayout } from '../shared/ui/layout.module.js';
import { initTheme } from '../shared/ui/theme.module.js';

// 2. Music Modules
import { DataProvider } from '../../data-manage/data-provider.module.js';
import { Player, playTrack, togglePlay, showTip, initPlayer } from './viewer/music-player-core.module.js';
import { ensurePlayerFrame, initIFrame } from './viewer/music-player-iframe.module.js';
import { enableBackgroundPlayback, disableBackgroundPlayback, togglePictureInPicture, initPIP } from './viewer/music-player-pip.module.js';
import { UI, loadMusicData, saveData, refreshCurrentView, enterLevel1, enterLevel2, slideTo, goBack, handleAlbumClick, initUI } from './viewer/music-ui.module.js';
import { renderCategories, renderCollections, renderAlbums, initRender } from './viewer/music-render.module.js';
import { playNext, playPrev, initControl } from './viewer/music-control.module.js';
import { saveState, restoreState, clearState, formatTime, initState } from './viewer/music-state.module.js';

// --- Initialization ---

// A. Mount Utilities
// window.MAERS.Utils removal: Now using imported Utils directly

// B. Init UI
initLayout();
initTheme();

// C. Init Music System
// 初始化模块间的依赖关�?
initIFrame(Player);
initPIP(Player, { playNext, playPrev });
initPlayer(UI, { ensurePlayerFrame }, { enableBackgroundPlayback, disableBackgroundPlayback });
initControl(Player, UI);
initRender(UI, null, Player, { ...Utils, Search: UrlSearch }, null);
initUI({ renderCategories, renderCollections, renderAlbums }, { playNext, playPrev }, null, Player); // Search passed as null
initState(Player, UI);
