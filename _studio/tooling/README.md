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

## 本地开源组件

PhotoSwipe 5 和 CodeMirror 6 的具体版本由 `package-lock.json` 固定，不使用运行时 CDN。`vendor/ui/editor.mjs` 是 CodeMirror 构建入口；`ui-vendor-build.mjs` 生成 `plugins/ui-components/` 下的 ESM、PhotoSwipe 样式和许可证。生成文件不可手改。

```bash
npm.cmd run vendor:build --prefix _studio/tooling
npm.cmd run vendor:check --prefix _studio/tooling
node --test _studio/tooling/tests/ui-components.test.mjs
```

源码抽屉首次展开才加载 CodeMirror；阅读预览仍使用 Vditor。图库灯箱使用 PhotoSwipe，保留 Pre/Ori 切换。CMS 与图库排序继续使用原有的多选、点击落点和保存/取消流程，不引入拖拽排序组件。CMS 保留原生的选中项目拖入文件夹、面包屑移出及悬停导航。

本地图库经本机 HTTP 服务直接读取 `photos/`，线上继续使用公开媒体域名，私密媒体仍沿用鉴权地址。画质切换立即显示加载状态，成功后才改变 Pre/Ori；失败保留当前图并可重试，切图和关闭会取消旧任务，旧错误不再通知。灯箱从缩略图展开，关闭时缩回当前图片，无有效缩略图时淡出；底部预留名称、序号和切图按钮，手机也显示前后按钮。关闭动画结束前保持页面滚动锁定，期间隐藏全局主题按钮并排除页面缩放点击处理。

正文与图片均从 Git 排除，静态构建只使用目录 JSON。全文搜索及 Pagefind 已移除，保留标题、拼音匹配和标签筛选。

组件验证只检查非界面的源码模型、标题筛选、异步代次和资源释放；浏览器、视觉及手势体验由用户自行查看。

## 提交与推送

- `pre-commit` 根据暂存区的前端文件及 `HEAD` 中的版本，自动递增尚未递增的缓存版本键。同一分组一次只递增一次。普通文件的未暂存改动不会被加入提交；版本文件自身若部分暂存且需要递增，则中止并提示整理该文件。
- `pre-push` 要求待推送提交是当前 `HEAD`，且工作区干净，并核对本地正文与上次完整同步记录的路径、哈希、公私归属和存储目标，再执行完整 Python / Node 回归；测试结束后复查正文，防止外部编辑器在测试期间修改未被 Git 跟踪的文件。未同步、失败、缺失或旧版同步记录都会阻止推送，请先在本机后台执行“提交并推送”。该检查只读本机记录，不联网补传；其他分支请先切换后推送。
- 管理门户 Git 按钮先准备版本号，再在独立进程执行只读门禁；任何门禁异常都会停止流程。
- 门户按后台进度显示准备、检查、本地提交、推送阶段；推送包含 `pre-push` 完整回归，最多等待 10 分钟。Git 超时会结束命令及其子进程；若传输期间超时，界面提示远端结果待确认，不会把已经保存的本地提交误报为丢失。关闭弹窗不会取消任务。
- 本地页面先检查 Git 进度接口版本；后台旧版或无响应时保持本地模式并停止提交，完整退出后台后重新打开即可加载新代码。状态与进度读取不等待文件写锁；任务运行时重新打开弹窗会恢复原进度。
- GitHub Actions 在 push / pull_request 时校验补丁产物、完整回归和浏览器用例。版本检查使用 PR 基准或推送前提交。工作流需推送到 GitHub 后才会运行；分支保护规则由仓库设置管理。
- 本地可手动预览版本更新：`python -B _studio/tools/bump_versions.py`。测试需要 Node，缺失时明确失败。

## JavaScript 语法扫描

`js-analyze.mjs` 使用 [Acorn](https://github.com/acornjs/acorn) 解析声明、调用、导入和导出，按语法节点区分模板表达式、字符串、注释和正则字面量。Python 桥按进程批量缓存分析结果。常驻服务的测试门禁使用独立进程，防止复用旧源码缓存。

## 桌面启动与退出

修改启动器源码后执行 `python -B _studio/tools/build_desktop_app.py --skip-icon --no-desktop` 更新项目中的 `Maersy.exe`。启动器静默等待恢复和索引重建完成；无论服务是新启动还是已存在，均由一个命名互斥体选出的守护者接管窗口生命周期。关窗通过本机鉴权接口请求退出，并静默等待已接收的写入和后台迁移完成。退出前核对服务会话，旧窗口不关闭重启后的新服务；Chrome/Edge 共享的浏览器进程不作为关窗依据。运行日志位于 `_studio/.local/studio.log`。

## Vditor 补丁

`vendor/vditor/` 保存 Vditor 3.10.6 的原始纯预览脚本 `method.min.js`、许可证、来源与发布包 SHA-512。`patches.json` 记录基准文件及被替换模块的 SHA-256。

`patches/` 包含加载器及图表的可读模块工厂。独立的 `method-preview-content.js` 补丁在预览刷新时按源码和主题复用 Mindmap、Markmap、Mermaid、ECharts、Flowchart 与 Graphviz 节点。Graphviz 工作线程在完成、失败或正文移除时释放；未完成的旧渲染不能写回新正文。

558 按文字度量和各层子树边界生成 SVG，Mindmap 与 Markmap 共用此排版；缩放和平移复用阅读器的 SVG 视口，折叠时重新排布并固定被点击节点。导图回归使用真实浏览器检查文字框相交、节点和连线数量，以及缩放、折叠和全屏切换。

```bash
node _studio/tooling/vendor-build.mjs          # 重建纯预览脚本
npm run vendor:check --prefix _studio/tooling # 只读核对源码与产物
```

修改可读补丁后重建 `plugins/vditor-assets/method.min.js`。门禁会核对源码和生成产物。升级 Vditor 时，替换基准，核对模块编号、哈希和预览入口，再运行导图运行时及浏览器测试。

浏览器用例按职责组织：`e2e/site.spec.mjs` 覆盖页面、阅读器、同步和后台核心流程，`e2e/diagrams.spec.mjs` 独立验证导图几何与手势，`e2e/album.spec.mjs` 检查分类保存失败重试、读取异常和新增时保留未保存编辑。它们共用 `e2e/fixtures.mjs`，逐例重置沙盒并预置主题，运行桌面深浅色与手机视口。核心流程回归不代表所有页面和交互都已覆盖。

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

## 公开版本维护

本仓库采用固定版本约定。运行完整测试和供应商产物检查时沿用当前版本号，避免执行 bump_versions.py 或会自动递增版本的 pre-commit hook。

    npm ci --prefix _studio/tooling
    npm run vendor:check --prefix _studio/tooling
    python -B _studio/tests/run_tests.py

Windows 可执行 python -B _studio/tools/build_desktop_app.py --skip-icon 重建项目目录中的可移植启动器。只有显式传入 --install-desktop 才复制到系统桌面。

浏览器集成测试的 CI 使用 Windows runner，覆盖真实 DPAPI 本机免密登记；测试服务复用正式页面路由，并将正文、JSON 与图片请求隔离到临时目录。
