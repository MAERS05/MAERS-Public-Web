/** 本机数据恢复面板：分范围备份、自定义保存位置、外部目录导入、校验、恢复回收文件及重试媒体同步。 */
import { localFetch } from '../api-client.module.js';
import { openFormModal, escapeHtml } from '../encrypt/lock-dialog.module.js';
import { Toast } from '../../shared/toast.module.js';

const BACKUP_LABELS = { local: '本机备份', cloud: '云端备份', legacy: '旧合并备份' };

async function request(path, body) {
    const response = await localFetch(path, body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    } : { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || '操作失败，请查看本机服务日志');
    return result;
}

function confirmRestore(text) {
    return new Promise(resolve => openFormModal({ title: '确认恢复', sub: text,
        confirmText: '恢复', onSubmit: () => { resolve(true); return true; }, onCancel: () => resolve(false) }));
}

async function browseFolder(title, input) {
    const picked = await request('/api/admin/pick_directory', { title });
    if (!picked.cancelled && picked.path && input) input.value = picked.path;
    return picked;
}

function openImportDialog(onImported) {
    const dialog = openFormModal({
        title: '从其他目录导入备份',
        sub: '可选择单个备份文件夹（含 manifest.json）或包含多份备份的上级目录，系统会逐一校验 SHA-256 后导入。',
        bodyHtml: `<div class="recovery-location">
            <input class="mlock-input" data-import-path placeholder="选择或粘贴外部备份文件夹绝对路径" autocomplete="off" spellcheck="false">
            <button type="button" class="mlock-btn-secondary" data-browse-import>浏览选择…</button>
        </div>`,
        confirmText: '校验并导入',
        onSubmit: async () => {
            const path = dialog.el.querySelector('[data-import-path]').value.trim();
            if (!path) return '请选择或输入外部备份目录路径';
            const result = await request('/api/admin/import_backup', { path });
            Toast.success(`已校验并导入 ${Number(result.imported) || 0} 份备份`);
            await onImported();
            return true;
        }
    });
    const input = dialog.el.querySelector('[data-import-path]');
    const browseBtn = dialog.el.querySelector('[data-browse-import]');
    browseBtn.onclick = async () => {
        browseBtn.disabled = true;
        try { await browseFolder('选择要导入的备份文件夹', input); }
        catch (error) { Toast.error(error.message); }
        finally { browseBtn.disabled = false; }
    };
}

