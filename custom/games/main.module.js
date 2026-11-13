/** 游戏入口：启动共用 CMS，并为访客展示 Playing / Played 视图。 */
import { initCmsPage } from '../cms/viewer/cms-page.module.js';
import { GamesView } from './viewer/games-view.module.js';

initCmsPage({
    onReady({ State }) {
        if (!State.IS_ADMIN) GamesView.init();
    }
});
