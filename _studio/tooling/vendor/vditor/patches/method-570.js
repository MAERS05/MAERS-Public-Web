/** Mermaid 预览：纯树形组织架构复用定制导图，其余图形沿用原生渲染。 */
(e, t, n) => {
  n.d(t, { i: () => render });
  const adapters = n(781);
  const loader = n(998);
  const defaults = n(793);
  const ids = n(446);
  const renderTree = n(558).T;

  function organizationTree(diagram, source) {
    if (!/^flowchart/.test(diagram.type) ||
        !["TB", "TD"].includes(diagram.db.getDirection()) ||
        diagram.db.getSubGraphs().length ||
        /^\s*(?:style|classDef|class|click|linkStyle)\s/m.test(source)) return null;
    const vertices = Object.values(diagram.db.getVertices());
    const edges = diagram.db.getEdges();
    if (vertices.length < 2 || edges.length !== vertices.length - 1 ||
        vertices.some(vertex => vertex.type !== "square" || vertex.styles.length || vertex.classes.length ||
          /<(?!br\s*\/?\s*>)/i.test(vertex.text)) ||
        edges.some(edge => edge.text || edge.stroke !== "normal" ||
          !["arrow_point", "arrow_open"].includes(edge.type))) return null;
    const nodes = new Map(vertices.map(vertex => [vertex.id, { name: vertex.text, children: [] }]));
    const parents = new Set();
    for (const edge of edges) {
      if (!nodes.has(edge.start) || !nodes.has(edge.end) || parents.has(edge.end)) return null;
      parents.add(edge.end);
      nodes.get(edge.start).children.push(nodes.get(edge.end));
    }
    const roots = vertices.filter(vertex => !parents.has(vertex.id));
    if (roots.length !== 1) return null;
    const root = nodes.get(roots[0].id);
    const visited = new Set();
    const pending = [root];
    while (pending.length) {
      const node = pending.pop();
      if (visited.has(node)) return null;
      visited.add(node);
      pending.push(...node.children);
    }
    return visited.size === nodes.size ? root : null;
  }

  // 先按层数建立初始状态，再应用指定分支；路径可省略根节点，重名时须写完整路径。
  function organizationOptions(tree, source) {
    const options = { direction: "TB", initialDepth: 1, expandedNodes: new WeakSet(), collapsedNodes: new WeakSet() };
    const branches = [];
    const overrides = [];
    function collect(node, ancestors) {
      const path = ancestors.concat(node);
      branches.push({ node, path });
      node.children.forEach(child => collect(child, path));
    }
    collect(tree, []);
    for (const match of source.matchAll(/^[ \t]*%%[ \t]+(expand-all|expand-depth|expand-to|expand|collapse)(?:[ \t]*:[ \t]*([^\r\n]*))?[ \t]*$/gm)) {
      const command = match[1], value = (match[2] || "").trim();
      if (command === "expand-all") {
        options.initialDepth = Infinity;
      } else if (command === "expand-depth") {
        if (!/^(?:-1|\d+)$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw Error("展开层数须为非负整数或 -1（全部展开）");
        options.initialDepth = value === "-1" ? Infinity : Number(value);
      } else overrides.push({ command, value });
    }
    for (const { command, value } of overrides) {
      const matches = branches.filter(({ node, path }) =>
        node.name === value || path.map(item => item.name).join("/") === value ||
        path.slice(1).map(item => item.name).join("/") === value);
      if (matches.length !== 1) throw Error(matches.length
        ? `分支名称「${value}」重复，请用 / 分隔的完整路径`
        : `没有找到分支「${value}」，请检查节点名称或路径`);
      const { node, path } = matches[0];
      if (command === "collapse") options.collapsedNodes.add(node);
      else {
        path.forEach(item => options.expandedNodes.add(item));
        if (command === "expand-to") options.collapsedNodes.add(node);
      }
    }
    return options;
  }

  function render(container, cdn = defaults.g.CDN, theme) {
    const diagrams = adapters.mermaidRenderAdapter.getElements(container);
    if (!diagrams.length) return;
    let runtime;
    let chain = Promise.resolve();
    const prepare = () => runtime ??= loader.G(cdn + "/dist/js/mermaid/mermaid.min.js", "vditorMermaidScript").then(() => {
          // 与思维导图统一节点与连线配色；保留各图的语义形状。
          var dark = "dark" === theme,
            fill = dark ? "#1e293b" : "#f8fafc",
            border = dark ? "#475569" : "#cbd5e1",
            text = dark ? "#f1f5f9" : "#1e293b",
            line = dark ? "#64748b" : "#94a3b8",
            background = dark ? "#0f131a" : "#ffffff";
          var e = {
            theme: "base",
            themeVariables: {
              darkMode: dark, background: background, fontFamily: "sans-serif", fontSize: "16px",
              primaryColor: fill, primaryBorderColor: border, primaryTextColor: text,
              secondaryColor: fill, secondaryBorderColor: border, secondaryTextColor: text,
              tertiaryColor: fill, tertiaryBorderColor: border, tertiaryTextColor: text,
              lineColor: line, defaultLinkColor: line, textColor: text,
              mainBkg: fill, nodeBorder: border, clusterBkg: background, clusterBorder: border,
              titleColor: text, edgeLabelBackground: background,
              actorBkg: fill, actorBorder: border, actorTextColor: text, actorLineColor: line,
              signalColor: line, signalTextColor: text,
              labelBoxBkgColor: fill, labelBoxBorderColor: border, labelTextColor: text,
              noteBkgColor: fill, noteBorderColor: border, noteTextColor: text,
              activationBkgColor: fill, activationBorderColor: border,
              attributeBackgroundColorOdd: fill, attributeBackgroundColorEven: background,
              xyChart: { backgroundColor: background, plotColorPalette: dark ? "#38bdf8,#f59e0b,#34d399,#a78bfa" : "#0284c7,#f59e0b,#10b981,#6366f1" },
            },

            securityLevel: "loose",
            altFontFamily: "sans-serif",
            fontFamily: "sans-serif",
            startOnLoad: !1,
            flowchart: { htmlLabels: !0, useMaxWidth: !0 },
            sequence: {
              useMaxWidth: !0,
              diagramMarginX: 8,
              diagramMarginY: 8,
              boxMargin: 8,
              showSequenceNumbers: !0,
            },
            gantt: { leftPadding: 75, rightPadding: 20 },
          };
          // 饼图与甘特图沿用内置分类、任务和状态配色。
          mermaid.initialize({ theme: dark ? "dark" : "default", startOnLoad: !1 });
          var chartTheme = mermaid.mermaidAPI.getConfig().themeVariables;
          Object.keys(chartTheme).forEach(function (key) {
            if (/^(pie\d+|(?:task|activeTask|doneTask|crit|section|altSection|excludeBkg|grid|todayLine).*)$/.test(key)) e.themeVariables[key] = chartTheme[key];
          });
      mermaid.initialize(e);
    });
    loader.D(container, diagrams, element => {
      chain = chain.catch(() => {}).then(async () => {
        if (element.isConnected === false) return;
        await prepare();
        if (element.isConnected === false || element.getAttribute("data-processed") === "true") return;
        const source = adapters.mermaidRenderAdapter.getCode(element).trim();
        if (!source) return;
        const id = "mermaid" + ids.Wb();
        try {
          if (/^\s*sankey-beta\b/m.test(source)) {
            const rules = (await mermaid.mermaidAPI.getDiagramFromText("sankey-beta\na,b,1")).parser?.parser?.lexer?.rules;
            if (rules) {
              rules[5] = /^(?:([\u0020-\u0021\u0023-\u002B\u002D-\uFFFF])*)/;
              rules[7] = /^(?:(([\u0020-\u0021\u0023-\u002B\u002D-\uFFFF])|(\u002C)|(\u000D)|(\u000A)|(\u0022)(\u0022))*)/;
            }
          }
          const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
          if (element.isConnected === false) return;
          const tree = organizationTree(diagram, source);
          if (tree) {
            element.__treeData = tree;
            renderTree(element, theme, organizationOptions(tree, source));
          } else {
            const result = await mermaid.render(id, /^\s*classDiagram(?:-v2)?\b/m.test(source)
              ? '%%{init: {"flowchart": {"htmlLabels": false}}}%%\n' + source : source);
            if (element.isConnected === false) return;
            element.innerHTML = result.svg;
            result.bindFunctions?.(element);
          }
          element.setAttribute("data-diagram-sig", "mermaid:" + source);
          element.setAttribute("data-processed", "true");
          window.__mountDiagramFsBtn?.(element);
        } catch (error) {
          document.getElementById(id)?.remove();
          element.textContent = "mermaid render error: " + error.message;
        }
      });
      return chain;
    });
  }
};
