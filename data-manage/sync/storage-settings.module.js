/** 本机存储设置：卡片入口 + 子弹窗编辑桶组、发布地址，并按项复制同步 Worker 的配置。 */
import { confirmAction } from "../admin/admin-confirm.module.js";

import { localFetch } from '../api-client.module.js';
import { openFormModal } from '../encrypt/lock-dialog.module.js';
import { Toast } from '../../shared/toast.module.js';

const CONFIG_ROUTE = '/api/storage/config';
const TARGET_FIELDS = ['provider', 'bucket_name', 'endpoint_url', 'access_key_id', 'secret_access_key'];
const SITE_FIELDS = [
    ['MEDIA_PUBLIC_BASE', '公开图片地址'],
    ['CONTENT_PUBLIC_BASE', '公开正文地址']
];
const SCOPES = ['public', 'private'];
const WRITE_OPTIONS = [
    ['public_content', '公开正文存储桶', 'public'],
    ['private_content', '私密正文存储桶', 'private'],
    ['public_photo', '公开图片存储桶', 'public'],
    ['private_photo', '私密图片存储桶', 'private']
];
const DEFAULT = 'default';
const PROVIDER_NAMES = { b2: 'Backblaze B2', r2: 'Cloudflare R2' };
const CARDS = {
    public: { title: '公开内容桶', hint: '公开图片与正文', badge: true },
    private: { title: '私密内容桶', hint: '私密图片与正文', badge: true },
    defaults: { title: '默认位置与发布地址', hint: '新内容写入位置、公开访问域名' },
    worker: { title: '云端部署与 Worker 配置', hint: '复制源码、变量机密、构建命令与重写规则' }
};
const groupLabel = (group, scope) => `${group.id === DEFAULT ? '(默认)' : ''}${
    (scope ? group[scope]?.bucket_name : group.name) || group.name || group.id}`;

