# 开发工具与质量门禁

开发环境需要 Python 3.10+、Node.js 22 和 npm。后台运行本身使用的 Python 依赖仍由 `_studio/requirements.txt` 管理；测试和补丁构建依赖由本目录 `package-lock.json` 固定。

在项目根目录执行：

```bash
npm ci --prefix _studio/tooling
npx --prefix _studio/tooling playwright install chromium
git config core.hooksPath .githooks
python -B _studio/tests/run_tests.py
npm run test:e2e --prefix _studio/tooling
```

Windows PowerShell 若限制 npm 脚本执行，可使用 `npm.cmd` / `npx.cmd`。Linux 首次安装浏览器可加 `--with-deps`。浏览器配置使用 [Playwright webServer](https://playwright.dev/docs/test-webserver)，在临时目录中运行生产 HTTP 与路由逻辑，业务数据不会写入仓库。

## 提交与推送

本仓库是开源发布版本，每次更新必须保持现有版本号不变，遵守[STD-VER-01](../../_说明/开发规范.md#8-版本与离线缓存-ver)。以下版本递增行为是现有工具沿用的原项目逻辑，不适用于开源版维护：不要执行 `bump_versions.py` 或触发自动递增流程。现有自动化实现仍有递增逻辑；若 hook、后台提交或检查要求递增，应报告工具冲突，不得为通过检查修改版本号。

- `pre-commit` 根据暂存区的前端文件及 `HEAD` 中的版本，自动递增尚未递增的缓存版本键。同一分组一次只递增一次。普通文件的未暂存改动不会被加入提交；版本文件自身若部分暂存且需要递增，则中止并提示整理该文件。
- `pre-push` 要求待推送提交是当前 `HEAD`，且工作区干净，再执行完整 Python / Node 回归。这保证验证内容与推送内容一致；其他分支请先切换后推送。
- 管理门户 Git 按钮先准备版本号，再在独立进程执行只读门禁；任何门禁异常都会停止流程。
- 门户按后台进度显示准备、检查、本地提交、推送阶段；推送包含 `pre-push` 完整回归，最多等待 10 分钟。Git 超时会结束命令及其子进程；若传输期间超时，界面提示远端结果待确认，不会把已经保存的本地提交误报为丢失。关闭弹窗不会取消任务。
- 本地页面先检查 Git 进度接口版本；后台旧版或无响应时保持本地模式并停止提交，完整退出后台后重新打开即可加载新代码。状态与进度读取不等待文件写锁；任务运行时重新打开弹窗会恢复原进度。
- GitHub Actions 在 push / pull_request 时校验补丁产物、完整回归和浏览器用例。版本检查使用 PR 基准或推送前提交。工作流需推送到 GitHub 后才会运行；分支保护规则由仓库设置管理。
- `bump_versions.py` 会直接修改版本文件，并非只读预览；开源版更新不要运行该工具。测试需要 Node，缺失时明确失败。

## JavaScript 语法扫描

`js-analyze.mjs` 使用 [Acorn](https://github.com/acornjs/acorn) 解析声明、调用、导入和导出，按语法节点区分模板表达式、字符串、注释和正则字面量。Python 桥按进程批量缓存分析结果。常驻服务的测试门禁使用独立进程，防止复用旧源码缓存。

## Vditor 补丁

`vendor/vditor/` 保存 Vditor 3.10.6 发布包中的原始 index / method 脚本、许可证、来源与发布包 SHA-512。下载时已校验 npm 发布的完整性值。`patches.json` 另记录两份基准文件及被替换模块的 SHA-256。

`patches/` 是可读的模块工厂源码，承接原有定制：998 加载器、558 思维导图、593 Markmap 解析、570 Mermaid、572 Graphviz、169 Flowchart、379 ECharts、664 预览入口。保留 webpack 参数和内部模块编号以兼容固定版本；两份构建的局部符号不同，补丁分别记录。

558 按文字度量和各层子树边界生成 SVG，Mindmap 与 Markmap 共用此排版；缩放和平移复用阅读器的 SVG 视口，折叠时重新排布并固定被点击节点。导图回归使用真实浏览器检查文字框相交、节点和连线数量，以及缩放、折叠和全屏切换。

```bash
node _studio/tooling/vendor-build.mjs          # 重建两个浏览器产物
npm run vendor:check --prefix _studio/tooling # 只读核对源码与产物
```

只修改可读补丁，再重建 `plugins/vditor-assets/index.min.js` 和 `method.min.js`。产物头部标记生成来源；直接修改产物会导致门禁失败。升级 Vditor 时必须替换基准、重新核对模块编号和哈希，并运行导图运行时及浏览器测试；指纹变化不会静默套用补丁。

浏览器用例当前覆盖首页、阅读器双链、源码保存和更新日志编辑，运行桌面深浅色与手机视口。它们是核心流程回归，不代表所有页面和交互都已覆盖。

## 可访问性只读审计

本轮保留检查工具与规范，产品页面、CSS、图标和主题控件已恢复到审计前的版本。检测结果是待审查问题，不代表获准修改视觉；现有配色、字体、布局和控件外观的变更需用户明确授权。SVG 与内联样式迁移也必须保持原有视觉效果。

在项目根目录执行静态审计：

```bash
python -B _studio/tests/run_tests.py --a11y
```

浏览器审计由用户自行运行：

```bash
npm run audit:a11y --prefix _studio/tooling -- --headed --reporter=html
```

审计使用原有沙盒服务，在桌面深色、桌面浅色和手机浅色中扫描访客与管理页面；每页附带 JSON 问题报告。有待审查项时退出码非零，命令不会自动修改文件。axe 覆盖可编程检测的语义、ARIA、表单名称与对比度；键盘和读屏交互仍需按 STD-HTML-06 人工审查。功能回归 `test:e2e` 继续执行原有用例，独立审计不混入普通回归。
