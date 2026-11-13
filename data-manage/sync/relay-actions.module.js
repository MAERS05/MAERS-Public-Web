/**
 * 中继动作注册表 (relay-actions.module.js)
 * 职责：集中定义所有可云端暂存的 module:action，统一描述两件事：
 *   1. 电脑合并时调用的本地端点（resolveMergeRequest）
 *   2. 页面刷新后在内存中按时间顺序回放的纯函数（replay*）
 * 新增可暂存业务只需在此登记，队列、合并与回放流程无需改动。
 * 本模块不访问网络与 DOM，便于在 Node 中直接测试。
 */

/** CMS 业务模块（与后端 cms.JS_SYNC_MAP 保持一致） */
export const CMS_MODULES = Object.freeze(['notes', 'literature', 'record', 'games', 'videos']);

/** 允许云端暂存的 CMS 节点动作；open_external / protect 依赖本机，不入队 */
const CMS_NODE_ACTIONS = new Set(['add', 'update', 'delete', 'move', 'reorder', 'lock', 'unlock']);

export function isRetiredPhotoUpload(item) {
    return item?.module === 'photos' && item.action === 'upload' && item.awaitingPhoto === true;
}

/** 标签作用域：CMS 五类、space、photos-<分类> */
export function isTagScope(scope) {
    return typeof scope === 'string' &&
        (CMS_MODULES.includes(scope) || scope === 'space' || /^photos-[\w-]+$/.test(scope));
}

/** 标签分类的静态文件路径（与后端标签策略的落盘位置一致） */
export function tagCategoriesFile(scope) {
    return `data/tags/${CMS_MODULES.includes(scope) ? `cms-${scope}` : scope}-tag-categories.json`;
}

/**
 * 整份快照保存的文档。
 * save：电脑端保存端点；source：基线读取地址（手机端加载与电脑端冲突检测共用）
 */
export function documentSpec(doc) {
    if (doc === 'music') return { save: '/api/save_music', source: 'data/music-data.json' };
    if (doc === 'space-tree') return { save: '/api/space/save_tree', source: 'data/space-tree.json' };
    if (doc === 'changelog') {
        return { save: '/api/save_changelog', source: 'data/changelog.json', checkEachDraft: true };
    }
    const scope = typeof doc === 'string' && doc.startsWith('tags:') ? doc.slice(5) : null;
    if (scope && isTagScope(scope)) {
        return { save: `/api/cms/save_tag_categories?module=${encodeURIComponent(scope)}`, source: tagCategoriesFile(scope) };
    }
    return null;
}

/** 统一图片路径为仓库相对键：兼容 CDN 绝对地址与带前导斜杠的路径 */
export function photoPathKey(path) {
    if (typeof path !== 'string') return '';
    if (/^https?:\/\//i.test(path)) {
        try { path = decodeURIComponent(new URL(path).pathname); }
        catch { return ''; }
    }
    return path.replace(/^(?:\.\/|\/)+/, '');
}

/**
 * 电脑合并：草稿 → { endpoint, body }。
 * 未登记的动作直接抛错，合并流程保留该草稿并询问是否继续。
 */
export function resolveMergeRequest({ module, action, data } = {}) {
    const request = (endpoint, body) => ({ endpoint, body });
    if (module === 'private' && action === 'replace') return request('/api/private/relay-edit', data);
    if (CMS_MODULES.includes(module) && CMS_NODE_ACTIONS.has(action)) {
        return request(`/api/cms/node?module=${encodeURIComponent(module)}&action=${encodeURIComponent(action)}`, data);
    }
    if (module === 'photos') {
        if (action === 'upload') return request('/api/photos/register', data);
        if (action === 'delete') return request('/delete', { path: photoPathKey(data.path) });
        if (action === 'reorder') {
            return request(`/reorder?category=${encodeURIComponent(data.category)}`, data.order.map(path => ({ path: photoPathKey(path) })));
        }
        if (action === 'update_tags') return request('/api/photos/update_tags_by_path', { path: photoPathKey(data.path), tags: data.tags });
    }
    if (module === 'tags' && isTagScope(data?.scope)) {
        const query = `?module=${encodeURIComponent(data.scope)}`;
        if (action === 'rename') return request(`/api/cms/rename_tag${query}`, { old_name: data.oldName, new_name: data.newName });
        if (action === 'delete') return request(`/api/cms/delete_tag${query}`, { tag_name: data.tag });
    }
    if (module === 'space' && action === 'update_tags') return request('/api/space/update_tags', data);
    if (module === 'doc' && action === 'replace') {
        const spec = documentSpec(data?.doc);
        if (spec) return request(spec.save, data.content);
    }
    throw new Error(`未登记的中继动作: ${module}:${action}`);
}