async function request(path, body) {
    const response = await localFetch(path, body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    } : { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法读取存储配置，请重试');
    return result;
}

/** 主窗口里的入口卡片：只展示名称与状态，点击后打开对应子弹窗。 */
function cardButton(id) {
    const { title, hint, badge } = CARDS[id];
    return `
        <button type="button" class="storage-card" data-card="${id}" data-open-pane="${id}"${id === 'worker' ? ' data-worker-settings' : ''}>
            <span class="storage-card__title">${title}<small>${hint}</small>
                ${id === 'defaults' ? '<span class="storage-error" data-address-save-error role="alert" hidden>公开发布地址不能为空</span>' : ''}
                ${id === 'worker' ? '<span class="storage-card__usage" data-worker-usage hidden></span>' : ''}
            </span>
            ${badge ? '<span class="storage-card__state" data-summary></span>' : ''}
        </button>`;
}

function bucketFields(scope) {
    return `
        <div class="storage-fields" data-pane-fields="${scope}" data-scope="${scope}">
            <label class="sync-field"><span class="sync-field__label">服务商</span>
                <select class="mlock-input" data-name="provider">
                    <option value="b2">Backblaze B2</option><option value="r2">Cloudflare R2</option>
                </select>
            </label>
            <label class="sync-field"><span class="sync-field__label">桶名</span>
                <input class="mlock-input" data-name="bucket_name" autocomplete="off" spellcheck="false" maxlength="63">
            </label>
            <label class="sync-field storage-fields__wide"><span class="sync-field__label">S3 端点</span>
                <input class="mlock-input" data-name="endpoint_url" type="url" placeholder="https://" spellcheck="false" autocomplete="off">
            </label>
            <label class="sync-field"><span class="sync-field__label">访问标识</span>
                <input class="mlock-input" data-name="access_key_id" autocomplete="off" spellcheck="false">
            </label>
            <label class="sync-field"><span class="sync-field__label">访问密钥</span>
                <input class="mlock-input" data-name="secret_access_key" type="password" autocomplete="new-password">
            </label>
        </div>`;
}

/** 子弹窗的字段区先放在隐藏容器中，窗口创建后由 buildPanes 移入各自弹窗。 */
const SETTINGS_FORM = `
    <div class="storage-config">
        <p class="mlock-sub" data-storage-status role="status">正在读取本机存储设置…</p>
        <fieldset class="storage-editor" data-storage-editor hidden>
            <div class="storage-picker">
                <label class="sync-field"><span class="sync-field__label">桶组</span>
                    <select class="mlock-input storage-bucket-select" data-group></select>
                </label>
                <button type="button" class="mlock-btn-secondary" data-add-group>新增桶组</button>
                <button type="button" class="mlock-btn-secondary" data-rename-group>重命名</button>
                <button type="button" class="mlock-btn-secondary" data-delete-group>删除</button>
            </div>
            <label class="sync-field" data-new-group hidden><span class="sync-field__label">新桶组代号</span>
                <input class="mlock-input" data-alias placeholder="如 archive-b" spellcheck="false" autocomplete="off" maxlength="32">
            </label>
            <div class="storage-cards">
                ${['public', 'private'].map(cardButton).join('')}
            </div>
            <div class="sync-field">
                <span class="sync-field__label">全局与运行模式</span>
                <div class="storage-cards">
                    ${['defaults', 'worker'].map(cardButton).join('')}
                </div>
                <div class="storage-mode-bar" data-mode-bar>
                    <span class="mlock-sub" data-mode-label></span>
                    <button type="button" class="mlock-btn-secondary" data-switch-mode="local" hidden>一键切回纯本机</button>
                    <button type="button" class="mlock-btn-secondary" data-switch-mode="cloud" hidden>恢复原云存储</button>
                </div>
            </div>
        </fieldset>
        <div data-pane-source hidden>
            ${bucketFields('public')}
            ${bucketFields('private')}
            <div class="storage-fields" data-pane-fields="defaults">
                ${WRITE_OPTIONS.map(([name, label]) => `
                    <label class="sync-field"><span class="sync-field__label">${label}</span>
                        <select class="mlock-input storage-bucket-select" data-write-bucket="${name}"></select>
                    </label>`).join('')}
                <p class="mlock-sub storage-fields__wide">文件归属和访问权限记录固定保存在默认私密桶。</p>
                ${SITE_FIELDS.map(([name, label]) => `
                    <label class="sync-field storage-fields__wide" hidden>
                        <span class="sync-field__label">${label}<span class="storage-error" data-address-error hidden>不能为空</span></span>
                        <input class="mlock-input" data-site="${name}" type="url" required placeholder="https://">
                    </label>`).join('')}
            </div>
            <div class="storage-stack" data-pane-fields="worker">
                <p class="mlock-sub">无需打开项目文件夹，在此直接复制 Worker 完整代码、主站构建命令、变量机密与 B2 域名重写表达式。</p>
                <div class="storage-picker">
                    <label class="sync-field"><span class="sync-field__label">复制项</span>
                        <select class="mlock-input" data-worker-name>
                            <optgroup label="部署代码与构建配置">
                                <option value="WORKER_SCRIPT">同步 Worker 完整代码 (cloudflare-worker-sync.js)</option>
                                <option value="PAGES_BUILD_COMMAND">主站构建命令 (Build command)</option>
                                <option value="PAGES_BUILD_OUTPUT">主站输出目录 (Build output directory)</option>
                            </optgroup>
                            <optgroup label="同步 Worker 机密 (Secret)" data-requires-cloud>
                                <option value="MEDIA_PUBLIC_S3">MEDIA_PUBLIC_S3</option>
                                <option value="MEDIA_PRIVATE_S3">MEDIA_PRIVATE_S3</option>
                                <option value="MEDIA_BUCKET_GROUPS">MEDIA_BUCKET_GROUPS</option>
                            </optgroup>
                            <optgroup label="同步 Worker 文本变量" data-requires-cloud>
                                <option value="MEDIA_PHOTO_BUCKETS">MEDIA_PHOTO_BUCKETS</option>
                                <option value="PUBLIC_MEDIA_READS">PUBLIC_MEDIA_READS</option>
                                <option value="PUBLIC_CONTENT_READS">PUBLIC_CONTENT_READS</option>
                            </optgroup>
                            <optgroup label="Cloudflare URL 重写规则 (B2)" data-requires-cloud>
                                <option value="CDN_PHOTO_HOST_RULE">公开图片匹配表达式 (主机名)</option>
                                <option value="CDN_PHOTO_REWRITE_EXPR">公开图片重写路径表达式 (Dynamic)</option>
                                <option value="CDN_CONTENT_HOST_RULE">公开正文匹配表达式 (主机名)</option>
                                <option value="CDN_CONTENT_REWRITE_EXPR">公开正文重写路径表达式 (Dynamic)</option>
                            </optgroup>
                        </select>
                    </label>
                    <button type="button" class="mlock-btn-secondary" data-copy-worker>复制值</button>
                </div>
                <input class="mlock-input" data-worker-value aria-label="复制 Worker 配置值" readonly hidden>
            </div>
        </div>
    </div>`;

function setGroups(select, groups, value, scope) {
    select.replaceChildren(...groups.map(group => new Option(group.id ? groupLabel(group, scope) : '新增桶组', group.id)));
    select.value = value;
}

export async function openStorageSettings() {
    if (document.getElementById('maers-storage-settings')) return;
    let saved;
    let selected = DEFAULT;
    let dirty = false;
    let openPane = null;
    const modal = openFormModal({
        icon: 'secret-key', title: '存储设置', sub: '为图片和 Markdown 配置 B2 或 R2 桶组',
        bodyHtml: SETTINGS_FORM, confirmText: '保存配置', cancelText: '关闭', focusDialog: true,
        onSubmit: save
    });
    modal.el.id = 'maers-storage-settings';
    const find = selector => modal.el.querySelector(selector);
    const box = find('.mlock-box');
    box.classList.add('mlock-box--storage');
    box.setAttribute('aria-label', '存储设置');
    const editor = find('[data-storage-editor]');
    const selector = find('[data-group]');
    const alias = find('[data-alias]');
    const status = find('[data-storage-status]');
    const ok = find('[data-act="ok"]');
    ok.disabled = true;

    /** 为每张卡片建立子弹窗，并把对应字段区移入其中；字段仍属于同一个主窗口 DOM。 */
    function buildPanes() {
        const source = find('[data-pane-source]');
        for (const [id, { title, hint }] of Object.entries(CARDS)) {
            const pane = document.createElement('div');
            pane.className = 'storage-pane';
            pane.hidden = true;
            pane.dataset.pane = id;
            pane.innerHTML = `
                <div class="mlock-box storage-pane__box" role="dialog" aria-modal="true" aria-label="${title}" tabindex="-1">
                    <div class="mlock-header">
                        <div class="mlock-title-group">
                            <span class="mlock-title">${title}</span><span class="mlock-sub">${hint}</span>
                        </div>
                    </div>
                    <div class="mlock-body"></div>
                    <div class="mlock-footer">
                        <button type="button" class="mlock-btn-primary" data-close-pane>完成</button>
                    </div>
                </div>`;
            pane.querySelector('.mlock-body').append(source.querySelector(`[data-pane-fields="${id}"]`));
            pane.addEventListener('click', event => { if (event.target === pane) hidePane(); });
            modal.el.append(pane);
        }
        source.remove();
    }

    function showPane(id) {
        openPane = find(`[data-pane="${id}"]`);
        openPane.hidden = false;
        (openPane.querySelector('.mlock-input:not([hidden]):not(:disabled)') || openPane.querySelector('.mlock-box')).focus();
    }

    function hidePane() {
        if (!openPane) return;
        const id = openPane.dataset.pane;
        openPane.hidden = true;
        openPane = null;
        SCOPES.forEach(refreshSummary);
        find(`[data-card="${id}"]`)?.focus();
    }

    /** 卡片状态徽章：服务商 · 桶名，未填写时提示未配置。 */
    function refreshSummary(scope) {
        const state = find(`[data-card="${scope}"] [data-summary]`);
        const bucket = targetInput(scope, 'bucket_name').value.trim();
        const provider = PROVIDER_NAMES[targetInput(scope, 'provider').value] || '';
        state.textContent = bucket ? `${provider} · ${bucket}` : '未配置';
        state.classList.toggle('is-empty', !bucket);
    }

    function targetInput(scope, name) {
        return find(`[data-scope="${scope}"] [data-name="${name}"]`);
    }

    buildPanes();
    const workerValue = find('[data-worker-value]');
    const addressInputs = [...modal.el.querySelectorAll('[data-site]')];
    const addressSaveError = find('[data-address-save-error]');
    const addressMissing = input => !input.closest('label').hidden && !input.value.trim();

    function setAddressError(input, invalid) {
        input.closest('label').querySelector('[data-address-error]').hidden = !invalid;
        input.setAttribute('aria-invalid', String(invalid));
    }

    function finishPane() {
        if (openPane?.dataset.pane === 'defaults') {
            const missing = addressInputs.filter(addressMissing);
            for (const input of addressInputs) setAddressError(input, missing.includes(input));
            if (missing.length) {
                missing[0].focus();
                return;
            }
        }
        hidePane();
    }

    function render() {
        const group = saved.groups.find(item => item.id === selected);
        const configured = Boolean(group?.public);
        const hasDefault = Boolean(saved.groups[0].public);
        setGroups(selector, selected ? saved.groups : [...saved.groups, { id: '' }], selected);
        find('[data-new-group]').hidden = Boolean(selected);
        find('[data-add-group]').disabled = !hasDefault || !selected;
        find('[data-rename-group]').disabled = !configured;
        find('[data-delete-group]').disabled = !selected || selected === DEFAULT;
        alias.value = '';
        for (const scope of SCOPES) {
            const bucket = group?.[scope];
            for (const name of TARGET_FIELDS) {
                const input = targetInput(scope, name);
                const credential = name === 'access_key_id' || name === 'secret_access_key';
                input.value = credential ? '' : (bucket?.[name] || (name === 'provider' ? 'b2' : ''));
                input.disabled = configured && !credential;
                if (credential) input.placeholder = bucket?.savedCredentials ? '已保存，可更换' : '填写存储凭据';
            }
            refreshSummary(scope);
        }
        for (const [name, , scope] of WRITE_OPTIONS) {
            setGroups(find(`[data-write-bucket="${name}"]`), saved.groups, saved.writeBuckets[name], scope);
        }
        for (const input of addressInputs) {
            const name = input.dataset.site;
            input.value = saved.site[name] || '';
            input.closest('label').hidden = !Object.hasOwn(saved.site, name);
            setAddressError(input, false);
        }
        addressSaveError.hidden = true;
        const workerSelect = find('[data-worker-name]');
        for (const groupEl of workerSelect.querySelectorAll('[data-requires-cloud]')) {
            groupEl.disabled = !hasDefault;
        }
        if (!hasDefault && workerSelect.selectedOptions[0]?.parentElement?.hasAttribute('data-requires-cloud')) {
            workerSelect.value = 'WORKER_SCRIPT';
        }
        const workerUsage = find('[data-worker-usage]');
        const usage = hasDefault ? saved.workerBucketGroups : null;
        workerUsage.hidden = !usage;
        if (usage) {
            workerUsage.textContent = `MEDIA_BUCKET_GROUPS 已用 ${(usage.bytes / 1000).toFixed(1)} / ${usage.limit / 1000} KB`;
            workerUsage.classList.toggle('storage-error', usage.bytes >= usage.limit * 0.9);
        }
        find('[data-mode-label]').textContent = hasDefault
            ? '当前：云端对象存储模式（切回纯本机不会删除已填凭据）'
            : (saved.hasSavedCloud ? '当前：纯本机模式（已保留原云存储凭据，可一键恢复）' : '当前：纯本机目录存储模式');
        find('[data-switch-mode="local"]').hidden = !hasDefault;
        find('[data-switch-mode="cloud"]').hidden = hasDefault || !saved.hasSavedCloud;
        workerValue.value = '';
        workerValue.hidden = true;
        status.textContent = configured ? '可修改显示名称和访问密钥。更换实际桶名、服务商或端点需先迁移数据。' :
            (selected ? '先填写默认桶组的两个桶，保存后可以继续添加。' : '填写新桶组的代号和两个桶。');
        dirty = false;
    }

    function syncRuntimeConfig() {
        if (!window.MAERS?.Config || !saved?.site) return;
        for (const [name] of SITE_FIELDS) {
            if (Object.hasOwn(saved.site, name)) window.MAERS.Config[name] = saved.site[name];
        }
    }

    async function changeGroup(id) {
        if (dirty && !await confirmAction({ confirmText: "放弃修改并切换", cancelText: "继续编辑" })) {
            selector.value = selected;
            return;
        }
        selected = id;
        render();
        if (!id) alias.focus();
    }

    async function save() {
        if (!saved) return;
        const missing = addressInputs.some(addressMissing);
        addressSaveError.hidden = !missing;
        if (missing) return;
        const id = selected || alias.value.trim();
        if (!id) return '请输入新桶组代号';
        const body = { id, create: !selected, site: {} };
        const destinations = {};
        for (const [name] of WRITE_OPTIONS) {
            const value = find(`[data-write-bucket="${name}"]`).value;
            if (value !== saved.writeBuckets[name]) destinations[name] = value;
        }
        if (Object.keys(destinations).length) body.writeBuckets = destinations;
        for (const name of Object.keys(saved.site)) {
            const value = find(`[data-site="${name}"]`).value.trim();
            if (value !== saved.site[name]) body.site[name] = value;
        }
        for (const scope of SCOPES) {
            body[scope] = Object.fromEntries(TARGET_FIELDS.map(name => [name, targetInput(scope, name).value.trim()]));
        }
        editor.disabled = true;
        try {
            saved = await request(CONFIG_ROUTE, body);
            syncRuntimeConfig();
            selected = id;
            render();
            Toast.success('存储配置已保存');
        } finally {
            editor.disabled = false;
        }
    }

    function switchStorageMode(mode) {
        if (dirty) { Toast.info('请先保存或放弃当前未保存的修改'); return; }
        const toLocal = mode === 'local';
        openFormModal({
            title: toLocal ? '切换为纯本机模式' : '恢复原云存储配置',
            sub: toLocal
                ? '将同步云端权限记录到本机、清空公开发布域名并切换为纯本机存储；已填写的云存储桶组与密钥会保存在本机以便随时恢复。'
                : '将恢复此前保存的云存储桶组配置与公开发布域名。',
            confirmText: toLocal ? '确认切回纯本机' : '恢复云存储',
            onSubmit: async () => {
                editor.disabled = true;
                try {
                    saved = await request('/api/storage/mode', { mode });
                    syncRuntimeConfig();
                    selected = DEFAULT;
                    render();
                    Toast.success(toLocal ? '已切换为纯本机存储模式' : '已恢复原云存储配置');
                    return true;
                } finally {
                    editor.disabled = false;
                }
            }
        });
    }

    selector.onchange = () => changeGroup(selector.value);
    find('[data-add-group]').onclick = () => changeGroup('');
    function editGroup(action) {
        if (dirty) { Toast.info('请先保存当前配置，再管理桶组'); return; }
        const group = saved.groups.find(item => item.id === selected);
        if (!group) return;
        const deleting = action === 'delete';
        const dialog = openFormModal({
            title: deleting ? '删除桶组配置' : '重命名桶组',
            sub: deleting ? `将移除「${group.name}」的配置。系统会检查文件、历史版本和归属记录。` : '名称用于界面显示，文件引用继续使用原有代号。',
            fields: deleting ? [] : [{ name: 'name', placeholder: '桶组名称', type: 'text', value: group.name }],
            confirmText: deleting ? '检查并删除配置' : '保存名称',
            onSubmit: async values => {
                editor.disabled = true;
                try {
                    saved = await request('/api/storage/group', { id: group.id, action, ...values });
                    if (deleting) selected = DEFAULT;
                    render();
                    Toast.success(deleting ? '桶组配置已删除，请更新 Worker 的桶组配置' : '桶组名称已更新');
                    return true;
                } finally { editor.disabled = false; }
            }
        });
        const input = dialog.el.querySelector('input');
        input?.setAttribute('maxlength', '64');
        input?.setAttribute('aria-label', '桶组名称');
    }
    find('[data-rename-group]').onclick = () => editGroup('rename');
    find('[data-delete-group]').onclick = () => editGroup('delete');
    for (const btn of modal.el.querySelectorAll('[data-switch-mode]')) {
        btn.onclick = () => switchStorageMode(btn.dataset.switchMode);
    }
    modal.el.addEventListener('click', event => {
        const card = event.target.closest('[data-open-pane]');
        if (card) showPane(card.dataset.openPane);
        else if (event.target.closest('[data-close-pane]')) finishPane();
    });
    modal.el.addEventListener('input', event => {
        if (event.target !== selector && !event.target.closest('[data-pane-fields="worker"]')) dirty = true;
        if (addressInputs.includes(event.target) && !addressMissing(event.target)) {
            setAddressError(event.target, false);
            if (!addressInputs.some(addressMissing)) addressSaveError.hidden = true;
        }
        const scope = event.target.closest('[data-scope]')?.dataset.scope;
        if (scope) refreshSummary(scope);
    });
    // 在 window 捕获阶段处理子弹窗按键，避免 Enter 触发主弹窗的保存。
    const onPaneKey = event => {
        if (!modal.el.isConnected) { window.removeEventListener('keydown', onPaneKey, true); return; }
        if (!openPane) return;
        if (CSS.supports('selector(select:open)') && openPane.querySelector('select:open')) return;
        if (event.key === 'Escape' || (event.key === 'Enter' && event.target?.tagName === 'INPUT')) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') hidePane();
            else finishPane();
        }
    };
    window.addEventListener('keydown', onPaneKey, true);
    find('[data-worker-name]').onchange = () => { workerValue.value = ''; workerValue.hidden = true; };
    const copy = find('[data-copy-worker]');
    copy.onclick = async () => {
        copy.disabled = true;
        workerValue.value = '';
        workerValue.hidden = true;
        try {
            const name = find('[data-worker-name]').value;
            const { value } = await request('/api/storage/worker-setting', { name });
            if (!modal.el.isConnected) return;
            try {
                await navigator.clipboard.writeText(value);
                Toast.success(`已复制 ${name}`);
            } catch {
                workerValue.value = value;
                workerValue.hidden = false;
                workerValue.focus();
                workerValue.select();
                Toast.info('请手动复制已选中的值');
            }
        } catch (error) {
            Toast.error(error.message);
        } finally {
            copy.disabled = false;
        }
    };

    try {
        saved = await request(CONFIG_ROUTE);
        if (!modal.el.isConnected) return;
        render();
        editor.hidden = false;
        ok.disabled = false;
    } catch (error) {
        status.textContent = error.message;
    }
}
