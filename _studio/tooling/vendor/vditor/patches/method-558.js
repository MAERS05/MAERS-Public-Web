/** Vditor 558 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  n.d(t, { P: () => o, T: () => l, parseLinkedLabel: () => parseLinkedLabel });
  const { mindmapRenderAdapter } = n(781);
  let labelParser;
  function safeLinkHref(value) {
    const href = value.trim();
    if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
    try {
      // 使用固定基址验证协议，保留原始站内地址供阅读器处理。
      const { protocol } = new URL(href, "https://example.invalid/");
      return protocol === "http:" || protocol === "https:" ? href : null;
    } catch (_) {
      return null;
    }
  }

  function parseLinkedLabel(source) {
    if (!/https?:\/\/|\]\(/i.test(source) || typeof Lute === "undefined" || !Lute.New) return null;
    if (!labelParser) {
      labelParser = Lute.New();
      labelParser.SetSanitize(true);
      labelParser.SetGFMAutoLink(true);
    }
    const template = document.createElement("template");
    // 只从惰性模板提取纯文字与安全链接，保留节点的手动换行。
    template.innerHTML = labelParser.Md2HTML(source.replace(/<br\s*\/?\s*>|\\n|\r?\n/gi, "<br>")).trim();
    const links = new Map();
    for (const anchor of template.content.querySelectorAll("a[href]")) {
      const href = safeLinkHref(anchor.getAttribute("href"));
      if (href && anchor.textContent) links.set(anchor, href);
    }
    if (!links.size) return null;

    const parts = [];
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeType === 3 ? node.data : node.localName === "br" ? "\n" : "";
      if (!text) continue;
      const href = links.get(node.parentElement?.closest("a"));
      const previous = parts.at(-1);
      if (previous && previous.href === href) previous.text += text;
      else parts.push({ text, href });
    }
    return { name: parts.map(part => part.text).join(""), parts };
  }

  function parseMindmapInput(source, fallback, defaultDirection) {
    var options = { direction: defaultDirection || "LR" };
    if (!source) return { tree: fallback, options: options };
    var text = String(source);
    // 双向标记会在 frontmatter 前插入方向注释，读取配置时保留这些注释。
    var frontmatter = text.match(/^((?:(?:[ \t]*%%[^\r\n]*)?[ \t]*\r?\n)*)---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (frontmatter) {
      var fmDir = frontmatter[2].match(/^[ \t]*direction[ \t]*:[ \t]*(both|lr|tb)[ \t]*$/im);
      if (fmDir) options.direction = fmDir[1].toLowerCase() === "both" ? "both" : fmDir[1].toUpperCase();
      var fmDepth = frontmatter[2].match(/^[ \t]*initialTreeDepth[ \t]*:[ \t]*(-?\d+)[ \t]*(?:#.*)?$/m);
      if (fmDepth) options.initialDepth = Number(fmDepth[1]) < 0 ? Infinity : Number(fmDepth[1]);
      text = frontmatter[1] + text.slice(frontmatter[0].length);
    }
    var contentLines = [];
    var seenContent = false;
    text.split(/\r?\n/).forEach(function (line) {
      var commentDir = line.match(/^[ \t]*%%[ \t]*(?:direction[ \t]*:[ \t]*)?(both|lr|tb)[ \t]*$/i);
      if (commentDir) {
        options.direction = commentDir[1].toLowerCase() === "both" ? "both" : commentDir[1].toUpperCase();
        return;
      }
      if (/^[ \t]*%%/.test(line)) return;
      if (!seenContent) {
        var plainDir = line.match(/^[ \t]*direction[ \t]*:[ \t]*(both|lr|tb)[ \t]*$/i);
        if (plainDir) {
          options.direction = plainDir[1].toLowerCase() === "both" ? "both" : plainDir[1].toUpperCase();
          return;
        }
      }
      if (line.trim()) seenContent = true;
      contentLines.push(line);
    });
    if (typeof Lute === "undefined" || !Lute.EChartsMindmapStr)
      return { tree: fallback, options: options };
    // Lute 解析列表树时会忽略软硬换行与 <br>，先替换为临时标记再还原真实换行。
    var cleanSource = contentLines.join("\n");
    var marker = "\uE000MAERS_BREAK\uE001";
    while (cleanSource.indexOf(marker) !== -1) marker += "\uE001";
    var lines = cleanSource.replace(/<br\s*\/?\s*>|\\n/gi, marker).split(/\r?\n/);
    var joined = [];
    lines.forEach(function (line) {
      if (
        joined.length &&
        line.trim() &&
        joined[joined.length - 1].trim() &&
        !/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)
      ) {
        joined[joined.length - 1] =
          joined[joined.length - 1].replace(/(?:[ \t]+|\\)$/, "") +
          marker +
          line.trim();
      } else joined.push(line);
    });
    try {
      // Lute 的列表树只保留纯文字。先用标记保留有链接的节点标签，再还原到原有树结构。
      const linkedLabels = new Map();
      let linkSlot = "\uE000MAERS_LINK\uE001";
      while (cleanSource.includes(linkSlot)) linkSlot += "\uE001";
      const treeSource = joined.map(line => {
        const item = line.match(/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)(.*)$/);
        if (!item) return line;
        const label = parseLinkedLabel(item[2].split(marker).join("\n"));
        if (!label) return line;
        const slot = linkSlot + linkedLabels.size;
        linkedLabels.set(slot, label);
        return item[1] + slot;
      }).join("\n");
      var tree = JSON.parse(Lute.EChartsMindmapStr(treeSource));
      if (!tree || (!tree.name && !tree.children)) return { tree: fallback, options: options };
      var restore = function (node) {
        const name = String(node.name || "");
        const label = linkedLabels.get(name.trim());
        if (label) Object.assign(node, label);
        else node.name = name.split(marker).join("\n");
        (node.children || []).forEach(restore);
      };
      restore(tree);
      return { tree: tree, options: options };
    } catch (_) {
      return { tree: fallback, options: options };
    }
  }
  var l = function renderMindmapTree(e, theme, options = {}) {
    if (e.isConnected === false) return;
    const vertical = options.direction === "TB";
    const both = options.direction === "both";
    const root = e.__treeData;
    var dark = theme === "dark";
    var collapsed = new WeakSet(), records = new Map(), frame = 0;
    function initialState(node, depth) {
      const initiallyCollapsed = node.collapsed == null ? depth >= options.initialDepth : node.collapsed;
      if ((initiallyCollapsed && !options.expandedNodes?.has(node)) ||
          options.collapsedNodes?.has(node)) collapsed.add(node);
      (node.children || []).forEach(child => initialState(child, depth + 1));
    }
    initialState(root, 0);
    // 双向思维导图按子树权重均衡切分左右一级分支，并在收展交互中固定所属侧。
    const leftRoots = new Set();
    if (both && (root.children?.length || 0) > 1) {
      var weight = function (node) {
        var lineCount = Math.max(1, String(node.name || "").replace(/<br\s*\/?\s*>|\\n/gi, "\n").split("\n").length);
        var children = node.children || [];
        return children.length
          ? Math.max(lineCount, children.reduce(function (sum, child) { return sum + weight(child); }, 0))
          : lineCount;
      };
      var topChildren = root.children;
      var weights = topChildren.map(weight);
      var totalWeight = weights.reduce(function (sum, w) { return sum + w; }, 0);
      var bestSplit = Math.ceil(topChildren.length / 2), bestDiff = Infinity, accWeight = 0;
      for (var splitIdx = 1; splitIdx < topChildren.length; splitIdx++) {
        accWeight += weights[splitIdx - 1];
        var diff = Math.abs(accWeight * 2 - totalWeight);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestSplit = splitIdx;
        }
      }
      topChildren.slice(bestSplit).forEach(function (child) { leftRoots.add(child); });
    }
    // 双向根节点的初始收展应用到两侧，之后每侧独立切换。
    const collapsedSides = new Set();
    if (leftRoots.size && collapsed.delete(root)) {
      collapsedSides.add(-1);
      collapsedSides.add(1);
    }
    var offset = { x: 0, y: 0 };
    var canvas = document.createElement("canvas").getContext("2d");
    canvas.font = "13px sans-serif";
    function create(tag, attrs, text) {
      var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
      if (text != null) el.textContent = text;
      return el;
    }
    // 按实际文字宽度换行；文字、框和连线最终处于同一 SVG 坐标系。
    function wrap(node, limit) {
      const lines = [{ text: "", parts: [] }];
      let line = lines[0];
      for (const part of node.parts || [{ text: String(node.name || "") }]) {
        let fragment = null;
        for (const ch of part.text.replace(/<br\s*\/?\s*>|\\n/gi, "\n")) {
          if (ch === "\n" || (line.text && canvas.measureText(line.text + ch).width > limit)) {
            line = { text: "", parts: [] };
            lines.push(line);
            fragment = null;
            if (ch === "\n") continue;
          }
          if (!fragment) {
            fragment = { text: "", link: part.href ? part : null };
            line.parts.push(fragment);
          }
          fragment.text += ch;
          line.text += ch;
        }
      }
      return lines;
    }
    function hasTextSelection(element) {
      const selection = document.getSelection?.();
      return selection && !selection.isCollapsed &&
        (element.contains(selection.anchorNode) || element.contains(selection.focusNode));
    }
    function drawLabel(lines, x, y) {
      const text = create("text", { x: x, fill: dark ? "#f1f5f9" : "#1e293b",
        "dominant-baseline": "central", "data-mindmap-label": "true" });
      let activeLink = null, anchor = null;
      lines.forEach((line, row) => {
        line.parts.forEach((part, column) => {
          if (activeLink !== part.link) {
            activeLink = part.link;
            anchor = null;
            if (activeLink) {
              const attrs = { href: activeLink.href, fill: dark ? "#38bdf8" : "#0369a1",
                tabindex: "0", "data-mindmap-link": "true" };
              if (/^(?:https?:|\/\/)/i.test(activeLink.href)) Object.assign(attrs, { target: "_blank", rel: "noopener noreferrer" });
              const link = create("a", attrs);
              link.addEventListener("click", event => {
                if (event.detail && hasTextSelection(link)) event.preventDefault();
              });
              text.appendChild(link);
              anchor = link;
            }
          }
          const position = column === 0 ? { x: x, y: y + row * 22 } : {};
          (anchor || text).appendChild(create("tspan", position, part.text));
        });
      });
      return text;
    }
    var svg = create("svg", { width: "100%", height: "100%", "data-mindmap": "true",
      "data-mindmap-direction": both ? "both" : vertical ? "TB" : "LR",
      role: "group", "aria-label": vertical ? "组织架构图" : "思维导图", "font-family": "sans-serif", "font-size": "13", "font-weight": "400", "letter-spacing": "normal",
      "preserveAspectRatio": "xMidYMid meet" });
    e.__diagramChart?.dispose();
    delete e.__diagramChart;
    e.replaceChildren(svg);
    e.style.height = "420px";
    function render(anchor, focusSide = 0) {
      cancelAnimationFrame(frame);
      var limit = Math.max(80, Math.min(208, Math.round((e.clientWidth || 800) * 0.26)));
      var widths = [], leftWidths = [], nodes = [];
      // 子树只在同一层的边界相遇时让开，避免逐棵累加整块子树高度。
      function stack(children) {
        var contour = [];
        children.forEach(function (child, index) {
          if (index) child.shift = Math.max.apply(null, child.contour.map(function (range, level) {
            return contour[level] ? contour[level][1] + (vertical ? 24 : 10) - range[0] : 0;
          }));
          child.contour.forEach(function (range, level) {
            var min = range[0] + child.shift, max = range[1] + child.shift;
            contour[level] = contour[level] ? [Math.min(contour[level][0], min), Math.max(contour[level][1], max)] : [min, max];
          });
        });
        var center = children.length ? (children[0].shift + children[children.length - 1].shift) / 2 : 0;
        children.forEach(function (child) { child.shift -= center; });
        return contour.map(function (range) { return [range[0] - center, range[1] - center]; });
      }
      function measure(node, depth, ancestors, side) {
        var lines = wrap(node, limit);
        var width = Math.max.apply(null, lines.map(function (line) { return canvas.measureText(line.text).width; })) + 20;
        var height = lines.length * 22 + 6;
        var sideWidths = side < 0 ? leftWidths : widths;
        sideWidths[depth] = Math.max(sideWidths[depth] || 0, vertical ? height : width);
        const breadth = vertical ? width : height;
        var item = { node: node, depth: depth, side: side, width: width, height: height, lines: lines,
          path: ancestors.concat(node.name || ""), shift: 0, contour: [[-breadth / 2, breadth / 2]] };
        item.children = [];
        if (!collapsed.has(node)) {
          for (const child of node.children || []) {
            const childSide = depth === 0 && both ? (leftRoots.has(child) ? -1 : 1) : side;
            if (depth === 0 && collapsedSides.has(childSide)) continue;
            item.children.push(measure(child, depth + 1, item.path, childSide));
          }
        }
        if (depth === 0 && both) {
          stack(item.children.filter(function (child) { return child.side > 0; }));
          stack(item.children.filter(function (child) { return child.side < 0; }));
        } else {
          stack(item.children).forEach(function (range) { item.contour.push(range); });
        }
        nodes.push(item);
        return item;
      }
      var tree = measure(root, 0, [], both ? 0 : 1);
      var columns = [both ? tree.width / 2 + 6 : 0], leftColumns = [-(tree.width / 2 + 6)];
      for (var depth = 1; depth < widths.length; depth++)
        columns[depth] = columns[depth - 1] + widths[depth] + 48;
      for (var leftDepth = 1; leftDepth < leftWidths.length; leftDepth++)
        leftColumns[leftDepth] = leftColumns[leftDepth - 1] - leftWidths[leftDepth] - 48;
      function place(item, y) {
        item.x = vertical ? y : item.side === 0 ? 0 : (item.side < 0 ? leftColumns : columns)[item.depth];
        item.y = vertical ? columns[item.depth] : y;
        item.children.forEach(function (child) { place(child, y + child.shift); });
      }
      place(tree, 0);
      var previous = anchor && records.get(anchor)?.point;
      var current = anchor && nodes.find(function (item) { return item.node === anchor; });
      if (previous && current) {
        offset.x = previous.x - current.x;
        offset.y = previous.y - current.y;
      }
      var focusTarget;
      var scene = create("g");
      var duration = anchor && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 260 : 0;
      var origin = previous || { x: tree.x + offset.x, y: tree.y + offset.y };
      var originPoint = function (side) {
        return both && (!anchor || anchor === tree.node) && side
          ? { x: origin.x + side * (tree.width / 2 + 6), y: origin.y }
          : origin;
      };
      records.forEach(function (record) {
        record.leaving = true;
        record.target = originPoint(record.side);
      });
      nodes.forEach(function (item) {
        var target = { x: item.x + offset.x, y: item.y + offset.y };
        var levelWidth = (item.side < 0 ? leftWidths : widths)[item.depth] || 0;
        var record = records.get(item.node);
        if (!record) {
          var startPoint = originPoint(item.side);
          record = { point: duration ? { x: startPoint.x, y: startPoint.y } : target, scale: duration ? 0 : 1,
            bend: levelWidth + 6, side: item.side };
          records.set(item.node, record);
        }
        record.target = target;
        record.leaving = false;
        record.width = item.width;
        record.height = item.height;
        record.side = item.side;
        record.targetBend = levelWidth + 6;
        item.children.forEach(function (child) {
          var childRecord = records.get(child.node);
          if (childRecord) childRecord.parent = item.node;
        });
        var group = create("g", { transform: "translate(" + item.x + " " + item.y + ")", "data-mindmap-node": "true",
          "data-mindmap-side": item.side < 0 ? "left" : item.side === 0 ? "center" : "right" });
        group.appendChild(create("title", {}, item.path.filter(Boolean).join(",")));
        const boxX = vertical || item.side === 0 ? -item.width / 2 : item.side < 0 ? 6 : -item.width - 6;
        const boxY = vertical ? -item.height - 6 : -item.height / 2;
        group.appendChild(create("rect", { x: boxX, y: boxY, width: item.width, height: item.height,
          rx: "6", fill: dark ? "rgba(30,41,59,0.92)" : "#f8fafc", stroke: dark ? "rgba(148,163,184,0.28)" : "#cbd5e1", "stroke-width": "1" }));
        group.appendChild(drawLabel(item.lines, boxX + 10, boxY + 14));
        if (item.node.children?.length) {
          const sides = item.side === 0 && leftRoots.size ? [-1, 1] : [0];
          for (const side of sides) {
            const state = side ? collapsedSides : collapsed;
            const key = side || item.node;
            const expanded = !state.has(key);
            const cx = item.side === 0 ? (side || 1) * (item.width / 2 + 6) : 0;
            const control = side ? create("g", { "data-mindmap-toggle": side < 0 ? "left" : "right" }) : group;
            if (side) {
              // 保持圆点大小，扩大点击和轻触的命中区域。
              control.appendChild(create("rect", { x: cx - 8, y: -8, width: 16, height: 16, fill: "transparent" }));
              group.appendChild(control);
            }
            const accent = dark ? "#38bdf8" : "#0284c7";
            control.appendChild(create("circle", { cx: cx, r: "3.5",
              fill: expanded ? (dark ? "#1e293b" : "#ffffff") : accent, stroke: accent, "stroke-width": "1.5" }));
            control.setAttribute("role", "button");
            control.setAttribute("tabindex", "0");
            control.setAttribute("aria-label", side ? (side < 0 ? "左侧分支" : "右侧分支") : String(item.node.name || "节点"));
            control.setAttribute("aria-expanded", String(expanded));
            control.style.cursor = "pointer";

            function toggle(event) {
              event.preventDefault();
              event.stopPropagation();
              if (state.has(key)) state.delete(key); else state.add(key);
              const focused = document.activeElement === control;
              const target = render(item.node, side);
              if (focused) target?.focus({ preventScroll: true });
            }
            control.addEventListener("click", event => {
              if (!side && (event.target.closest("a") || hasTextSelection(group) ||
                  (event.pointerType !== "touch" && event.target.closest("[data-mindmap-label]")))) return;
              toggle(event);
            });
            control.addEventListener("keydown", event => {
              if (event.target === control && (event.key === "Enter" || event.key === " ")) toggle(event);
            });
            if (item.node === anchor && side === focusSide) focusTarget = control;
          }
        }
        record.element = group;
      });
      // 分支整体缩放，不叠加半透明文字；连线每帧跟随实际端点。
      records.forEach(function (record) {
        record.start = { x: record.point.x, y: record.point.y, scale: record.scale, bend: record.bend };
        record.element.style.pointerEvents = record.leaving ? "none" : "";
        if (record.parent) {
          if (!record.edge) record.edge = create("path", { fill: "none",
            stroke: dark ? "rgba(148,163,184,0.45)" : "#94a3b8", "stroke-width": "1.5" });
          scene.appendChild(record.edge);
        }
      });
      records.forEach(function (record) { scene.appendChild(record.element); });
      svg.replaceChildren(scene);
      function draw(progress) {
        records.forEach(function (record) {
          var from = record.start, to = record.target;
          record.point = { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
          record.scale = from.scale + ((record.leaving ? 0 : 1) - from.scale) * progress;
          record.bend = from.bend + ((record.targetBend ?? from.bend) - from.bend) * progress;
          record.element.setAttribute("transform", "translate(" + record.point.x + " " + record.point.y + ") scale(" + record.scale + ")");
        });
        records.forEach(function (record, node) {
          var parent = records.get(record.parent);
          if (record.edge && parent) {
            var a = parent.point, b = record.point;
            if (vertical) {
              const endY = b.y - (record.height + 6) * record.scale;
              const forkY = (a.y + b.y - record.bend * record.scale) / 2;
              record.edge.setAttribute("d", "M" + a.x + "," + a.y + " V" + forkY + " H" + b.x + " V" + endY);
            } else {
              var dir = record.side < 0 ? -1 : 1;
              var startX = a.x + (parent.side === 0 ? dir * (parent.width / 2 + 6) * parent.scale : 0);
              var bend = b.x - dir * record.bend * record.scale;
              var end = b.x - dir * (record.width + 6) * record.scale;
              var mid = (startX + bend) / 2;
              record.edge.setAttribute("d", "M" + startX + "," + a.y + " C" + mid + "," + a.y + " " + mid + "," + b.y + " " + bend + "," + b.y + " L" + end + "," + b.y);
            }
          }
          if (progress === 1 && record.leaving) {
            record.element.remove(); record.edge?.remove(); records.delete(node);
          }
        });
      }
      draw(duration ? 0 : 1);
      if (duration) {
        svg.setAttribute("data-mindmap-animating", "true");
        var started = performance.now();
        frame = requestAnimationFrame(function tick(now) {
          if (!svg.isConnected) return;
          var progress = Math.min(1, (now - started) / duration);
          draw(1 - Math.pow(1 - progress, 3));
          if (progress < 1) frame = requestAnimationFrame(tick);
          else { frame = 0; svg.removeAttribute("data-mindmap-animating"); }
        });
      } else svg.removeAttribute("data-mindmap-animating");
      // 首次适配整张图；后续折叠继续沿用阅读器保存的缩放和平移视口。
      if (!svg.__cmsPanZoomBound) {
        var minX = Math.min.apply(null, nodes.map(function (item) {
          return item.x + (vertical || item.side === 0 ? -item.width / 2 - (both ? 11 : 0) : item.side < 0 ? -5 : -item.width - 6);
        })) + offset.x - 16;
        var maxX = Math.max.apply(null, nodes.map(function (item) {
          return item.x + (vertical || item.side === 0 ? item.width / 2 + (both ? 11 : 0) : item.side < 0 ? item.width + 6 : 5);
        })) + offset.x + 16;
        var minY = Math.min.apply(null, nodes.map(function (item) { return item.y - (vertical ? item.height + 6 : item.height / 2); })) + offset.y - 16;
        var maxY = Math.max.apply(null, nodes.map(function (item) { return item.y + (vertical ? 5 : item.height / 2); })) + offset.y + 16;
        svg.setAttribute("viewBox", [minX, minY, maxX - minX, maxY - minY].join(" "));
      }
      return focusTarget;
    }
    e.__renderTree = render;
    render();
    if (window.__mountDiagramFsBtn) window.__mountDiagramFsBtn(e);
  };
  const o = function (container = document, _cdn, theme) {
    container.querySelectorAll(".language-mindmap, code.language-mindmap-both").forEach(element => {
      if (!element.parentElement || element.getAttribute("data-processed") === "true" ||
          element.parentElement.matches(".vditor-wysiwyg__pre, .vditor-ir__marker--pre")) return;
      const code = mindmapRenderAdapter.getCode(element);
      const source = element.textContent.trim();
      if (!code && !source) return;
      let target = element;
      try {
        const parsed = parseMindmapInput(element.textContent, code ? JSON.parse(decodeURIComponent(code)) : {},
          element.classList.contains("language-mindmap-both") ? "both" : undefined);
        if (element.nodeName === "CODE") {
          target = document.createElement("div");
          target.className = "language-mindmap language-mindmap-both";
          target.style.height = "420px";
          target.style.overflow = "hidden";
          (element.closest("pre") || element).replaceWith(target);
        }
        target.__treeData = parsed.tree;
        target.setAttribute("data-processed", "true");
        target.setAttribute("data-diagram-sig", "mindmap:" + (source || code));
        l(target, theme, parsed.options);
      } catch (error) {
        target.className = "vditor-reset--error";
        target.textContent = "mindmap render error: " + error.message;
      }
    });
  };
};
