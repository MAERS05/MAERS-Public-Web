/**
 * MAERS CMS - Main Entry Point (User View)
 * @version 1.0.2 - ES6 Module with Shared Utils
 */

// 0. Shared Utilities
import { Utils, Search as UrlSearch } from '../../shared/utils.module.js';

// 1. UI Modules
import { initLayout } from '../shared/ui/layout.module.js';
import { initTheme } from '../shared/ui/theme.module.js';

// 2. CMS Core Modules
import { State, SELECTORS, initState as initStateModule } from './viewer/cms-state.module.js';
import { Lightbox, initLightbox } from './viewer/cms-lightbox.module.js';
import { Search, initSearch } from './viewer/cms-search.module.js';
import { Events, initEvents } from './viewer/cms-events.module.js';
import { Tags, initTags } from './viewer/cms-tags.module.js';
import { View, init as initView, initView as initViewModule, setupViewEventListeners } from './viewer/cms-view.module.js';
import { Render, initRender } from './viewer/cms-render.module.js';
import { Controller, AppState, CONFIG, bootstrap } from './admin/cms-controller.module.js';
import { Editor, initEditor } from './admin/cms-editor.module.js';

// 3. Initialize Dependency Injection
// UI
initLayout();
initTheme();

// CMS System
initStateModule(Controller);
initSearch(State, Render, Tags);
initEvents(State, Render, null, Tags, Editor); // No Admin in user view
initTags(State, Controller, Search);
initRender(State, null, Controller, Events, null); // No Admin/Drag in user view
initViewModule({
    State,
    Search,
    Tags,
    Render,
    Events,
    Lightbox,
    Admin: null,
    Controller,
    Editor
});
initEditor(Controller);

// 5. Bootstrap on DOMContentLoaded
document.addEventListener('DOMContentLoaded', async () => {
    await bootstrap(View);
    // Setup event listeners after bootstrap
    setupViewEventListeners();
});
