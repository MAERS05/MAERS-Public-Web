/**
 * @version 1.0.0
 */
/** 共用管理按钮：明确的图标、中文名称与原生键盘操作。 */
import { icon } from '../../shared/icons.module.js';
export const AdminButtonHelper = {
    styleInjected: false,
    injectStyles() {
        if (this.styleInjected) return;
        const style = document.createElement('style');
        style.textContent = '.maers-admin-action-group{display:flex;align-items:center;gap:3px}.maers-admin-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:6px;min-height:30px;border:0;border-radius:7px;background:transparent;color:var(--text-sub);cursor:pointer}.maers-admin-btn:hover{color:var(--accent);background:var(--accent-soft)}.maers-admin-btn>svg,.maers-admin-btn>img{pointer-events:none}.maers-admin-btn.btn-delete-active{color:var(--accent)}.item-actions{display:flex}.list-item:hover .arrow-icon{opacity:0}';
        document.head.append(style);
        this.styleInjected = true;
    },
    render(options) {
        this.injectStyles();
        const { onSort, onEdit, onAddTag, onDelete, isDeleted, extraClass = '', containerClass = '' } = options;
        const group = document.createElement('div');
        group.className = 'maers-admin-action-group ' + containerClass;
        const add = (name, label, handler, className = '') => {
            if (!handler) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'maers-admin-btn ' + className;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.innerHTML = icon(name, 17);
            button.addEventListener('click', handler);
            group.append(button);
        };
        add('more', '选择并调整顺序', onSort, extraClass);
        add('edit', '编辑', onEdit);
        add('tag', '添加标签', onAddTag);
        add(isDeleted ? 'refresh' : 'trash', isDeleted ? '恢复' : '删除', onDelete, isDeleted ? 'btn-delete-active' : '');
        return group;
    }
};
