/**
 * 静态站点发布：保留访客与云端管理页面，排除本机加密设置、恢复材料和开发工具。
 * dist 可重建；源数据及本机完整密钥环始终保留在原位置。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'dist');
const roots = new Set(['custom', 'shared', 'data-manage', 'static-style', 'plugins', 'ui', 'data', 'photos']);
const excluded = new Set([
    'data-manage/encrypt/crypto-settings.module.js',
    'data-manage/encrypt/key-rotation.module.js',
    'data-manage/sync/cloudflare-worker-sync.js'
]);
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
    const parts = name.split('/');
    if (parts.some(part => part.startsWith('.')) || excluded.has(name)) return false;
    if (parts.length === 1) return name.endsWith('.html') ||
        ['manifest.json', 'maers-version-controller.js'].includes(name);
    return roots.has(parts[0]) && !/\.(?:db(?:-wal|-shm)?|py|exe)$/i.test(name) && !name.startsWith('photos/images/');
});
for (const name of publish) {
    const source = path.join(root, name);
    const resolved = realpathSync(source);
    const samePath = process.platform === 'win32' ? resolved.toLowerCase() === source.toLowerCase() : resolved === source;
    if (!samePath) throw new Error(`发布源不能通过路径别名读取其他文件：${name}`);
}
if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('发布目录无效');
rmSync(output, { recursive: true, force: true });
for (const name of publish) {
    const target = path.join(output, name);
    mkdirSync(path.dirname(target), { recursive: true });
    if (name === 'data/crypto-keyring.json') {
        const ring = JSON.parse(readFileSync(path.join(root, name), 'utf8'));
        if (ring.v !== 1 || !ring.dek_id || !ring.pw?.wrap?.startsWith('enc:') || !ring.pw.salt) {
            throw new Error('公开密钥环无效，停止发布');
        }
        const publicRing = Object.fromEntries(['v', 'dek_id', 'pw', 'media_base'].map(key => [key, ring[key]]));
        publicRing.pw = Object.fromEntries(['salt', 'iter', 'wrap'].map(key => [key, ring.pw[key]]));
        writeFileSync(target, JSON.stringify(publicRing, null, 2) + '\n');
    } else {
        cpSync(path.join(root, name), target);
    }
}
process.stdout.write(`已生成静态站点：dist（${publish.length} 个文件）\n`);
