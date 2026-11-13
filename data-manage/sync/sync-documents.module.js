/** 快照文档保存：维护编辑基线，协调本地版本校验与云端暂存。 */
import { localFetch } from '../api-client.module.js';
import { contentHash, documentSpec } from './relay-actions.module.js';

function hasEnvelope(value) {
    return Boolean(value && typeof value === 'object' && (value._enc || Object.values(value).some(hasEnvelope)));
}

export class DocumentSnapshots {
    constructor(enqueue) {
        this._enqueue = enqueue;
        this._baselines = new Map();
    }

    remember(doc, content, mode) {
        if (content === undefined) this._baselines.delete(doc);
        else this._baselines.set(doc, { mode, value: structuredClone(content) });
    }

    base(doc, mode) {
        const baseline = this._baselines.get(doc);
        return baseline?.mode === mode ? baseline.value : undefined;
    }

    /** 单项改动只推进已保存的基线，保留页面其余未保存编辑。 */
    update(doc, mode, apply) {
        const baseline = this._baselines.get(doc);
        if (baseline?.mode !== mode) return;
        const value = structuredClone(baseline.value);
        apply(value);
        this.remember(doc, value, mode);
    }

    async write(doc, content, { base, apiBase, mode }) {
        const spec = documentSpec(doc);
        if (!spec) return { success: false, msg: `未登记的文档: ${doc}` };
        const remembered = this._baselines.get(doc);
        const baseline = base === undefined && remembered?.mode === mode ? remembered.value : base;
        if (baseline === undefined) throw new Error('未读取到编辑前的版本，请先重新加载数据');

        const snapshot = JSON.parse(JSON.stringify(content));
        let saved = snapshot;
        if (mode === 'relay') {
            const baseHash = await contentHash(baseline);
            const privateEdit = ['music', 'space-tree'].includes(doc) &&
                (hasEnvelope(baseline) || hasEnvelope(snapshot));
            const result = await this._enqueue({ doc, content: snapshot, baseHash, baseCaptured: true,
                ...(privateEdit ? { privateEdit: true } : {}) });
            if (!result.success) return result;
        } else {
            saved = await saveLocalSnapshot(`${apiBase}${spec.save}`, snapshot, baseline);
        }
        if (this._baselines.get(doc) === remembered) this.remember(doc, saved, mode);
        return { success: true };
    }
}

async function saveLocalSnapshot(endpoint, snapshot, baseline) {
    const response = await localFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _snapshot: snapshot, _base: baseline })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.error) throw new Error(result?.error || `保存失败 (HTTP ${response.status})`);
    return result?.snapshot ?? snapshot;
}
