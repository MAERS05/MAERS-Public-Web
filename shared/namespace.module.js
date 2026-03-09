/**
 * MAERS Namespace Initializer
 * ES6 Module Version
 * @version 3.0.0 - ES6 Module
 */

/**
 * Initialize MAERS global namespace
 * @returns {Object} MAERS namespace object
 */
export function initNamespace() {
    'use strict';

    const MAERS = window.MAERS || {};

    // 核心工具
    MAERS.Utils = MAERS.Utils || {};
    MAERS.Toast = MAERS.Toast || {};
    MAERS.Templates = MAERS.Templates || {};
    MAERS.ModuleConfig = MAERS.ModuleConfig || {};

    // 数据层
    MAERS.ApiClient = MAERS.ApiClient || {};
    MAERS.DataProvider = MAERS.DataProvider || {};

    // CMS 模块
    MAERS.CMS = MAERS.CMS || {};
    MAERS.CMS.Core = MAERS.CMS.Core || {};
    MAERS.CMS.View = MAERS.CMS.View || {};
    MAERS.CMS.Editor = MAERS.CMS.Editor || {};
    MAERS.CMS.Drag = MAERS.CMS.Drag || {};

    // 相册模块
    MAERS.Album = MAERS.Album || {};
    MAERS.Album.Core = MAERS.Album.Core || {};
    MAERS.Album.Admin = MAERS.Album.Admin || {};

    // 音乐模块
    MAERS.Music = MAERS.Music || {};
    MAERS.Music.Player = MAERS.Music.Player || {};
    MAERS.Music.UI = MAERS.Music.UI || {};
    MAERS.Music.State = MAERS.Music.State || {};
    MAERS.Music.Drag = MAERS.Music.Drag || {};
    MAERS.Music.Admin = MAERS.Music.Admin || {};

    // 主题与布局
    MAERS.Theme = MAERS.Theme || {};
    MAERS.Layout = MAERS.Layout || {};
    MAERS.StyleInjector = MAERS.StyleInjector || {};

    // 管理后台
    MAERS.Admin = MAERS.Admin || {};

    // 搜索
    MAERS.Search = MAERS.Search || {};




    return MAERS;
}

// 自动初始化
const MAERS = initNamespace();

// 默认导出
export default MAERS;
