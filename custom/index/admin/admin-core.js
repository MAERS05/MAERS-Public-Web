/**
 * MAERS Admin Core (admin-core.js)
 * Admin 面板核心逻辑
 * 依赖: MAERS.Toast
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};

    const grid = document.getElementById('admin-grid');

    async function loadModules() {
        try {
            const res = await fetch('/api/modules');
            const modules = res.ok ? await res.json() : [];
            render(modules);
        } catch (e) {
            console.error('加载模块失败:', e);
            render([]);
        }
    }

    function render(list) {
        grid.innerHTML = '';
        list.forEach((mod, idx) => {
            const a = document.createElement('a');
            a.className = 'admin-card';
            a.href = mod.url;
            a.innerHTML = `<span class="icon">${mod.icon}</span><span class="name">${mod.title}</span>`;

            const del = document.createElement('div');
            del.className = 'delete-mod';
            del.innerHTML = '×';
            del.onclick = (e) => { e.preventDefault(); removeModule(idx); };
            a.appendChild(del);

            grid.appendChild(a);
        });

        const addCard = document.createElement('div');
        addCard.className = 'admin-card functional-card';
        addCard.style.cursor = 'pointer';
        addCard.onclick = addNewModule;
        addCard.innerHTML = `<span class="icon">＋</span><span class="name">ADD_NEW_MODULE</span>`;
        grid.appendChild(addCard);
    }

    async function addNewModule() {
        const title = prompt("模块名称:");
        if (!title) return;
        const icon = prompt("图标 (Emoji):", "📦");
        const url = prompt("目标链接:", "index.html");

        try {
            const res = await fetch('/api/modules');
            const list = await res.json();
            list.push({ title, icon, url });

            const saveRes = await fetch('/api/save_modules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(list)
            });

            if (saveRes.ok) {
                MAERS.Toast && MAERS.Toast.success('✅ 模块添加成功');
                loadModules();
            } else {
                MAERS.Toast && MAERS.Toast.error('❌ 保存失败');
            }
        } catch (e) {
            MAERS.Toast && MAERS.Toast.error('❌ 添加失败: ' + e.message);
        }
    }

    async function removeModule(index) {
        if (!confirm("确定删除该模块？")) return;
        try {
            const res = await fetch('/api/modules');
            const list = await res.json();
            list.splice(index, 1);
            await fetch('/api/save_modules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(list)
            });
            loadModules();
        } catch (e) {
            MAERS.Toast && MAERS.Toast.error('删除失败: ' + e.message);
        }
    }

    async function exportModules() {
        try {
            const res = await fetch('/api/modules');
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `modules_backup_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            MAERS.Toast && MAERS.Toast.success('✅ 配置已导出');
        } catch (e) {
            MAERS.Toast && MAERS.Toast.error('❌ 导出失败: ' + e.message);
        }
    }

    async function importModules(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            if (!Array.isArray(data)) {
                alert('❌ 文件格式错误: 必须是数组格式');
                return;
            }

            for (let mod of data) {
                if (!mod.title || !mod.icon || !mod.url) {
                    alert('❌ 文件格式错误: 每个模块必须包含 title, icon, url 字段');
                    return;
                }
            }

            const res = await fetch('/api/save_modules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (res.ok) {
                MAERS.Toast && MAERS.Toast.success(`✅ 成功导入 ${data.length} 个模块`);
                loadModules();
            } else {
                MAERS.Toast && MAERS.Toast.error('❌ 保存失败');
            }
        } catch (e) {
            MAERS.Toast && MAERS.Toast.error('❌ 导入失败: ' + e.message);
        } finally {
            event.target.value = '';
        }
    }

    // Mount to namespace
    MAERS.Admin = {
        loadModules,
        render,
        addNewModule,
        removeModule,
        exportModules,
        importModules
    };

    // Event Binding
    document.addEventListener('DOMContentLoaded', () => {
        const exportBtn = document.getElementById('export-btn');
        const importBtn = document.getElementById('import-btn');
        const importFile = document.getElementById('import-file');

        if (exportBtn) {
            exportBtn.addEventListener('click', () => MAERS.Admin.exportModules());
            // Hover effects (simulated with CSS usually, but JS here for parity with original)
            exportBtn.addEventListener('mouseover', function() {
                this.style.background = '#78ffd6';
                this.style.color = '#000';
            });
            exportBtn.addEventListener('mouseout', function() {
                this.style.background = 'rgba(120, 255, 214, 0.1)';
                this.style.color = '#78ffd6';
            });
        }

        if (importBtn) {
            importBtn.addEventListener('click', () => {
                if (importFile) importFile.click();
            });
            importBtn.addEventListener('mouseover', function() {
                this.style.background = '#ff6b6b';
                this.style.color = '#fff';
            });
            importBtn.addEventListener('mouseout', function() {
                this.style.background = 'rgba(255, 107, 107, 0.1)';
                this.style.color = '#ff6b6b';
            });
        }

        if (importFile) {
            importFile.addEventListener('change', (e) => MAERS.Admin.importModules(e));
        }

        // Add New Module card binding (in render function)
    });

    // Initialize
    loadModules();

})(typeof window !== 'undefined' ? window : this);
