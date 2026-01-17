/**
 * MAERS Namespace Initializer
 * 必须在所有其他 MAERS 模块之前加载
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    // 初始化顶层命名空间
    global.MAERS = global.MAERS || {};

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

})(typeof window !== 'undefined' ? window : this);
