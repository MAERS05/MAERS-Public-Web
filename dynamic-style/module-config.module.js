/**
 * MAERS Module Configuration
 * ES6 Module Version
 * 模块配置常量，替代硬编码的 iconMap 和 titleMap
 * @version 3.0.0 - ES6 Module
 */

const MODULE_CONFIG = {
    notes: {
        icon: '📝',
        title: 'Study Notes',
        displayTitle: '✒️ Study Notes',
        allowTags: true,
        allowMove: true,
        allowContent: true,
        dataFile: 'data/notes-tree.json'
    },
    literature: {
        icon: '📙',
        title: 'Literature',
        displayTitle: '📙 Literature',
        allowTags: true,
        allowMove: true,
        allowContent: true,
        dataFile: 'data/literature-tree.json'
    },
    record: {
        icon: '📝',
        title: 'Records',
        displayTitle: '📝 Records',
        allowTags: true,
        allowMove: true,
        allowContent: true,
        dataFile: 'data/record-tree.json'
    },
    album: {
        icon: '🖼️',
        title: 'Album',
        displayTitle: '🖼️ Album',
        allowTags: false,
        allowMove: true,
        allowContent: false,
        dataFile: 'custom/album/admin/album-config.json'
    },
    music: {
        icon: '🎵',
        title: 'Music',
        displayTitle: '🎵 Music',
        allowTags: false,
        allowMove: false,
        allowContent: false,
        dataFile: 'data/music-data.json'
    }
};

const ModuleConfig = {
    // 原始配置对象
    _config: MODULE_CONFIG,

    /**
     * 获取模块配置
     * @param {string} moduleName - 模块名称
     * @returns {Object} 模块配置
     */
    get(moduleName) {
        return MODULE_CONFIG[moduleName] || MODULE_CONFIG.notes;
    },

    /**
     * 获取模块图标
     * @param {string} moduleName - 模块名称
     * @returns {string} 图标
     */
    getIcon(moduleName) {
        const config = this.get(moduleName);
        return config.icon;
    },

    /**
     * 获取模块标题
     * @param {string} moduleName - 模块名称
     * @returns {string} 标题
     */
    getTitle(moduleName) {
        const config = this.get(moduleName);
        return config.displayTitle;
    },

    /**
     * 获取节点类型图标
     * @param {string} type - 节点类型 (folder 或 note)
     * @returns {string} 图标
     */
    getNodeIcon(type) {
        return type === 'folder' ? '📁' : '📝';
    }
};

// 挂载到全局命名空间（向后兼容）
if (typeof window !== 'undefined') {
    window.MAERS = window.MAERS || {};
    window.MAERS.ModuleConfig = ModuleConfig;
}

// 导出
export { MODULE_CONFIG, ModuleConfig };
export default ModuleConfig;
