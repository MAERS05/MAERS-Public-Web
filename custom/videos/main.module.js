/**
 * MAERS Video - Main Entry Point
 */

import { initLayout } from '../../shared/layout.module.js';
import { initTheme } from '../../shared/theme.module.js';

import { State, initState as initStateModule } from '../cms/viewer/cms-state.module.js';
import { Lightbox, initLightbox } from '../cms/viewer/cms-lightbox.module.js';
import { Search, initSearch } from '../cms/viewer/cms-search.module.js';
import { Tags, initTags } from '../cms/viewer/cms-tags.module.js';
import { Render, initRender } from '../cms/viewer/cms-render.module.js';
import { Events, initEvents } from '../cms/viewer/cms-events.module.js';
import { Admin, initAdmin } from '../cms/viewer/cms-admin.module.js';
import { View, initView, setupViewEventListeners } from '../cms/viewer/cms-view.module.js';
import { Recent, initRecent } from '../cms/viewer/cms-recent.module.js';

import { Controller, bootstrap } from '../cms/admin/cms-controller.module.js';
import { Editor, initEditor } from '../cms/admin/cms-editor.module.js';
import { Drag, initDrag } from '../cms/admin/cms-drag.module.js';
import { SaveButton, Feedback } from '../../data-manage/admin-base.module.js';

initLayout();
initTheme();

initStateModule(Controller);
initSearch(State, Render, Tags, null);
initAdmin(State, Controller, Render, Search);
initEvents(State, Render, Admin, Tags, Editor, null, Recent);
initTags(State, Controller, Search);
initDrag(Admin, Controller, State);
initRender(State, Admin, Controller, Events, Drag, null, Search);
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
    // Controller will map video.html to video-tree.json automatically by its base name.
    await bootstrap(View);

    if (State.IS_ADMIN) {
        Controller.refreshView = View.refreshView;
    }

    setupViewEventListeners();
    initRecent(State, Controller, View);

    // [New Feature] Auto-open specific note from URL ('?openNote=Title')
    const urlParams = new URLSearchParams(window.location.search);
    const openNoteTitle = urlParams.get('openNote');
    if (openNoteTitle && Editor) {
        const normalize = (s) => s.trim().replace(/[《》]/g, '');
        const needle = normalize(openNoteTitle);
        let attempts = 0;
        const tryOpen = () => {
            const allNodes = Controller?.AppState?.allNodes;
            if (allNodes && allNodes.length > 0) {
                const targetNode = allNodes.find(n =>
                    n.type === 'note' && (n.title === openNoteTitle || normalize(n.title) === needle)
                );
                if (targetNode) Editor.open(targetNode);
            } else if (attempts < 50) {
                attempts++;
                setTimeout(tryOpen, 100);
            }
        };
        setTimeout(tryOpen, 200);
    }

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

        setTimeout(() => {
            if (Admin.getManager) {
                const am = Admin.getManager();
                if (am) am.onChange = checkGlobalDirty;
            }
            const originalToggle = Tags.toggleTagDrawer;
            Tags.toggleTagDrawer = () => {
                originalToggle();
                const tm = Tags.getManager?.();
                if (tm) tm.onChange = checkGlobalDirty;
            };
        }, 100);
    }
});
