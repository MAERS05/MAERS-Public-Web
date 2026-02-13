/**
 * @module custom/cms/admin/cms-tags-api.module.js
 * @description CMS 标签系统 - API 通信层
 * @version 1.0.0
 */

export const TagsApi = {
    /**
     * 重命名标签
     * @param {string} moduleName 
     * @param {string} oldName 
     * @param {string} newName 
     */
    async renameTag(moduleName, oldName, newName) {
        try {
            const res = await fetch(`/api/cms/rename_tag?module=${moduleName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_name: oldName, new_name: newName })
            });
            const result = await res.json();
            if (res.ok && result.success) {
                return { success: true, count: result.updated_count };
            }
            return { success: false, error: result.error || 'Unknown error' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 删除标签
     * @param {string} moduleName 
     * @param {string} tagName 
     */
    async deleteTag(moduleName, tagName) {
        try {
            const res = await fetch(`/api/cms/delete_tag?module=${moduleName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag_name: tagName })
            });
            const result = await res.json();
            if (res.ok && result.success) {
                return { success: true, count: result.updated_count };
            }
            return { success: false, error: result.error || 'Unknown error' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 保存标签分类排序
     * @param {string} moduleName 
     * @param {Array} categories 
     */
    async saveCategories(moduleName, categories) {
        try {
            const res = await fetch(`/api/cms/save_tag_categories?module=${moduleName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(categories)
            });
            return res.ok;
        } catch (e) {
            console.error('Failed to save tag order:', e);
            return false;
        }
    },

    /**
     * 清理未使用的标签
     * @param {string} moduleName 
     */
    async cleanupTags(moduleName) {
        try {
            const res = await fetch(`/api/cms/cleanup_tags?module=${moduleName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const result = await res.json();
            if (res.ok) {
                return result;
            }
            return { success: false, error: result.error || 'Unknown error' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 获取标签分类
     * @param {string} moduleName 
     */
    async getCategories(moduleName) {
        try {
            const res = await fetch(`/api/cms/tag_categories?module=${moduleName}`);
            if (res.ok) {
                return await res.json();
            }
            return [];
        } catch (e) {
            console.error('Failed to fetch categories:', e);
            return [];
        }
    }
};
