/**
 * 静态站点发布：保留访客与云端管理页面，排除图片和 Markdown 正文、本机加密设置、恢复材料和开发工具。
 * dist 可重建；源数据及本机完整密钥环始终保留在原位置。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'dist');
const roots = new Set(['custom', 'shared', 'data-manage', 'static-style', 'plugins', 'ui', 'data']);
const excluded = new Set([
    'data/search-manifest.json',
    'data/search-manifest.json.tmp',
    'data-manage/encrypt/crypto-settings.module.js',
    'data-manage/encrypt/key-rotation.module.js',
    'data-manage/sync/cloudflare-worker-sync.js'
]);

function projectPasswordSlot(group) {
    const { v, dek_id, pw } = group || {};
    if (v !== 1 || !/^[0-9a-f]{16}$/.test(dek_id) || typeof pw?.salt !== 'string' || !pw.salt ||
        !Number.isInteger(pw.iter) || typeof pw.wrap !== 'string' || !pw.wrap.startsWith('enc:')) {
        throw new Error('公开密钥环无效，停止发布');
    }
    return { v, dek_id, pw: { salt: pw.salt, iter: pw.iter, wrap: pw.wrap } };
}

function projectKeyring(ring) {
    const publicRing = { ...projectPasswordSlot(ring), media_base: typeof ring.media_base === 'string' ? ring.media_base : '' };
    if (ring.master_only === true) publicRing.master_only = true;
    if (typeof ring.name === 'string' && !ring.master_only) publicRing.name = ring.name;
    if (ring.groups) {
        publicRing.groups = Object.fromEntries(Object.entries(ring.groups).map(([id, group]) => {
            if (!/^g_[0-9a-f]{32}$/.test(id) || typeof group?.name !== 'string' || ring.master_only && !group.master_wrap) {
                throw new Error('公开密码组无效，停止发布');
            }
            const entry = { ...projectPasswordSlot(group), name: group.name };
            if (Object.hasOwn(group, 'master_wrap')) {
                if (typeof group.master_wrap !== 'string' || !/^enc:[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(group.master_wrap)) {
                    throw new Error('公开密码组的主密码密钥槽无效，停止发布');
                }
                entry.master_wrap = group.master_wrap;
            }
            return [id, entry];
        }));
    }
    if (ring.content) {
        const content = ring.content;
        const validWrap = wrap => typeof wrap === 'string' && /^enc:[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(wrap);
        if (!ring.master_only || !validWrap(content.master_wrap) || !content.wraps ||
            Object.keys(content.wraps).length !== Object.keys(ring.groups || {}).length ||
            !Object.keys(ring.groups || {}).every(id => validWrap(content.wraps[id]))) {
            throw Error('内容密码密钥槽无效，停止发布');
        }
        publicRing.content = { ...projectPasswordSlot(content), master_wrap: content.master_wrap, wraps: content.wraps };
    }
    return publicRing;
}

function sourceFiles(directory = root) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (entry.name.startsWith('.')) return [];
        if (entry.isSymbolicLink()) throw new Error('发布源不能包含符号链接');
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return directory === root && !roots.has(entry.name) ? [] : sourceFiles(target);
        return [path.relative(root, target).split(path.sep).join('/')];
    });
}
let files;
try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).split('\0').filter(Boolean);
} catch {
    // 托管构建可能没有 .git；仍只遍历明确允许的站点目录。
    files = sourceFiles();
}

// 先检查源路径，拒绝通过符号链接把工作区之外的文件带入公开产物。
const publish = [...new Set(files)].filter(name => {
    if (!existsSync(path.join(root, name))) return false;
    const parts = name.split('/');
    if (parts.some(part => part.startsWith('.')) || excluded.has(name) || name.startsWith('plugins/pagefind/')) return false;
    if (parts.length === 1) return name.endsWith('.html') ||
        ['manifest.json', 'maers-version-controller.js'].includes(name);
    return roots.has(parts[0]) && !/\.(?:md|db(?:-wal|-shm)?|py|exe)$/i.test(name);
});
for (const name of publish) {
    const source = path.join(root, name);
    const resolved = realpathSync(source);
    const samePath = process.platform === 'win32' ? resolved.toLowerCase() === source.toLowerCase() : resolved === source;
    if (!samePath) throw new Error(`发布源不能通过路径别名读取其他文件：${name}`);
}
// 递归净化公开树结构：彻底剔除私密节点及其子树，保证公开访客端无任何私密文章踪迹。
function purgePrivateNodes(nodes) {
    if (!Array.isArray(nodes)) return [];
    const publicNodes = [];
    for (const node of nodes) {
        if (!node || node._private || node._enc || node._private_id || node._private_group) {
            continue;
        }
        const cleaned = { ...node };
        if (Array.isArray(cleaned.children)) {
            cleaned.children = purgePrivateNodes(cleaned.children);
        }
        publicNodes.push(cleaned);
    }
    return publicNodes;
}

if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('发布目录无效');
rmSync(output, { recursive: true, force: true });
for (const name of publish) {
    const target = path.join(output, name);
    mkdirSync(path.dirname(target), { recursive: true });
    if (name === 'data/crypto-keyring.json') {
        const ring = JSON.parse(readFileSync(path.join(root, name), 'utf8'));
        writeFileSync(target, JSON.stringify(projectKeyring(ring), null, 2) + '\n');
    } else if (name.startsWith('data/') && name.endsWith('-tree.json')) {
        const tree = JSON.parse(readFileSync(path.join(root, name), 'utf8'));
        if (Array.isArray(tree.root)) {
            tree.root = purgePrivateNodes(tree.root);
        }
        writeFileSync(target, JSON.stringify(tree, null, 2) + '\n');
    } else {
        copyFileSync(path.join(root, name), target);
    }
}
// Cloudflare 静态资源按分类路径返回图库页面；URL 中保留分类和查询参数。
writeFileSync(path.join(output, '_redirects'),
    '/photos/:category/ /photos/:category 301\n/photos/:category /photos 200\n');
process.stdout.write(`已生成静态站点：dist（${publish.length} 个文件）\n`);
