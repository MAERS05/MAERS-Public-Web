/**
 * MAERS Literature - Main Entry Point
 * @version 3.0.1 - ES6 Module Migration (Fixed)
 */

// 0. Shared Utilities
import { Utils, Search as UrlSearch } from '../../shared/utils.module.js';

// 1. UI Infrastructure
import { initLayout } from '../shared/ui/layout.module.js';
import { initTheme } from '../shared/ui/theme.module.js';

// 2. CMS Core Modules
import { State, initState as initStateModule } from '../cms/viewer/cms-state.module.js';
import { Lightbox, initLightbox } from '../cms/viewer/cms-lightbox.module.js';
import { Search, initSearch } from '../cms/viewer/cms-search.module.js';
import { Tags, initTags } from '../cms/viewer/cms-tags.module.js';
import { Render, initRender } from '../cms/viewer/cms-render.module.js';
import { Events, initEvents } from '../cms/viewer/cms-events.module.js';
import { Admin } from '../cms/viewer/cms-admin.module.js';
import { View, initView, setupViewEventListeners } from '../cms/viewer/cms-view.module.js';
import { Recent, initRecent } from '../cms/viewer/cms-recent.module.js';

// 3. CMS Admin Modules
import { Controller, bootstrap } from '../cms/admin/cms-controller.module.js';
import { Editor, initEditor } from '../cms/admin/cms-editor.module.js';

// 4. Data Layer
import { DataProvider } from '../../data-manage/data-provider.module.js';

// 5. Literature Specific View
import { LiteratureView, initLiteratureView } from './viewer/literature-view.module.js';

// --- Initialization Sequence ---

// B. Initialize Core UI
initLayout();
initTheme();

// C. Initialize CMS System
// 1. Init Dependencies
initStateModule(Controller);
initSearch(State, Render, Tags, LiteratureView);
initEvents(State, Render, null, Tags, Editor, LiteratureView, Recent);
initTags(State, Controller, Search);
initRender(State, null, Controller, Events, null, LiteratureView);
initLightbox();

// 2. Init Components
initEditor(Controller);

// Wire up the View Layer (Dependency Injection)
initView({
    State,
    Search,
    Tags,
    Render,
    Events,
    Lightbox,
    Admin,
    Controller,
    CustomView: LiteratureView
});

// Initialize Literature View with Editor dependency
initLiteratureView({ Editor });

// E. Initialize Literature View & CMS Bootstrap
document.addEventListener('DOMContentLoaded', async () => {
    // Bootstrap CMS System (Loads data, renders shared Grid if needed, binds Search)
    await bootstrap(View);
    // Bind global CMS UI listeners (Tags drawer, etc.)
    setupViewEventListeners();
    // Initialize Recent Files
    initRecent(State, Controller, View);
    // Initialize Literature View (Flow Engine)
    await LiteratureView.init();
});
