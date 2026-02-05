/**
 * MAERS Album - Admin Entry Point
 * @version 3.0.0 - ES6 Module
 */

// 导入所有模�?
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../data-manage/admin-base.module.js';
import { AlbumAdmin, initAlbumAdmin, uiToggleSelect, uiToggleDelete, uiEdit, addNewCategory } from './admin/album-admin.module.js';

const AdminCore = {
    BatchItemManager,
    SaveButton,
    AdminButtonHelper,
    Feedback
};

// 初始化依赖关�?
initAlbumAdmin(AdminCore);
