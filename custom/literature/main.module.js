/** 文学入口：启动共用 CMS，再初始化文学流动视图与阅读器依赖。 */
import { initCmsPage } from '../cms/viewer/cms-page.module.js';
import { LiteratureView, initLiteratureView } from './viewer/literature-view.module.js';
import '../zmobile adaptation/mobile-literature.js';

initCmsPage({
    customView: LiteratureView,
    async onReady({ Reader }) {
        initLiteratureView({ Reader });
        await LiteratureView.init();
    }
});
