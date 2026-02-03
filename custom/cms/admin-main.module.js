/**
 * MAERS CMS - Admin Entry Point (Admin View)
 * @version 1.0.0 - ES6 Module
 */

// Import all CMS modules
import { State, SELECTORS, initState as initStateModule } from './viewer/cms-state.module.js';
import { Lightbox, initLightbox } from './viewer/cms-lightbox.module.js';
import { Search, initSearch } from './viewer/cms-search.module.js';
import { Events, initEvents } from './viewer/cms-events.module.js';
import { Tags, initTags } from './viewer/cms-tags.module.js';
import { View, init as initView, initView as initViewModule, setupViewEventListeners } from './viewer/cms-view.module.js';
import { Render, initRender } from './viewer/cms-render.module.js';
import { Admin, initAdmin } from './viewer/cms-admin.module.js';
import { Controller, AppState, CONFIG, bootstrap } from './admin/cms-controller.module.js';
import { Drag, initDrag } from './admin/cms-drag.module.js';
import { Editor, initEditor } from './admin/cms-editor.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../shared/admin-core.module.js';


// Initialize dependency injection
initStateModule(Controller);
initSearch(State, Render, Tags);
initAdmin(State, Controller, Render);
initEvents(State, Render, Admin, Tags, Editor);
initTags(State, Controller, Search);
initDrag(Admin, Controller, State);
initRender(State, Admin, Controller, Events, Drag);
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

        // Setup event listeners after bootstrap
        setupViewEventListeners();

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