/**
 * 草稿执行后其结果已被本地改动的文档：这些文档的快照不再与手机端基线比对。
 * 标签改名/删除会同步改写分类文件与（空间）节点标签，属于队列自身造成的变化，不是外部冲突。
 */
export function docsAffectedBy({ module, data } = {}) {
    if (module === 'space') return ['space-tree'];
    if (module !== 'tags' || !isTagScope(data?.scope)) return [];
    return [`tags:${data.scope}`, ...(data.scope === 'space' ? ['space-tree'] : [])];
}

/** 草稿按时间升序（同一时间保持入队顺序） */
export function byTimestamp(items) {
    return items.map((item, index) => ({ item, index }))
        .sort((a, b) => (a.item.timestamp || 0) - (b.item.timestamp || 0) || a.index - b.index)
        .map(entry => entry.item);
}

// ───────────────────────── 标签回放 ─────────────────────────

/** 去重并保持顺序 */
const unique = list => [...new Set(list)];

/**
 * 回放一条标签变更（与后端 rename_tag / delete_tag 语义一致）。
 * @param {Object} item - 草稿 { module:'tags', action, data }
 * @param {Object} target - { nodes: 带 tags 的扁平对象列表, categories: 标签分类数组 }（原地修改）
 * @returns {boolean} 是否为本作用域的标签变更
 */
export function applyTagChange(item, scope, { nodes = [], categories = null } = {}) {
    if (item?.module !== 'tags' || item.data?.scope !== scope) return false;
    const { action, data } = item;
    const rewrite = tags => action === 'rename'
        ? unique(tags.map(tag => tag === data.oldName ? data.newName : tag))
        : tags.filter(tag => tag !== data.tag);
    const affects = tags => Array.isArray(tags) && tags.includes(action === 'rename' ? data.oldName : data.tag);
    if (action !== 'rename' && action !== 'delete') return false;
    for (const node of nodes) if (affects(node?.tags)) node.tags = rewrite(node.tags);
    for (const category of categories || []) if (affects(category?.tags)) category.tags = rewrite(category.tags);
    return true;
}

// ───────────────────────── 文档回放 ─────────────────────────

/**
 * 按时间顺序回放文档：快照整份替换，其余草稿交给 onOther 在当前内容上原地处理。
 * @returns {*} 回放后的文档内容
 */
export function replayDocument(doc, base, items, onOther = null) {
    let content = base;
    for (const item of byTimestamp(items)) {
        if (item.module === 'doc' && item.action === 'replace' && item.data?.doc === doc) {
            content = structuredClone(item.data.content);
        } else if (onOther) {
            onOther(item, content);
        }
    }
    return content;
}

/** 规范化 JSON（键排序）用于内容指纹，忽略空白与键顺序差异 */
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
            .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

