/**
 * MAERS Style Injector
 * ES6 Module Version
 * 根据 modules.json 配置实现真正的"基底"与"样式"分离
 * @version 3.0.0 - ES6 Module
 */

let _modulesConfigCache = null;

async function getModulesConfig() {
    if (_modulesConfigCache) return _modulesConfigCache;
    try {
        const res = await fetch('data/admin-portal.json', { cache: 'no-cache' });
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
        }
    } else {
        if (targetIdentifier) console.warn(`[MAERS.StyleInjector] No style found for: ${targetIdentifier}`);
    }
}

// 挂载到全局命名空间（向后兼容）
if (typeof window !== 'undefined') {
    window.MAERS = window.MAERS || {};
    window.MAERS.StyleInjector = {
        inject: injectModuleStyle,
        getModules: getModulesConfig
    };
}

// 导出
export {
    getModulesConfig,
    injectModuleStyle
};

export default {
    inject: injectModuleStyle,
    getModules: getModulesConfig
};