export async function openDataRecovery() {
    const modal = openFormModal({ title: '备份与恢复',
        sub: '支持指定异盘备份保存目录或从外部目录导入备份。清理文件在回收区保留，可按批次恢复。',
        bodyHtml: '<div class="recovery-panel" data-recovery-body>读取中...</div>', confirmText: '关闭', cancelText: '', onSubmit: () => true });
    modal.el.querySelector('.mlock-box').classList.add('mlock-box--settings');
    const body = modal.el.querySelector('[data-recovery-body]');
    let busy = false;
    const render = async () => {
        const data = await request('/api/admin/recovery');
        if (!body.isConnected) return;
        const row = (item, kind) => {
            const id = escapeHtml(item.id);
            const backup = kind === 'backup';
            const label = backup ? escapeHtml(BACKUP_LABELS[item.scope] || '备份') + ' · ' : '';
            const verify = backup ? `<button type="button" class="mlock-btn-secondary" data-op="verify_backup" data-id="${id}">校验</button>` : '';
            const restore = `<button type="button" class="mlock-btn-secondary" data-op="restore_${kind}" data-id="${id}"
                data-scope="${escapeHtml(item.scope || '')}">恢复</button>`;
            const actions = item.scope === 'legacy'
                ? '<span class="recovery-caption">使用创建它的版本恢复</span>' : verify + restore;
            return `<div class="recovery-record">
                <div><div class="recovery-record__date">${escapeHtml(new Date(item.created * 1000).toLocaleString())}</div>
                <div class="recovery-caption">${label}${Number(item.files) || 0} 个文件</div></div>
                <div class="recovery-record__actions">${actions}</div>
            </div>`;
        };
        const section = (items, kind, title, hint, empty) => `<section class="recovery-section">
            <div class="recovery-section__header"><h3>${title}</h3><span class="recovery-caption">${items.length} 份</span></div>
            <p class="recovery-caption">${hint}</p>
            ${items.map(item => row(item, kind)).join('') || `<div class="recovery-empty">${empty}</div>`}</section>`;
        const dirValue = escapeHtml(data.backup_dir || '');
        const resetBtn = data.is_custom_dir
            ? '<button type="button" class="mlock-btn-secondary" data-op="reset_location">恢复默认</button>' : '';
        body.innerHTML = `<div class="recovery-tools">
            <button type="button" class="mlock-btn-secondary" data-op="backup" data-scope="local">备份本机</button>
            <button type="button" class="mlock-btn-secondary" data-op="backup" data-scope="cloud">备份云端</button>
            <button type="button" class="mlock-btn-secondary" data-op="import_dialog">导入外部备份</button>
            <button type="button" class="mlock-btn-secondary" data-op="retry" ${data.pending_media ? '' : 'disabled'}>重试图片同步（${Number(data.pending_media) || 0}）</button></div>
            <section class="recovery-section">
                <div class="recovery-section__header"><h3>备份保存位置</h3><span class="recovery-caption">${data.is_custom_dir ? '自定义目录' : '默认目录'}</span></div>
                <p class="recovery-caption">建议选择另一块硬盘或移动存储中的独立文件夹，创建与读取备份均使用此位置。</p>
                <div class="recovery-location">
                    <input class="mlock-input" data-location-input aria-label="备份保存目录" value="${dirValue}" autocomplete="off" spellcheck="false">
                    <button type="button" class="mlock-btn-secondary" data-op="browse_location">浏览…</button>
                    <button type="button" class="mlock-btn-secondary" data-op="save_location">保存位置</button>
                    ${resetBtn}
                </div>
            </section>
            ${section(data.backups, 'backup', '备份记录', '每次备份单独选择本机或云端，创建后自动校验。', '当前目录暂无备份。')}
            ${section(data.trash, 'trash', '清理回收区', '按清理批次找回文件，恢复时检查原路径是否冲突。', '暂无回收记录，清理移走的文件会显示在这里。')}`;
    };
    body.addEventListener('click', async event => {
        const button = event.target.closest('[data-op]');
        if (!button || busy) return;
        const { op, scope, id } = button.dataset;
        if (op === 'import_dialog') { openImportDialog(render); return; }
        busy = true;
        try {
            const locInput = body.querySelector('[data-location-input]');
            if (op === 'browse_location') {
                button.disabled = true;
                await browseFolder('选择备份保存文件夹', locInput);
                return;
            }
            if (op === 'save_location' || op === 'reset_location') {
                const nextPath = op === 'reset_location' ? '' : (locInput?.value.trim() || '');
                button.disabled = true;
                await request('/api/admin/backup_location', { path: nextPath });
                Toast.success(nextPath ? '备份保存位置已更新' : '已恢复默认备份位置');
                await render();
                return;
            }
            if (op === 'restore_backup') {
                const text = scope === 'cloud'
                    ? '恢复前会备份当前云端对象。桶内新增的图片、正文和归属记录会随云端恢复移除。'
                    : '恢复前会备份当前本机文件。备份之后的新文件会保留在回收区。';
                if (!await confirmRestore(text)) return;
            } else if (op === 'restore_trash' &&
                !await confirmRestore('恢复这一批清理文件。若原路径已有新文件，将停止恢复。')) return;
            button.disabled = true;
            button.textContent = '处理中...';
            const path = op === 'retry' ? '/api/media/retry' : '/api/admin/' + op;
            const result = await request(path, op === 'backup' ? { scope } : (id ? { id } : {}));
            if (result.state === 'pending') Toast.warning('仍有图片未同步，待办已保留，请检查连接后重试');
            else Toast.success(op === 'backup' ? `${BACKUP_LABELS[scope]}已创建并校验` : '操作完成');
            await render();
        } catch (error) { Toast.error(error.message); await render().catch(() => {}); }
        finally { busy = false; button.disabled = false; }
    });
    await render().catch(error => { body.textContent = error.message; });
}
