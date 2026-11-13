/** 本机长操作：轮询真实处理进度，保持写入请求与原有鉴权、错误响应一致。 */
import { localFetch } from './api-client.module.js';
import { openProgress } from './encrypt/lock-dialog.module.js';

/** 页面重开时先展示服务中的任务，避免管理验证等待写锁时只剩空白。 */
export async function waitForStudioIdle() {
    let progress;
    try {
        while (true) {
            const response = await localFetch('/api/studio/status', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw Error('无法读取本地后台状态，请重试');
            const status = await response.json();
            if (status.state === 'error') throw Error(status.message || '本地后台恢复失败');
            if (!status.active && !status.draining && status.state !== 'starting') return;
            progress ||= openProgress('正在完成已开始的操作', 'decryption');
            const current = status.operation || status;
            progress.update(current.done, current.total, current.message || '正在完成已开始的操作');
            await new Promise(resolve => setTimeout(resolve, 800));
        }
    } finally { progress?.close(); }
}

export async function operationFetch(url, options, progress) {
    const identity = crypto.randomUUID().replaceAll('-', '');
    const target = new URL(url, window.location.href);
    target.searchParams.set('_operation', identity);
    let stopped = false;
    let timer;
    const poll = async () => {
        try {
            const response = await localFetch(`/api/studio/operation?id=${identity}`, { cache: 'no-store' });
            if (response.ok && !stopped) {
                const status = await response.json();
                if (!stopped) progress.update(status.done, status.total, status.message);
            }
        } catch { /* 写入请求负责报告最终结果，轮询失败继续重试。 */ }
        if (!stopped) timer = setTimeout(poll, 600);
    };
    timer = setTimeout(poll, 300);
    try {
        return await localFetch(target.href, options);
    } finally {
        stopped = true;
        clearTimeout(timer);
    }
}
