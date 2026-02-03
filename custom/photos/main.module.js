/**
 * MAERS Photos - Main Entry Point (User View)
 * @version 3.0.0 - ES6 Module
 */

// 导入所有模块
import { initLayout } from '../shared/ui/layout.module.js';
import { initTheme } from '../shared/ui/theme.module.js';
import { DataProvider } from '../../data-manage/data-provider.module.js';
import { Controller, initController, State, reloadData, checkIsDirty, saveChanges, uploadFiles, fixPath } from './admin/photos-controller.module.js';
import { View, initView, render, openLightbox } from './viewer/photos-view.module.js';

// 初始化核心 UI
initLayout();
initTheme();

// 初始化依赖关系
initController(DataProvider);
initView(Controller);
