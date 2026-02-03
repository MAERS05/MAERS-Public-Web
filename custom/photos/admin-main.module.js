/**
 * MAERS Photos - Admin Entry Point (Admin View)
 * @version 3.0.0 - ES6 Module
 */

// 导入所有模�?
import { DataProvider } from '../../data-manage/data-provider.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../shared/admin-core.module.js';
import { Controller, initController, State, reloadData, checkIsDirty, saveChanges, uploadFiles, fixPath } from './admin/photos-controller.module.js';
import { View, initView, render, openLightbox } from './viewer/photos-view.module.js';
import { Admin, initAdmin, initManager, togglePick, stageDelete, executeMove } from './admin/photos-admin.module.js';

// Pure ES6: AdminCore is imported, not mounted
const AdminCore = {
    BatchItemManager,
    SaveButton,
    AdminButtonHelper,
    Feedback
};

// 初始化依赖关�?
initController(DataProvider);
initAdmin(Controller, View, AdminCore);
initView(Controller, Admin, AdminCore);