/** 文档内容指纹：规范化 JSON 的 SHA-256 */
export async function contentHash(value) {
    const bytes = new TextEncoder().encode(canonicalJson(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 在空间树快照上回放非快照草稿：标签改名/删除与单项标签更新。
 * @param {Object} item - 草稿
 * @param {{root:Array}} content - 空间树 { root: [...] }（原地修改）
 */
export function applySpaceDraft(item, content) {
    const nodes = [];
    walkTree(content?.root, node => nodes.push(node));
    if (applyTagChange(item, 'space', { nodes })) return;
    if (item?.module === 'space' && item.action === 'update_tags') {
        const node = nodes.find(entry => entry.id === item.data.id);
        if (node) node.tags = [...item.data.tags];
    }
}

// ───────────────────────── 图库回放 ─────────────────────────

/**
 * 回放当前分类的图库草稿：上传、删除、排序、图片标签与本分类的标签变更。
 * @param {string} category - 分类 ID
 * @param {Array} photos - 已发布图片列表（原地修改）
 */
export function replayPhotos(category, photos, items) {
    const scope = `photos-${category}`;
    const keyOf = photo => photoPathKey(photo.path);
    for (const item of byTimestamp(items)) {
        if (isRetiredPhotoUpload(item)) continue;
        if (applyTagChange(item, scope, { nodes: photos })) continue;
        const data = item.data || {};
        if (item.module !== 'photos' || data.category !== category) continue;
        if (item.action === 'upload') {
            const path = data.path;
            if ((data.scope && data.scope !== 'public') || typeof path !== 'string' ||
                !path.startsWith(`photos/images/${category}/`)) continue;
            if (photos.some(photo => keyOf(photo) === path)) continue;
            photos.unshift({ id: `relay_${path}`, path, thumb: path, preview: path,
                name: data.name, tags: Array.isArray(data.tags) ? [...data.tags] : [], _pendingRelay: true,
                ...(data.bucketId ? { bucketId: data.bucketId } : {}) });
        } else if (item.action === 'delete') {
            const index = photos.findIndex(photo => keyOf(photo) === photoPathKey(data.path));
            if (index !== -1) photos.splice(index, 1);
        } else if (item.action === 'reorder' && Array.isArray(data.order)) {
            const rank = new Map(data.order.map((path, index) => [photoPathKey(path), index]));
            const ordered = photos.map((photo, index) => ({ photo, index }))
                .sort((a, b) => (rank.get(keyOf(a.photo)) ?? rank.size + a.index) - (rank.get(keyOf(b.photo)) ?? rank.size + b.index));
            photos.splice(0, photos.length, ...ordered.map(entry => entry.photo));
        } else if (item.action === 'update_tags') {
            const photo = photos.find(entry => keyOf(entry) === photoPathKey(data.path));
            if (photo) photo.tags = [...data.tags];
        }
    }
    return photos;
}

// ───────────────────────── CMS 树回放 ─────────────────────────

/** 查找节点所在的同级数组与位置 */
function locate(list, id, parents = []) {
    for (let index = 0; index < list.length; index++) {
        if (list[index].id === id) return { siblings: list, index, node: list[index], parents };
        const found = list[index].children?.length ? locate(list[index].children, id, [...parents, list[index].title]) : null;
        if (found) return found;
    }
    return null;
}

/** 遍历树中全部节点 */
export function walkTree(list, visit) {
    for (const node of list || []) {
        visit(node);
        if (node.children) walkTree(node.children, visit);
    }
}

/** 检查节点或其后代是否包含独立的加密记录。 */
export function hasProtectedCmsContent(node, lockedNodes = []) {
    if (!node) return false;
    if (node._enc || node._cloudEnvelope || node._private_id) return true;
    return Boolean(node.children && (lockedNodes.some(item => item.parentId === node.id) ||
        node.children.some(child => hasProtectedCmsContent(child, lockedNodes))));
}

/** 同级文档和文件夹共用名称空间，首尾空白不用于区分名称。 */
export function assertCmsNodeName(siblings, title, id = null) {
    if (typeof title !== 'string' || !title.trim()) throw Error('名称不能为空');
    const name = title.trim();
    if (siblings.some(node => !node._enc && node.id !== id && String(node.title || '').trim() === name)) {
        throw Error('当前文件夹已存在同名文档或文件夹，请使用其他名称');
    }
    return name;
}

/** 在提交及私密草稿编辑前检查名称；不同逻辑父目录互不限制。 */
export function validateCmsNodeAction(root, action, data) {
    const hit = locate(root, data.id);
    const parent = id => id === 'root' || !id ? root : locate(root, id)?.node.children || [];
    if (action === 'add' && !hit) assertCmsNodeName(parent(data.parentId), data.title);
    if (action === 'update' && hit && Object.hasOwn(data.data || {}, 'title')) {
        assertCmsNodeName(hit.siblings, data.data.title, data.id);
    }
    if (action === 'move' && hit && !hit.node._enc) {
        assertCmsNodeName(parent(data.targetParentId), hit.node.title, data.id);
    }
    if (action === 'unlock' && hit && data.tree) {
        assertCmsNodeName(hit.siblings, data.tree.title, data.id);
    }
}

/**
 * 在 CMS 树上回放一条节点草稿（与后端 cms_nodes 语义一致）。
 * add 插入同级首位；move 追加到目标末尾；reorder 按给定顺序重排同级，未列出的保持在后。
 * @returns {boolean} 是否已处理
 */
export function applyCmsNodeAction(module, root, action, data) {
    validateCmsNodeAction(root, action, data);
    if (action === 'add') {
        if (locate(root, data.id)) return true;
        const hit = data.parentId && data.parentId !== 'root' ? locate(root, data.parentId) : null;
        const names = hit ? [...hit.parents, hit.node.title, data.title] : ['root', data.title];
        const safeTitle = names.map(name => name.replace(/[\\/*?:"<>|\x00-\x1f]/g, '').trim().replace(/\.+$/, '') || 'Untitled').join('-');
        const node = {
            id: data.id, type: data.type, title: data.title.trim(), tags: [],
            content: data.type === 'note' ? `markdown/${module}/${safeTitle}.md` : null,
            coverImage: null, children: data.type === 'folder' ? [] : null, _pendingRelay: true
        };
        const parent = hit?.node;
        if (parent) (parent.children ||= []).unshift(node);
        else root.unshift(node);
        return true;
    }
    if (action === 'update') {
        const node = locate(root, data.id)?.node;
        const fields = data.data || {};
        if (node) {
            if (fields.title) node.title = fields.title.trim();
            if (fields.tags) node.tags = [...fields.tags];
            if (fields.coverImage !== undefined) node.coverImage = fields.coverImage;
            if (fields.content !== undefined) {
                // 正文以草稿字段承载，保留原 Markdown 路径供阅读器与后续保存使用
                if (typeof node.content === 'string' && node.content.endsWith('.md')) node._mdPath = node.content;
                node._draftContent = fields.content;
            }
        }
        return true;
    }
    if (action === 'delete') {
        const found = locate(root, data.id);
        if (found) found.siblings.splice(found.index, 1);
        return true;
    }
    if (action === 'move') {
        const found = locate(root, data.id);
        if (!found) return true;
        const target = data.targetParentId && data.targetParentId !== 'root' ? locate(root, data.targetParentId)?.node : null;
        if (data.targetParentId !== 'root' && (!target || target.type !== 'folder')) return true;
        let circular = false;
        walkTree([found.node], node => { if (node.id === data.targetParentId) circular = true; });
        if (circular) return true;
        found.siblings.splice(found.index, 1);
        if (target) (target.children ||= []).push(found.node);
        else root.push(found.node);
        return true;
    }
    if (action === 'reorder') {
        const ids = Array.isArray(data.ids) ? data.ids : [];
        const siblings = ids.length ? locate(root, ids[0])?.siblings : null;
        if (!siblings) return true;
        const rank = new Map(ids.map((id, index) => [id, index]));
        const ordered = siblings.map((node, index) => ({ node, index }))
            .sort((a, b) => (rank.get(a.node.id) ?? ids.length + a.index) - (rank.get(b.node.id) ?? ids.length + b.index));
        siblings.splice(0, siblings.length, ...ordered.map(entry => entry.node));
        return true;
    }
    return false;
}

