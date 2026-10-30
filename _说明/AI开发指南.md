# MAERS AI 辅助开发指南

本文档面向 AI 编程助手与人类开发者，说明在 MAERS 中**如何开展工作**。具体规则（代码怎么写、文件怎么建）只在 [开发规范](开发规范.md) 中定义，本文通过规则编号引用。

---

## 📋 目录 (Table of Contents)

- [1. 项目定性](#1-项目定性)
- [2. 标准工作流](#2-标准工作流)
- [3. 必读文档索引](#3-必读文档索引)
- [4. 高频要点速查](#4-高频要点速查)
- [5. 常见误区（已废弃的写法）](#5-常见误区已废弃的写法)
- [6. 内部链接与跨模块跳转](#6-内部链接与跨模块跳转)
- [7. 自检清单](#7-自检清单)

---

## 1. 项目定性

MAERS 是一个**原生化、模块化、高内聚低耦合**的 Web + 原生桌面双模系统：

- 访客端：纯静态部署（GitHub Pages / Vercel / Cloudflare），读取 `data/*.json` 快照与 `.md` 正文。
- 管理端：由 `Maersy.exe` 拉起本地 Python 后端 `_studio/server.py`，负责物理文件、SQLite、图像流水线与同步。
- 不引入任何前端框架（React / Vue / jQuery）或打包工具（Webpack / Vite / Babel），使用浏览器原生 ES Modules。
- 代码注释与技术交流一律使用中文。
- 本仓库是开源发布版本，每次更新保持现有版本号不变，遵守 STD-VER-01；原项目的自动递增流程不适用于本仓库。
- 处于内测阶段，**不保留兼容旧版的包袱**。能彻底重构就重构，删除旧逻辑，不做“新旧并存”。

---

## 2. 标准工作流

```mermaid
flowchart LR
    A["阅读规范与文件说明"] --> B["定位模块与依赖链"]
    B --> C["实现修改"]
    C --> D["运行全量测试"]
    D -->|失败| C
    D -->|通过| E["保持版本号 / 更新文档"]
    E --> F["总结与后续建议"]
```

1. **阅读**：先读 [开发规范](开发规范.md) 与 [文件功能说明](文件功能说明.md)，确认模块位置与职责。不要凭空猜测路径或接口名，不确定时检索代码库或向用户确认。
2. **定位**：查看目标文件的 `import` / `export` 依赖链，以及它是否被其他模块复用（CMS 组件被 Photos / Space 通过适配器复用）。
3. **实现**：遵守规范编号对应的规则。新文件按 [开发规范 §1.1](开发规范.md#11-新文件放在哪里) 选择位置。
4. **验证**：运行 `python -B _studio/tests/run_tests.py`，必须全部通过。规范类失败的信息会带上规则编号（如 `[STD-JS-02]`），按编号查阅开发规范修复。
5. **收尾**：
   - 保持所有现有版本号不变（STD-VER-01）。旧版工具若提示递增，报告规则冲突，不得为通过检查改版本号。
   - 新增或删除访客端静态文件时，同步维护 `offline-download.js` 的 `FRAMEWORK`（STD-VER-02）。
   - 更新文档（STD-DOC-02）。
   - 如果偿还了技术债，执行 `--shrink-baseline`。
6. **汇报**：简洁说明改动、验证结果与可选的后续优化，主动提出值得深入的问题。

---

## 3. 必读文档索引

| 文档 | 用途 |
| :--- | :--- |
| [开发规范](开发规范.md) | 强制规则（唯一来源）与自动化检查方式 |
| [文件功能说明](文件功能说明.md) | 每个文件的职责与位置 |
| [前端开发指南](前端开发指南.md) | 前端分层、关键渲染路径、加密 / 同步门面、样式体系 |
| [后端开发指南](后端开发指南.md) | `_studio/` 分层、完整 API 表、日志与运维 |
| [架构决策记录](架构决策记录.md) | 关键取舍的背景与理由（ADR） |
| [细节设计说明](细节设计说明.md) | 具体机制的实现细节 |

---

## 4. 高频要点速查

| 场景 | 要点 | 规则 |
| :--- | :--- | :--- |
| 新建 JS 文件 | kebab-case + `.module.js`，文件头写 `/** */` 中文职责注释 | STD-FILE-01/02, STD-JS-05 |
| 声明变量 | 只用 `const` / `let` | STD-JS-02 |
| 用户提示 | `window.MAERS.Toast` 或 `admin-modal`，禁止 `alert()` | STD-JS-04 |
| 全局变量 | `window.MAERS` 只允许 `Toast` / `Theme` / `ModuleConfig` / `Config` | STD-ARCH-01 |
| 加密 / 解密 | 只经由 `data-manage/encrypt/` 门面，业务代码禁止 `crypto.subtle` | STD-ARCH-02 |
| 云同步 | 只经由 `data-manage/sync/sync-manager.module.js` 门面 | STD-ARCH-03 |
| 访客端复用 CMS 适配器 | `{ initialState: { IS_ADMIN: false } }` | STD-ARCH-04 |
| 子管理器保存条 | `autoSaveBar: false`，交给中央调度 | STD-ARCH-06 |
| 移动端样式 | 写入 `custom/zmobile adaptation/`，由主 CSS 顶部 `@import` | STD-CSS-01 |
| 浅色模式 | 新组件必须同时适配 `html.light-mode` | STD-CSS-03 |
| HTML 头部 | `config.js` → `flash-guard.js`（同步）→ 样式 → 入口模块 | STD-HTML-01/03 |
| 后端日志 | `print(f"  [ MODULE ] 图标 中文 \| English")` | STD-PY-03 |
| 后端异常 | 禁止裸 `except:` | STD-PY-02 |
| CMS 数据写入 | 只走 `POST /api/cms/node?action=...` | STD-DATA-03 |
| 每次更新后 | 保持所有现有版本号不变，不运行自动递增工具 | STD-VER-01 |
| 桌面启动器 | 修改 `_studio/tools/build_desktop_app.py` 后执行该脚本重新生成 `Maersy.exe` | — |

---

## 5. 常见误区（已废弃的写法）

| 误区 | 现状 |
| :--- | :--- |
| 在 CMS 中 `new Vditor(...)` 做所见即所得编辑 | CMS 已是**纯阅读器**（`cms-reader.module.js` v4），用 `Vditor.preview` 渲染，引擎缺失时通过 `textContent` 显示纯文本；正文可在源码抽屉保存，或通过 `open_external` 调用本地 Typora / Obsidian 编辑，窗口回焦后自动热刷新 |
| 调用 `/api/cms/tree`、`/api/cms/upload_cover`、`/api/cms/upload_attachment` | 这些接口不存在。读取用 `GET /api/cms/fetch?module=`，写入用 `POST /api/cms/node?module=&action=` |
| 引用 `shared/crypto.module.js`、`shared/sync-manager.module.js` 等 | 加密模块位于 `data-manage/encrypt/`，同步模块位于 `data-manage/sync/`，管理中台位于 `data-manage/admin/` |
| 读写 `data/keyring.json` | 密钥环文件为 `data/crypto-keyring.json` |
| 运行 `_studio/tools/run_tests.py` | 测试入口为 `_studio/tests/run_tests.py` |
| 引用 `shared/namespace.module.js`、`shared/templates.module.js`、`clean-data.py`、`install_deps.py`、`.bat` 脚本 | 均已删除，test_01 会拦截残留引用 |

---

## 6. 内部链接与跨模块跳转

### 6.1 同模块内链
阅读器的 `_interceptMdLinks(container, currentNode)`（[`cms-reader.module.js`](../custom/cms/viewer/cms-reader.module.js)）会拦截 `.md` 相对链接，在页内无刷新打开目标笔记。支持两种写法：

```markdown
[另一篇笔记](另一篇笔记.md)
[[另一篇笔记]]
[[另一篇笔记|显示文字]]
```

- 链接 `href` 必须以 `.md` 结尾，且不以 `http` 或 `/` 开头。
- `[[双链]]` 在预处理阶段转换为 `.cms-wikilink` 链接。被引用笔记的反向链接由 `cms-backlinks.module.js` 展示。

### 6.2 跨模块深度链接（`?openNote=`）

```markdown
[黑神话：悟空](/games.html?openNote=黑神话：悟空)
[《北欧神话》](/literature.html?openNote=《北欧神话》)
[后台查看](/admin-cms.html?module=games&openNote=黑神话：悟空)
```

- 已支持 `notes`、`literature`、`games`、`videos`、`record` 的访客入口与管理入口（test_04 校验）。
- `openNote` 的值必须与节点 `title` **完全一致**，包括书名号等标点。

### 6.3 新增 CMS 子模块的接入

新模块的 `main.module.js` 在初始化完成后，必须响应 `openNote` 参数：

```javascript
// 响应 URL 中的 ?openNote=标题，自动打开目标文章
const openNoteTitle = new URLSearchParams(window.location.search).get('openNote');
if (openNoteTitle && Controller?.AppState?.allNodes) {
    const targetNode = Controller.AppState.allNodes.find(n => n.type === 'note' && n.title === openNoteTitle);
    if (targetNode && Editor) setTimeout(() => Editor.open(targetNode), 100);
}
```

---

## 7. 自检清单

提交答复前逐项确认：

- [ ] 全量测试通过，没有新增技术债（test_09 绿灯）。
- [ ] 所有现有版本号保持原值，访客端文件增删已同步 `FRAMEWORK`。
- [ ] 新代码有中文文件头注释，没有僵尸代码，也没有 `console.log` / `alert` / `var`。
- [ ] 动态内容写入 `innerHTML` 前已转义，新组件已适配浅色模式。
- [ ] 文件增删与接口变化已同步到文档。
