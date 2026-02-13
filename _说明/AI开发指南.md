# MAERS AI 辅助开发指南

本文档即是为人类开发者准备的，也是为 AI 助手（如你）准备的。请严格遵守以下规则。

---

## 📋 目录 (Table of Contents)

- [1. 角色认知](#1-角色认知)
- [2. 关键守则 (Do's & Don'ts)](#2-关键守则-dos--donts)
- [3. 代码生成规范](#3-代码生成规范)
- [4. 修改现有代码](#4-修改现有代码)

---

## 1. 角色认知

你正在维护的是一个**高度原生化**、**模块化**且**极其注重性能**的 Web 项目。
-   不要试图引入 React/Vue/jQuery。
-   不要引入 Webpack/Vite/Babel。
-   尊重现有的 HTML/CSS/JS 架构。

---

## 2. 关键守则 (Do's & Don'ts)

### ✅ Do's (必须做)
-   **必须**阅读文件功能说明书。
-   **必须**使用 ES6 Modules (`import/export`)。
-   **必须**检查文件后缀，确认为 `.module.js`。
-   **必须**遵循“基础设施扁平化”原则：共享 UI 逻辑置于 `shared/`，通用管理中台置于 `data-manage/`。
-   **必须**在修改 HTML 时检查是否破坏了关键渲染路径 (Flash Guard 路径为 `shared/flash-guard.js`)。
-   **必须**在修改后端 Python 服务时，使用标准化的**双语日志格式**进行回显：`print(f"  [ MODULE ] 图标 描述 | Description")`。
-   **必须**在实现复杂子管理模块时（如 CMS 标签），使用 `autoSaveBar: false` 将保存条控制权移交给中央调度器，避免 UI 冲突。
-   **必须**使用 `fetch` 替代 XHR。
-   **必须**使用 `querySelector` 和 `addEventListener`。
-   **必须**通过 `shared/namespace.module.js` 统一管理全局命名空间初始化，严禁散落挂载。
-   **必须**使用 `shared/templates.module.js` 构建复杂 DOM，替代 `innerHTML` 拼接，以防止 XSS 和提升可读性。
-   **必须**在复用 CMS 适配器（如 Photos Viewer, Space Viewer）时，**显式设定** `{ initialState: { IS_ADMIN: false } }`，防止管理 UI 泄露。
-   **必须**确保在 CMS 模块中执行增删改操作时，同步执行 `_studio/services/cms.py` 中的物理文件操作逻辑（如创建 `.md`、同步重命名）。
-   **必须**在查询 CMS 内容时，首先检查 `content` 字段是否以 `.md` 结尾。如果是，前端必须执行异步 `fetch` 获取内容，而不是直接使用数据库字段。
-   **必须**严格遵守 `data/<module>/<filename>.md` 的物理存放规则，禁止跨模块混放。
-   **必须**通过 `/api/cms/get_categories?module=xxx` 和 `/api/cms/save_categories` 接口管理标签分类，严禁试图在 `nodes` 表中查找 `_TAG_CONFIG` 节点。
-   **必须**在执行“出厂重置”或“清空数据”逻辑时，确保 `data/tags/` 目录下的 JSON 配置文件也被同步重置，并保持目录树 JSON 的 `{"root": []}` 初始结构。
-   **必须**使用 `loading="lazy"` 属性替代 `InteractionObserver` 方案来实现图片懒加载。
-   **必须**遵循 ADR-032 命名规范创建标签配置文件：`cms-{module}-tag-categories.json`。

### ❌ Don'ts (禁止做)
-   **禁止**写入 HTML 内联事件 (`onclick="..."`)。
-   **禁止**使用 `var` 声明变量（全部使用 `const/let`）。
-   **禁止**向全局 `window` 对象挂载新变量（除非是 Explicit Debugging Interface）。
-   **禁止**删除 `shared/flash-guard.js` 的同步引用。
-   **禁止**在业务模块的主 CSS 文件中编写 `max-width` 媒体查询（必须去 `zmobile adaptation` 目录）。
-   **禁止**滥用 `!important`。**尽量**通过 CSS 权重管理（如 `body` 前缀策略）解决冲突，仅在覆盖行内样式或第三方库强样式等必要场景下使用。
-   **禁止**保留“僵尸代码”或无用注释。修改功能时，**必须删除**旧逻辑，绝不允许采取“保留旧代码但在下方通过新代码覆盖”的增量式写法。
-   **禁止**编写无意义的占位代码（如无效的 `0` 或 `none`）。每一行代码都必须有明确的运行时价值。
-   **禁止**随意猜测！不清楚就自己找具体文件或问我！。
---

## 3. 代码生成规范

### 3.1 模块模板
生成新 JS 模块时，请遵循以下模板：

```javascript
/**
 * @module custom/example/example.module.js
 * @description 简要描述模块功能
 */

import { api } from '../../data-manage/api-client.module.js';

// 私有常量
const DEFAULT_CONFIG = { ... };

// 导出函数
export function init() {
    const el = document.querySelector('#example');
    if (el) {
        bindEvents(el);
    }
}

// 私有函数
function bindEvents(el) {
    el.addEventListener('click', () => { ... });
}
```

### 3.2 CSS 模板
```css
/* custom/example/viewer/example.css */
.example-container {
    /* 使用全局变量 */
    background-color: var(--card-bg);
    border: 1px solid var(--card-border);
}
```

### 3.3 移动端适配 CSS 模板
任何移动端 (`@media`) 样式**必须**写在 `custom/zmobile adaptation/` 对应的文件中。
**关键规则**：必须在模块的主 CSS 文件头部使用 `@import` 引入适配文件，**禁止**在 HTML 中直接使用 `<link>` 标签引入。

```css
/* custom/example/viewer/example.css - 头两行 */
@import "../../zmobile adaptation/mobile-example.css";

.example-container { ... }
```

```css
/* custom/zmobile adaptation/mobile-example.css */
/* 必须加 body 前缀提升权重 */
body .example-container {
    flex-direction: column;
}
```

---

## 4. 修改现有代码

在修改现有文件前，务必先**阅读文件的头部注释**和**导入部分**，理解其依赖关系。
如果发现旧代码（如 `MAERS.xxx = ...`），请优先建议重构为 ES6 模块，而不是继续沿用旧模式（除非用户明确要求最小化修改）。
