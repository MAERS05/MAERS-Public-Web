/**
 * MAERS Music Admin Main Entry (admin-main.js)
 * 管理页面入口文件 - 整合所�?Music 模块 + Admin 功能
 * @version 1.0.0 - ES6 Module Entry
 */

// 导入所有模�?
import { Utils, Search as UrlSearch } from '../../shared/utils.module.js';
import { DataProvider } from '../../data-manage/data-provider.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../data-manage/admin-base.module.js';
import { Player, playTrack, togglePlay, showTip, initPlayer } from './viewer/music-player-core.module.js';
import { ensurePlayerFrame, initIFrame } from './viewer/music-player-iframe.module.js';
import { enableBackgroundPlayback, disableBackgroundPlayback, togglePictureInPicture, initPIP } from './viewer/music-player-pip.module.js';
import { UI, loadMusicData, saveData, refreshCurrentView, enterLevel1, enterLevel2, slideTo, goBack, handleAlbumClick, initUI } from './viewer/music-ui.module.js';
import { renderCategories, renderCollections, renderAlbums, initRender } from './viewer/music-render.module.js';
import { playNext, playPrev, initControl } from './viewer/music-control.module.js';
import { saveState, restoreState, clearState, formatTime, initState } from './viewer/music-state.module.js';
import {
    Admin,
    getManager,
    isDeleted,
    getItemClass,
    uiSort,
    uiMoveTo,
    uiDelete,
    uiRename,
    uiEditAlbum,
    addCategory,
    addCollection,
    addAlbum,
    initAdmin
} from './admin/music-admin.module.js';

// 初始化模块间的依赖关�?
initIFrame(Player);
initPIP(Player, { playNext, playPrev });
initPlayer(UI, { ensurePlayerFrame }, { enableBackgroundPlayback, disableBackgroundPlayback });
initControl(Player, UI);

// Pure ES6: AdminCore is imported, not mounted
const AdminCore = {
    BatchItemManager,
    SaveButton,
    AdminButtonHelper,
    Feedback
};

initAdmin(UI, Player, AdminCore);
initRender(UI, Admin, Player, { ...Utils, Search: UrlSearch }, AdminCore);
initUI({ renderCategories, renderCollections, renderAlbums }, { playNext, playPrev }, UrlSearch, Player);
initState(Player, UI);
// E. Global Event Listeners & Admin Bindings
function bindGlobalEvents() {
    // 1. Message Listener (IFrame/Window communication)
    window.addEventListener('message', function (event) {
        if (event.data === 'toggle') Player && Player.togglePlay();
        else if (event.data === 'next') playNext();
        else if (event.data === 'prev') playPrev();
    });

    // 2. Admin Button Bindings
    const bindAddButtons = () => {
        const addBtns = document.querySelectorAll('.btn-add-entity');
        addBtns.forEach((btn, index) => {
            // Remove old listeners to be safe (though cloneNode is better, we just add here)
            btn.onclick = () => { // Use onclick property to override any potential dupes
                if (index === 0) addCategory();
                else if (index === 1) addCollection();
                else if (index === 2) addAlbum();
            };
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindAddButtons);
    } else {
        bindAddButtons();
    }
}

bindGlobalEvents();
