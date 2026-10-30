/**
 * MAERS Private Media (private-media.module.js)
 * 职责：访客侧在会话解锁后，解密私密相册并生成带令牌的私有桶图片地址
 *
 * 图片地址前缀读取 data/crypto-keyring.json 的 media_base（后台「🛡️ 加密设置」中修改），
 * 默认即中继 Worker 地址。Worker 需实现 GET /private/<key>?t=<token>
 * （见 data-manage/sync/cloudflare-worker-sync.js）。
 */

import { getSessionKey, getAccessToken, unwrapRecord, isEncryptedRecord } from './crypto.module.js';
import { getMediaBase } from './keyring.module.js';

/**
 * 将仓库相对路径转换为带令牌的私有桶地址；绝对 URL 原样返回
 * @param {string} base - Worker 地址
 * @param {string} key - 例如 photos/images/xxx/a.jpg
 * @param {string} token - 访问令牌
 */
function toPrivateUrl(base, key, token) {
    if (!key) return key;
    if (/^https?:\/\//i.test(key)) return key;
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${base}/private/${encoded}?t=${token}`;
}

/**
 * 获取私密图片地址生成器（需会话已解锁且已配置地址）
 * @returns {Promise<((key:string)=>string)|null>}
 */
export async function getPrivateUrlBuilder() {
    // 先查会话：未解锁的访客不读取密钥环，不产生额外请求
    const token = await getAccessToken();
    const base = token ? await getMediaBase() : '';
    if (!base || !token) return null;
    return (key) => toPrivateUrl(base, key, token);
}

/**
 * 在加密的相册配置中查找并解密指定分类的载荷
 * @returns {Promise<{payload:Object, toUrl:Function}|null>}
 */
async function _findPayload(catId) {
    const key = await getSessionKey();
    const toUrl = key ? await getPrivateUrlBuilder() : null;
    if (!key || !toUrl) return null;

    let conf = [];
    try {
        const res = await fetch('data/album-config.json', { cache: 'no-cache' });
        if (res.ok) conf = await res.json();
    } catch {
        return null;
    }

    for (const rec of conf) {
        if (!isEncryptedRecord(rec)) continue;
        const payload = await unwrapRecord(rec, key);
        if (payload && payload.category && payload.category.id === catId) return { payload, toUrl };
    }
    return null;
}

/**
 * 解密指定私密分类，返回可直接渲染的图片列表
 * 无会话密钥、未配置基址或找不到时返回 null
 * @param {string} catId
 * @returns {Promise<Array|null>}
 */
export async function revealPrivateCategory(catId) {
    const found = await _findPayload(catId);
    if (!found) return null;
    const { payload, toUrl } = found;

    const rows = Array.isArray(payload.photos) ? payload.photos : [];
    return rows.map(r => ({
        id: r.id,
        name: r.name,
        hash: r.hash,
        tags: typeof r.tags === 'string' && r.tags ? safeParse(r.tags) : (r.tags || []),
        path: toUrl(r.path),
        thumb: toUrl(r.thumb),
        preview: toUrl(r.preview)
    }));
}

/**
 * 还原私密分类的标签分类定义（原 data/tags/photos-<id>-tag-categories.json）
 * @returns {Promise<Array|null>}
 */
export async function revealPrivateTagCategories(catId) {
    const found = await _findPayload(catId);
    if (!found || typeof found.payload.tags_file !== 'string') return null;
    try {
        const data = JSON.parse(found.payload.tags_file);
        return Array.isArray(data) ? data : null;
    } catch {
        return null;
    }
}

function safeParse(s) {
    try { return JSON.parse(s) || []; } catch { return []; }
}

// ══════════════════════════════════════════════
// CMS 私密节点还原、锁定提取与中继状态同步
// ══════════════════════════════════════════════

/** 识别正文中本地/R2 图片键，兼容 Markdown、HTML、相对路径和 URL 编码。 */
export function cmsMediaReferences(markdown) {
    const pattern = /(?:https?:\/\/[^\s<>"')\]]*?\/|(?:\.\.\/)*\/?)(photos\/(?:images|thumbnails|previews)\/[^\s<>"')\]]+)/g;
    return [...String(markdown || '').matchAll(pattern)].map(match => {
        const raw = match[1].split(/[?#]/)[0];
        let key = raw;
        try { key = decodeURIComponent(raw); } catch { /* 非法编码交由索引检查拒绝。 */ }
        return { source: match[0], key };
    });
}

/**
 * 将解密后的打包节点（字段 md 为正文）还原为公开 JSON 的节点结构
 * 正文直接放入 content（编辑器只对以 .md 结尾的 content 走文件路径懒加载，文本则原样显示）
 * 子树内仍加密的节点原样保留，由 revealInPlace 继续递归处理
 * @param {Object} p - 打包节点
 * @param {(key:string)=>string} [toUrl] - 私密图片地址生成器；封面已迁入私有桶时使用
 */
export function unpackRevealedNode(p, toUrl = null) {
    if (isEncryptedRecord(p)) return p;

    let content = typeof p.md === 'string' ? p.md : '';
    const mediaKeys = new Set((p.mediaRows || []).flatMap(row => [row.path, row.thumb, row.preview]).filter(Boolean));
    for (const { source, key } of cmsMediaReferences(content)) {
        if (mediaKeys.has(key)) content = content.split(source).join(toUrl ? toUrl(key) : 'about:blank');
    }
    // 正文恰好以 .md 结尾时追加换行，避免被误判为文件路径
    if (content.endsWith('.md')) content += '\n';

    const node = {
        id: p.id,
        type: p.type,
        title: p.title,
        tags: p.tags || [],
        content,
        coverImage: p.coverImage || null,
        children: Array.isArray(p.children)
            ? p.children.map(c => unpackRevealedNode(c, toUrl))
            : (p.type === 'folder' ? [] : null)
    };

    // 封面图已随节点迁入私有桶：改用带令牌的地址，无法生成时不显示封面
    if (p.coverRow) {
        node.coverImage = toUrl ? toUrl(p.coverRow.path) : null;
        node.coverPreview = toUrl ? toUrl(p.coverRow.preview || p.coverRow.path) : null;
        node.coverThumb = toUrl ? toUrl(p.coverRow.thumb || p.coverRow.path) : null;
    }
    return node;
}

/** 访客侧解密转换函数（带私密封面地址），供各视图共用 */
export async function getRevealTransform() {
    const toUrl = await getPrivateUrlBuilder().catch(() => null);
    const mark = node => {
        node._private = true;
        for (const child of node.children || []) mark(child);
        return node;
    };
    return (p) => mark(unpackRevealedNode(p, toUrl));
}

/**
 * 将树中的加密节点剪出，记入 lockedNodes 数组
 * 剪出后整棵树不含任何加密项，搜索/标签/排序等逻辑无需处理加密节点
 * 倒序遍历保证 i 为节点在原始同级列表中的位置
 * @param {Array} list - 节点列表
 * @param {Array} lockedNodes - 收集加密节点占位的目标数组
 * @param {string} [parentId='root'] - 父节点 ID
 */
export function extractLockedNodes(list, lockedNodes, parentId = 'root') {
    if (!Array.isArray(list) || !Array.isArray(lockedNodes)) return;
    for (let i = list.length - 1; i >= 0; i--) {
        const node = list[i];
        if (isEncryptedRecord(node)) {
            lockedNodes.unshift({ id: node.id, parentId, index: i, _enc: node._enc });
            list.splice(i, 1);
        } else if (node.children) {
            extractLockedNodes(node.children, lockedNodes, node.id);
        }
    }
}

function _findWithParent(list, id, parentId = 'root') {
    for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (n.id === id) return { list, index: i, parentId };
        if (Array.isArray(n.children)) {
            const hit = _findWithParent(n.children, id, n.id);
            if (hit) return hit;
        }
    }
    return null;
}

function _markDraft(node, packed) {
    if (!packed || isEncryptedRecord(node)) return;
    node._draftContent = typeof packed.md === 'string' ? packed.md : '';
    node._pendingRelay = true;
    if (packed.coverRow) {
        node._coverRow = packed.coverRow;
        node._origCover = packed.coverImage || null;
    }
    if (packed.mediaRows) node._mediaRows = packed.mediaRows;
    (node.children || []).forEach((c, i) => _markDraft(c, packed.children?.[i]));
}

/**
 * 在内存状态中应用 CMS 加锁/解锁（幂等：供云端中继模式在前端即时生效）
 * @param {Object} AppState - CMS AppState 对象
 * @param {Function} flattenFn - 重新拍平 AppState.root 的回调
 * @param {'lock'|'unlock'|'delete'} action
 * @param {Object} data - lock: { id, enc } / unlock: { id, tree }
 */
export function applyLockActionLocally(AppState, flattenFn, action, data) {
    if (!data?.id || !AppState) return;
    if (action === 'lock') {
        const hit = _findWithParent(AppState.root, data.id);
        if (!hit) return;
        hit.list.splice(hit.index, 1);
        AppState.lockedNodes.push({ id: data.id, parentId: hit.parentId, index: hit.index, _enc: data.enc });
    } else if (action === 'unlock') {
        const li = AppState.lockedNodes.findIndex(n => n.id === data.id);
        if (li < 0 || !data.tree) return;
        const locked = AppState.lockedNodes.splice(li, 1)[0];
        const node = unpackRevealedNode(data.tree);
        _markDraft(node, data.tree);
        if (Array.isArray(node.children)) extractLockedNodes(node.children, AppState.lockedNodes, node.id);
        const parent = locked.parentId === 'root' ? null : _findWithParent(AppState.root, locked.parentId);
        const siblings = parent ? (parent.list[parent.index].children ||= []) : AppState.root;
        siblings.splice(Math.min(locked.index ?? siblings.length, siblings.length), 0, node);
    } else if (action === 'delete') {
        AppState.lockedNodes = AppState.lockedNodes.filter(n => n.id !== data.id);
        return;
    } else {
        return;
    }
    AppState.allNodes = [];
    if (typeof flattenFn === 'function') flattenFn(AppState.root);
}
