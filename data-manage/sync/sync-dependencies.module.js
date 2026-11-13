/** 合并失败后的依赖隔离：同一内容及其目录、附件依赖暂缓，其他草稿继续。 */
import { CMS_MODULES, photoPathKey } from './relay-actions.module.js';
import { cmsMediaReferences } from '../encrypt/private-media.module.js';

const overlaps = (left, right) => left === right || left === '*' || right === '*' ||
    (left.endsWith('*') && right.startsWith(left.slice(0, -1))) ||
    (right.endsWith('*') && left.startsWith(right.slice(0, -1)));
const intersects = (left, right) => [...left].some(a => [...right].some(b => overlaps(a, b)));

/** 复用正文引用解析，也收集封面、图片路径和快照中的附件。 */
function mediaKeys(value, keys = new Set()) {
    if (typeof value === 'string') {
        for (const { key } of cmsMediaReferences(value)) {
            keys.add(key);
            // 后端引用扫描在反引号和中文标点处结束，保留同样的候选键。
            keys.add(key.split(/[`、，；：！？]/)[0]);
        }
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(child => mediaKeys(child, keys));
    }
    return keys;
}

function hasOpaqueMedia(value) {
    if (!value || typeof value !== 'object') return false;
    return typeof value.enc === 'string' || typeof value._enc === 'string' || value.privateEdit === true ||
        Object.values(value).some(hasOpaqueMedia);
}

export class RelayDependencies {
    constructor() {
        this.parents = new Map();
        this.blocked = new Map();
        this.unreadable = new Set();
    }

    /** 只在该模块首次失败时读取目录，正常合并不增加请求。 */
    async hold(payload) {
        const module = payload?.module;
        if (CMS_MODULES.includes(module) && !this.parents.has(module)) {
            const parents = new Map();
            this.parents.set(module, parents);
            try {
                const response = await fetch(`data/${module}-tree.json`, {
                    cache: 'no-store', signal: AbortSignal.timeout(10000)
                });
                if (!response.ok) throw Error('无法读取目录');
                const tree = await response.json();
                if (!Array.isArray(tree.root)) throw Error('目录格式无效');
                const walk = (nodes, parent = 'root') => nodes.forEach(node => {
                    if (node.id) parents.set(node.id, parent);
                    if (node.children) walk(node.children, node.id);
                });
                walk(tree.root);
            } catch (error) {
                // 目录关系未知时保留本模块，避免越过失败的父目录操作。
                this.unreadable.add(module);
                console.warn('[SyncManager] 无法读取失败草稿的目录依赖:', module, error);
            }
        }
        // 未入库的移动不能改变目录关系；失败的新节点仍需登记以追踪后续子节点。
        if (payload?.action === 'add') this.track(payload);
        for (const [scope, access] of this.resources(payload)) {
            const held = this.blocked.get(scope) || { read: new Set(), write: new Set() };
            for (const mode of ['read', 'write']) access[mode].forEach(key => held[mode].add(key));
            this.blocked.set(scope, held);
        }
    }

    track(payload) {
        const { module, action } = payload || {};
        const data = payload?.data || {};
        const parents = this.parents.get(module);
        if (!parents) return;
        if (action === 'add' && data.id) parents.set(data.id, data.parentId || 'root');
        if (action === 'move' && data.id) parents.set(data.id, data.targetParentId || 'root');
    }

    resources(payload) {
        const { module, action } = payload || {};
        const data = payload?.data || {};
        const result = new Map();
        const add = (scope, read = [], write = []) => {
            const access = result.get(scope) || { read: new Set(), write: new Set() };
            read.filter(key => typeof key === 'string' && key).forEach(key => access.read.add(key));
            write.filter(key => typeof key === 'string' && key).forEach(key => access.write.add(key));
            result.set(scope, access);
        };
        add('photos', [...mediaKeys(data)]);
        if (CMS_MODULES.includes(module)) {
            const parents = this.parents.get(module) || new Map();
            const ancestors = id => {
                const ids = new Set();
                while (id && !ids.has(id)) { ids.add(id); id = parents.get(id); }
                return [...ids];
            };
            const ids = action === 'reorder' ? (Array.isArray(data.ids) ? data.ids : []) : [data.id];
            const write = new Set(ids.filter(id => typeof id === 'string' && id));
            // 父目录改名、移动、删除和加解锁会影响后代；普通兄弟文章仍可独立处理。
            for (const id of parents.keys()) {
                if (ancestors(id).some(parent => write.has(parent))) write.add(id);
            }
            const read = [...ids, data.parentId, data.targetParentId].flatMap(ancestors);
            add(module, read, this.unreadable.has(module) || !write.size ? ['*'] : [...write]);
        } else if (module === 'photos') {
            const path = photoPathKey(data.path);
            add('photos', [], action === 'reorder' ? [`photos/images/${data.category}/*`] : [path || '*']);
        } else if (module === 'private') {
            // 密文不能可靠推断节点关系，按来源保留；不会阻塞其他模块。
            add(data.source || 'private', [], ['*']);
        } else if (module === 'space') {
            add('space', [], [data.id || '*']);
        } else if (module === 'doc' || module === 'tags') {
            const doc = module === 'tags' ? `tags:${data.scope}` : typeof data.doc === 'string' ? data.doc : '';
            const scope = doc?.startsWith('tags:') ? doc.slice(5) : doc === 'space-tree' ? 'space' : doc;
            if (scope?.startsWith('photos-')) add('photos', [], [`photos/images/${scope.slice(7)}/*`]);
            else add(scope || module, [], ['*']);
        } else add(module || 'unknown', [], ['*']);
        return result;
    }

    isBlocked(payload) {
        if (!this.blocked.size) return false;
        for (const [scope, access] of this.resources(payload)) {
            const held = this.blocked.get(scope);
            if (held && (intersects(held.write, access.read) || intersects(held.write, access.write) ||
                intersects(held.read, access.write))) return true;
        }
        return false;
    }

    /** 尚未合并的正文仍可能引用成功项的附件；密文引用未知时全部保留到过期。 */
    mediaToAcknowledge(paths, pending) {
        if (pending.some(item => item.data?.module === 'private' || hasOpaqueMedia(item.data?.data))) return [];
        const referenced = new Set(pending.flatMap(item => [...mediaKeys(item.data?.data)]));
        return [...paths].filter(path => !referenced.has(path));
    }
}
