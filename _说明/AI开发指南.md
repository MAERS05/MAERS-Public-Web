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
-   **必须**使用 ES6 Modules (`import/export`)。
-   **必须**检查文件后缀，确认为 `.module.js`。
-   **必须**在修改 HTML 时检查是否破坏了关键渲染路径 (Flash Guard)。
-   **必须**使用 `fetch` 替代 XHR。
-   **必须**使用 `querySelector` 和 `addEventListener`。

### ❌ Don'ts (禁止做)
-   **禁止**写入 HTML 内联事件 (`onclick="..."`)。
-   **禁止**使用 `var` 声明变量（全部使用 `const/let`）。
-   **禁止**向全局 `window` 对象挂载新变量（除非是 Explicit Debugging Interface）。
-   **禁止**删除 `flash-guard.js` 的同步引用。

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

---

## 4. 修改现有代码

在修改现有文件前，务必先**阅读文件的头部注释**和**导入部分**，理解其依赖关系。
如果发现旧代码（如 `MAERS.xxx = ...`），请优先建议重构为 ES6 模块，而不是继续沿用旧模式（除非用户明确要求最小化修改）。
