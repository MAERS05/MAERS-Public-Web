/**
 * MAERS Style Injector (style-injector.js)
 * 根据 modules.json 配置实现真正的"基底"与"样式"分离
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};

    let _modulesConfigCache = null;

    async function getModulesConfig() {
        if (_modulesConfigCache) return _modulesConfigCache;
        try {
            const res = await fetch(`custom/index/admin/modules.json?v=${Date.now()}`);
            if (!res.ok) throw new Error('Failed to load modules config');
            _modulesConfigCache = await res.json();
            return _modulesConfigCache;
        } catch (e) {
            console.error('[MAERS.StyleInjector] Error fetching modules.json:', e);
            return [];
        }
    }

    /**
     * 核心修改：健壮的路径匹配逻辑
     */
    async function injectModuleStyle(targetIdentifier = null) {
        const modules = await getModulesConfig();
        let targetModule = null;

        // 1. 优先匹配显式传入的标识符 (通常是 admin 页面调用)
        if (targetIdentifier) {
            targetModule = modules.find(m =>
                m.url.includes(`module=${targetIdentifier}`) ||
                m.title === targetIdentifier
            );
        }

        // 2. 自动检测逻辑 (Visitor 页面自适应)
        if (!targetModule) {
            const currentUrl = new URL(window.location.href);
            const currentPath = currentUrl.pathname.split('/').pop();
            const currentModuleParam = currentUrl.searchParams.get('module');

            targetModule = modules.find(m => {
                if (currentModuleParam && m.url.includes(`module=${currentModuleParam}`)) {
                    return true;
                }
                const configUrlBase = m.url.split('?')[0].split('/').pop();
                return configUrlBase === currentPath;
            });
        }

        // 3. 执行注入
        if (targetModule && targetModule.style) {
            if (!document.querySelector(`link[href*="${targetModule.style}"]`)) {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = targetModule.style;
                link.id = 'dynamic-module-style';
                document.head.appendChild(link);
                console.log(`[MAERS.StyleInjector] 🎨 Loaded skin: ${targetModule.style} for [${targetModule.title}]`);
            }
        } else {
            if (targetIdentifier) console.warn(`[MAERS.StyleInjector] No style found for: ${targetIdentifier}`);
        }
    }

    MAERS.StyleInjector = {
        inject: injectModuleStyle,
        getModules: getModulesConfig
    };

})(typeof window !== 'undefined' ? window : this);