/** 本机数据恢复面板：完整备份、校验、恢复回收文件及重试媒体同步。 */
import { localFetch } from '../api-client.module.js';
import { openFormModal, escapeHtml } from '../encrypt/lock-dialog.module.js';
import { Toast } from '../../shared/toast.module.js';

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

export async function openDataRecovery() {
    const modal = openFormModal({ title: '备份与恢复',
        sub: '备份保存在本机，请复制到独立磁盘保留。清理文件在回收区保留，可按批次恢复。',
        bodyHtml: '<div class="recovery-panel" data-recovery-body>读取中...</div>', confirmText: '关闭', cancelText: '', onSubmit: () => true });
    modal.el.querySelector('.mlock-box').classList.add('mlock-box--settings');
    const body = modal.el.querySelector('[data-recovery-body]');
    let busy = false;
    const render = async () => {
        const data = await request('/api/admin/recovery');
        if (!body.isConnected) return;
        const row = (item, kind) => `<div class="recovery-record">
            <div><div class="recovery-record__date">${escapeHtml(new Date(item.created * 1000).toLocaleString())}</div>
            <div class="recovery-caption">${Number(item.files) || 0} 个文件</div></div>
            <div class="recovery-record__actions">
                ${kind === 'backup' ? `<button type="button" class="mlock-btn-secondary" data-op="verify_backup" data-id="${escapeHtml(item.id)}">校验</button>` : ''}
                <button type="button" class="mlock-btn-secondary" data-op="restore_${kind}" data-id="${escapeHtml(item.id)}">恢复</button>
            </div></div>`;
        const section = (items, kind, title, hint, empty) => `<section class="recovery-section">
            <div class="recovery-section__header"><h3>${title}</h3><span class="recovery-caption">${items.length} 份</span></div>
            <p class="recovery-caption">${hint}</p>
            ${items.map(item => row(item, kind)).join('') || `<div class="recovery-empty">${empty}</div>`}</section>`;
        body.innerHTML = `<div class="recovery-tools">
            <button type="button" class="mlock-btn-secondary" data-op="backup">创建完整备份</button>
            <button type="button" class="mlock-btn-secondary" data-op="retry" ${data.pending_media ? '' : 'disabled'}>重试图片同步（${Number(data.pending_media) || 0}）</button></div>
            ${section(data.backups, 'backup', '本机备份', '保存数据、正文和图片，创建后自动校验完整性。', '暂无备份，点击上方“创建完整备份”保存当前数据。')}
            ${section(data.trash, 'trash', '清理回收区', '按清理批次找回文件，恢复时检查原路径是否冲突。', '暂无回收记录，清理移走的文件会显示在这里。')}`;
    };
    body.addEventListener('click', async event => {
        const button = event.target.closest('[data-op]');
        if (!button || busy) return;
        const op = button.dataset.op;
        busy = true;
        try {
            if (op.startsWith('restore_') && !(await confirmRestore(op === 'restore_backup'
                ? '恢复前会备份当前数据。将恢复所选备份中的文件，备份之后的新文件会保留在回收区。'
                : '恢复这一批清理文件；若原路径已有新文件，将停止恢复以避免覆盖。'))) return;
            button.disabled = true;
            button.textContent = '处理中...';
            const path = op === 'retry' ? '/api/media/retry' : '/api/admin/' + op;
            const result = await request(path, button.dataset.id ? { id: button.dataset.id } : {});
            if (result.state === 'pending') Toast.warning('仍有图片未同步，待办已保留，请检查连接后重试');
            else Toast.success(op === 'backup' ? '完整备份已创建并校验' : '操作完成');
            await render();
        } catch (error) { Toast.error(error.message); await render().catch(() => {}); }
        finally { busy = false; button.disabled = false; }
    });
    await render().catch(error => { body.textContent = error.message; });
}
