/**
 * MAERS Games - Main Entry Point
 */

import { initLayout } from '../../shared/layout.module.js';
import { initTheme } from '../../shared/theme.module.js';

import { State, initState as initStateModule } from '../cms/viewer/cms-state.module.js';
import { Lightbox, initLightbox } from '../cms/viewer/cms-lightbox.module.js';
import { Search, initSearch } from '../cms/viewer/cms-search.module.js';
import { Tags, initTags } from '../cms/viewer/cms-tags.module.js';
import { Render, initRender } from '../cms/viewer/cms-render.module.js';
import { Events, initEvents } from '../cms/viewer/cms-events.module.js';
import { Admin, initAdmin } from '../cms/viewer/cms-admin.module.js'; // Imported initAdmin
import { View, initView, setupViewEventListeners } from '../cms/viewer/cms-view.module.js';
import { Recent, initRecent } from '../cms/viewer/cms-recent.module.js';

import { Controller, bootstrap } from '../cms/admin/cms-controller.module.js';
import { Editor, initEditor } from '../cms/admin/cms-editor.module.js';
import { Drag, initDrag } from '../cms/admin/cms-drag.module.js'; // Added Drag
import { SaveButton, Feedback } from '../../data-manage/admin-base.module.js'; // Added components

initLayout();
initTheme();

initStateModule(Controller);
initSearch(State, Render, Tags, null);
initAdmin(State, Controller, Render, Search); // Initialize Admin
initEvents(State, Render, Admin, Tags, Editor, null, Recent); // Pass Admin
initTags(State, Controller, Search);
initDrag(Admin, Controller, State); // Initialize Drag
initRender(State, Admin, Controller, Events, Drag, null, Search); // Pass Admin, Drag
initLightbox();
initEditor(Controller);

initView({
    State,
    Search,
    Tags,
    Render,
    Events,
    Lightbox,
    Admin,
    Controller,
    Editor,
    CustomView: null
});

document.addEventListener('DOMContentLoaded', async () => {
    await bootstrap(View);
    setupViewEventListeners();
    initRecent(State, Controller, View);

    // -- Global Admin Save/Cancel Logic (Mirrored from Literature/Admin) --
    if (State.IS_ADMIN) {
        const checkGlobalDirty = () => {
            if (!Admin.getManager) return;
            const adminManager = Admin.getManager();
            const tagManager = Tags.getManager?.();
            const adminDirty = adminManager ? (adminManager.getSnapshot() !== adminManager.initialSnapshot) : false;
            const tagDirty = tagManager ? (tagManager.getSnapshot() !== tagManager.initialSnapshot) : false;

            if (adminDirty || tagDirty) SaveButton.show();
            else SaveButton.hide();
        };

        // Initialize SaveButton
        if (SaveButton.init) {
            SaveButton.init(document.body, async () => {
                if (Admin.performSave) await Admin.performSave();
                if (Tags.tagPerformSave) await Tags.tagPerformSave();
                SaveButton.hide();
                Feedback.notifySaveSuccess();
            }, async () => {
                if (Admin.performCancel) await Admin.performCancel();
                if (Tags.tagPerformCancel) await Tags.tagPerformCancel();
                SaveButton.hide();
                Feedback.notifyCancel();
            });
        }

        // Hook into managers
        setTimeout(() => {
            if (Admin.getManager) {
                const am = Admin.getManager();
                if (am) am.onChange = checkGlobalDirty;
            }
            // Tags hook
            const originalToggle = Tags.toggleTagDrawer;
            Tags.toggleTagDrawer = () => {
                originalToggle();
                const tm = Tags.getManager?.();
                if (tm) tm.onChange = checkGlobalDirty;
            };
        }, 100);
    }
});
