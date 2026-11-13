/**
 * CMS 页面启动：组装共用视图、协调后台保存，并在数据就绪后打开链接指定的文章。
 */
import { initLayout } from '../../../shared/layout.module.js';
import { initTheme } from '../../../shared/theme.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { SaveButton, Feedback } from '../../../data-manage/admin/admin-base.module.js';
import { Controller, bootstrap } from '../admin/cms-controller.module.js';
import { Drag, initDrag } from '../admin/cms-drag.module.js';
import { State, initState } from './cms-state.module.js';
import { Lightbox } from './cms-lightbox.module.js';
import { Search, initSearch } from './cms-search.module.js';
import { Events, initEvents } from './cms-events.module.js';
import { Tags, initTags } from './cms-tags.module.js';
import { View, initView, setupViewEventListeners } from './cms-view.module.js';
import { Render, initRender } from './cms-render.module.js';
import { Admin } from './cms-admin.module.js';
import { Recent, initRecent } from './cms-recent.module.js';
import { Reader, initReader } from './cms-reader.module.js';
import { findLinkedNote } from './cms-backlinks.module.js';

function setupAdminSave() {
    Controller.refreshView = View.refreshView;
    const checkGlobalDirty = () => {
        const dirty = [Admin.getManager(), Tags.getManager()].some(manager =>
            manager && manager.getSnapshot() !== manager.initialSnapshot);
        if (dirty) SaveButton.show();
        else SaveButton.hide();
    };

    SaveButton.init(document.body, async () => {
        const saved = await Admin.performSave();
        const tagsSaved = await Tags.tagPerformSave();
        if (saved === false || tagsSaved === false) return false;
        SaveButton.hide();
        Feedback.notifySaveSuccess();
    }, async () => {
        await Admin.performCancel();
        await Tags.tagPerformCancel();
        SaveButton.hide();
        Feedback.notifyCancel();
    });

    const manager = Admin.getManager();
    if (manager) manager.onChange = checkGlobalDirty;
    // 标签管理器在抽屉第一次打开时才创建。
    const toggleDrawer = Tags.toggleTagDrawer;
    Tags.toggleTagDrawer = () => {
        toggleDrawer();
        const tags = Tags.getManager();
        if (tags) tags.onChange = checkGlobalDirty;
    };
}

export function initCmsPage({ customView = null, onReady } = {}) {
    initLayout();
    initTheme();
    const admin = Controller.CONFIG.IS_ADMIN ? Admin : null;
    initState(Controller);
    initSearch(State, Render, Tags, customView);
    initEvents(State, Render, admin, Tags, Reader, customView, Recent);
    initTags(State, Controller, Search);
    if (admin) initDrag(Admin, Controller, State);
    initRender(State, admin, Controller, Events, admin ? Drag : null, customView, Search);
    initView({ State, Search, Tags, Render, Events, Lightbox, Admin: admin,
        Controller, Reader, CustomView: customView });
    initReader(Controller);

    const start = async () => {
        try {
            if (!(await bootstrap(View))) return;
            if (State.IS_ADMIN) setupAdminSave();
            setupViewEventListeners();
            initRecent(State, Controller, View);
            await onReady?.({ Reader, State });
            const note = findLinkedNote(Controller.AppState.allNodes, new URLSearchParams(window.location.search));
            if (note) await Reader.open(note);
        } catch (error) {
            console.error('[MAERS.CMS] 页面初始化失败:', error);
            Toast.error('页面初始化失败，请刷新重试：' + error.message);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
}
