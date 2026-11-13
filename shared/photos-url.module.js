/** 相册分类地址：用独立代号生成路径，并检查代号格式与分类间冲突。 */

export function photoCategoryPath(category) {
    return `/photos/${encodeURIComponent(category.slug || category.id)}`;
}

export function validatePhotoCategorySlug(category, categories) {
    const slug = category.slug || '';
    if (typeof slug !== 'string' || slug && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
        throw new Error('链接代号须为 1 到 64 个小写字母、数字、短横线或下划线，并以字母或数字开头');
    }
    const name = slug || category.id;
    if (categories.some(item => !item._deleted && !item._enc && item.id !== category.id &&
        (item.id === name || (item.slug || item.id) === name || item.slug === category.id))) {
        throw new Error('链接代号已被其他分类使用');
    }
}
