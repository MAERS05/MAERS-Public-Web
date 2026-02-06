/**
 * MAERS CMS - Admin Entry Point (Admin View)
 * @version 1.0.0 - ES6 Module
 */

// Import all CMS modules
import { initTheme } from '../../shared/theme.module.js';
import { initLayout } from '../../shared/layout.module.js';
import { State, SELECTORS, initState as initStateModule } from './viewer/cms-state.module.js';
import { Lightbox, initLightbox } from './viewer/cms-lightbox.module.js';
import { Search, initSearch } from './viewer/cms-search.module.js';
import { Events, initEvents } from './viewer/cms-events.module.js';
import { Tags, initTags } from './viewer/cms-tags.module.js';
import { View, init as initView, initView as initViewModule, setupViewEventListeners } from './viewer/cms-view.module.js';
import { Render, initRender } from './viewer/cms-render.module.js';
import { Admin, initAdmin } from './viewer/cms-admin.module.js';
import { Recent, initRecent } from './viewer/cms-recent.module.js';
import { LiteratureView } from '../literature/viewer/literature-view.module.js';
import { Controller, AppState, CONFIG, bootstrap } from './admin/cms-controller.module.js';
import { Drag, initDrag } from './admin/cms-drag.module.js';
import { Editor, initEditor } from './admin/cms-editor.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../data-manage/admin-base.module.js';


// Initialize dependency injection

import { injectModuleStyle } from '../../shared/style-injector.module.js';

// Inject Module Specific Styles (Notes/Literature/Record)
injectModuleStyle(Controller.CONFIG.CURRENT_MODULE);

initLayout();
initTheme();
initStateModule(Controller);
initSearch(State, Render, Tags, LiteratureView);
initAdmin(State, Controller, Render, Search);
initEvents(State, Render, Admin, Tags, Editor, LiteratureView, Recent);
initTags(State, Controller, Search);
initDrag(Admin, Controller, State);
initRender(State, Admin, Controller, Events, Drag, LiteratureView, Search);
initViewModule({
    State,
    Search,
    Tags,
    Render,
    Events,
    Lightbox,
    Admin,
    Controller,
    Editor
});
initEditor(Controller);

// Bootstrap on DOMContentLoaded with Error Handling
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await bootstrap(View);

        // -- Global Admin Coordination --
        if (State.IS_ADMIN) {
            // Function to check if anything is dirty across all managers
            const checkGlobalDirty = () => {
                const adminManager = Admin.getManager();
                const tagManager = Tags.getManager?.();

                const adminDirty = adminManager ? (adminManager.getSnapshot() !== adminManager.initialSnapshot) : false;
                const tagDirty = tagManager ? (tagManager.getSnapshot() !== tagManager.initialSnapshot) : false;

                if (adminDirty || tagDirty) SaveButton.show();
                else SaveButton.hide();
            };

            // Initialize SaveButton once
            SaveButton.init(document.body, async () => {
                // Joint Save
                await Admin.performSave();
                if (Tags.tagPerformSave) await Tags.tagPerformSave();
                SaveButton.hide();
                // Central success notification
                Feedback.notifySaveSuccess();
            }, async () => {
                // Joint Cancel
                await Admin.performCancel();
                if (Tags.tagPerformCancel) await Tags.tagPerformCancel();
                SaveButton.hide();
                // Central cancel notification
                Feedback.notifyCancel();
            });

            // Override managers' onChange to use our global check
            // We do this after modules are initialized
            setTimeout(() => {
                const am = Admin.getManager();
                if (am) am.onChange = checkGlobalDirty;

                // Tags manager might be initialized lazily, so we hook into its toggle
                const originalToggle = Tags.toggleTagDrawer;
                Tags.toggleTagDrawer = () => {
                    originalToggle();
                    const tm = Tags.getManager?.();
                    if (tm) tm.onChange = checkGlobalDirty;
                };
            }, 100);
        }

        // Setup event listeners after bootstrap
        setupViewEventListeners();

        // Initialize Recent Files
        initRecent(State, Controller, View);

    } catch (error) {
        console.error('[MAERS.CMS] Bootstrap FAILED:', error);

        // Notify user about the critical failure
        if (window.MAERS?.Toast) {
            window.MAERS.Toast.error("CMS Initialization Failed: " + error.message);
        } else {
            alert("CMS Initialization Failed. Please reload the page.\n" + error.message);
        }
    }
});
