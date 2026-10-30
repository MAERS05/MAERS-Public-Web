/** Vditor 558 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  "use strict";
  n.d(t, { P: () => a, T: () => l });
  var r = n(793),
    i = n(998),
    o = n(781);
  function restoreMindmapBreaks(source, fallback) {
    if (!source || typeof Lute === "undefined" || !Lute.EChartsMindmapStr)
      return fallback;
    // Lute omits soft/hard breaks and <br> when building tree names. Keep a
    // temporary text marker through its list parser, then restore actual breaks.
    var marker = "\uE000MAERS_BREAK\uE001";
    while (source.indexOf(marker) !== -1) marker += "\uE001";
    var lines = source.replace(/<br\s*\/?\s*>|\\n/gi, marker).split(/\r?\n/);
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
      var tree = JSON.parse(Lute.EChartsMindmapStr(joined.join("\n")));
      if (!tree || (!tree.name && !tree.children)) return fallback;
      var restore = function (node) {
        node.name = String(node.name || "")
          .split(marker)
          .join("\n");
        (node.children || []).forEach(restore);
      };
      restore(tree);
      return tree;
    } catch (_) {
      return fallback;
    }
  }
  var l = function renderMindmapTree(e, theme) {
    if (e.isConnected === false) return;
    var dark = theme === "dark";
    var collapsed = new WeakSet(), records = new Map(), frame = 0;
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
    function wrap(name, limit) {
      var lines = [];
      String(name || "").replace(/<br\s*\/?\s*>|\\n/gi, "\n").split("\n").forEach(function (line) {
        var current = "";
        Array.from(line).forEach(function (ch) {
          if (current && canvas.measureText(current + ch).width > limit) {
            lines.push(current);
            current = "";
          }
          current += ch;
        });
        lines.push(current);
      });
      return lines;
    }
    var svg = create("svg", { width: "100%", height: "100%", "data-mindmap": "true",
      role: "group", "aria-label": "思维导图", "font-family": "sans-serif", "font-size": "13", "font-weight": "400", "letter-spacing": "normal",
      "preserveAspectRatio": "xMidYMid meet" });
    e.__diagramChart?.dispose();
    delete e.__diagramChart;
    e.replaceChildren(svg);
    e.style.height = "420px";
    function render(anchor) {
      cancelAnimationFrame(frame);
      var limit = Math.max(80, Math.min(208, Math.round((e.clientWidth || 800) * 0.26)));
      var widths = [], nodes = [];
      // 子树只在同一层的边界相遇时让开，避免逐棵累加整块子树高度。
      function measure(node, depth, ancestors) {
        var lines = wrap(node.name, limit);
        var width = Math.max.apply(null, lines.map(function (line) { return canvas.measureText(line).width; })) + 20;
        var height = lines.length * 22 + 6;
        widths[depth] = Math.max(widths[depth] || 0, width);
        var item = { node: node, depth: depth, width: width, height: height, lines: lines,
          path: ancestors.concat(node.name || ""), shift: 0, contour: [[-height / 2, height / 2]] };
        item.children = collapsed.has(node) ? [] : (node.children || []).map(function (child) {
          return measure(child, depth + 1, item.path);
        });
        var contour = [];
        item.children.forEach(function (child, index) {
          if (index) child.shift = Math.max.apply(null, child.contour.map(function (range, level) {
            return contour[level] ? contour[level][1] + 10 - range[0] : 0;
          }));
          child.contour.forEach(function (range, level) {
            var min = range[0] + child.shift, max = range[1] + child.shift;
            contour[level] = contour[level] ? [Math.min(contour[level][0], min), Math.max(contour[level][1], max)] : [min, max];
          });
        });
        var center = item.children.length ? (item.children[0].shift + item.children[item.children.length - 1].shift) / 2 : 0;
        item.children.forEach(function (child) { child.shift -= center; });
        contour.forEach(function (range) { item.contour.push([range[0] - center, range[1] - center]); });
        nodes.push(item);
        return item;
      }
      var tree = measure(e.__treeData, 0, []), columns = [0];
      for (var depth = 1; depth < widths.length; depth++)
        columns[depth] = columns[depth - 1] + widths[depth] + 48;
      function place(item, y) {
        item.x = columns[item.depth]; item.y = y;
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
      records.forEach(function (record) {
        record.leaving = true;
        record.target = origin;
      });
      nodes.forEach(function (item) {
        var target = { x: item.x + offset.x, y: item.y + offset.y };
        var record = records.get(item.node);
        if (!record) {
          record = { point: duration ? { x: origin.x, y: origin.y } : target, scale: duration ? 0 : 1,
            bend: widths[item.depth] + 6 };
          records.set(item.node, record);
        }
        record.target = target;
        record.leaving = false;
        record.width = item.width;
        record.targetBend = widths[item.depth] + 6;
        item.children.forEach(function (child) {
          var childRecord = records.get(child.node);
          if (childRecord) childRecord.parent = item.node;
        });
        var group = create("g", { transform: "translate(" + item.x + " " + item.y + ")", "data-mindmap-node": "true" });
        group.appendChild(create("title", {}, item.path.filter(Boolean).join(",")));
        group.appendChild(create("rect", { x: -item.width - 6, y: -item.height / 2, width: item.width, height: item.height,
          rx: "6", fill: dark ? "rgba(30,41,59,0.92)" : "#f8fafc", stroke: dark ? "rgba(148,163,184,0.28)" : "#cbd5e1", "stroke-width": "1" }));
        var text = create("text", { x: -item.width + 4, fill: dark ? "#f1f5f9" : "#1e293b", "dominant-baseline": "central" });
        item.lines.forEach(function (line, i) {
          text.appendChild(create("tspan", { x: -item.width + 4, y: -item.height / 2 + 14 + i * 22 }, line));
        });
        group.appendChild(text);
        if (item.node.children?.length) {
          group.setAttribute("role", "button"); group.setAttribute("tabindex", "0");
          group.setAttribute("aria-label", String(item.node.name || "节点"));
          group.setAttribute("aria-expanded", String(!collapsed.has(item.node)));
          group.style.cursor = "pointer";
          group.appendChild(create("circle", { r: "3.5", fill: collapsed.has(item.node) ? (dark ? "#38bdf8" : "#0284c7") : (dark ? "#1e293b" : "#ffffff"),
            stroke: dark ? "#38bdf8" : "#0284c7", "stroke-width": "1.5" }));
          function toggle(event) {
            event.preventDefault(); event.stopPropagation();
            if (collapsed.has(item.node)) collapsed.delete(item.node); else collapsed.add(item.node);
            var focused = document.activeElement === group;
            var target = render(item.node);
            if (focused && target) target.focus({ preventScroll: true });
          }
          group.addEventListener("click", toggle);
          group.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") toggle(event); });
        }
        record.element = group;
        if (item.node === anchor) focusTarget = group;
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
            var bend = b.x - record.bend * record.scale;
            var end = b.x - (record.width + 6) * record.scale;
            var mid = (a.x + bend) / 2;
            record.edge.setAttribute("d", "M" + a.x + "," + a.y + " C" + mid + "," + a.y + " " + mid + "," + b.y + " " + bend + "," + b.y + " L" + end + "," + b.y);
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
        var minX = Math.min.apply(null, nodes.map(function (item) { return item.x - item.width - 6; })) + offset.x - 16;
        var maxX = Math.max.apply(null, nodes.map(function (item) { return item.x + 5; })) + offset.x + 16;
        var minY = Math.min.apply(null, nodes.map(function (item) { return item.y - item.height / 2; })) + offset.y - 16;
        var maxY = Math.max.apply(null, nodes.map(function (item) { return item.y + item.height / 2; })) + offset.y + 16;
        svg.setAttribute("viewBox", [minX, minY, maxX - minX, maxY - minY].join(" "));
      }
      return focusTarget;
    }
    e.__renderTree = render;
    render();
    if (window.__mountDiagramFsBtn) window.__mountDiagramFsBtn(e);
  };
  var a = function (e, t, n) {
    (void 0 === e && (e = document), void 0 === t && (t = r.g.CDN));
    var a = o.mindmapRenderAdapter.getElements(e);
    a.length > 0 &&
      (0, i.G)(
        "".concat(t, "/dist/js/echarts/echarts.min.js?v=5.5.1"),
        "vditorEchartsScript",
      ).then(function () {
        a.forEach(function (e) {
          if (
            !e.parentElement.classList.contains("vditor-wysiwyg__pre") &&
            !e.parentElement.classList.contains("vditor-ir__marker--pre")
          ) {
            var t = o.mindmapRenderAdapter.getCode(e);
            if (t)
              try {
                if ("true" === e.getAttribute("data-processed")) return;
                ((e.__treeData = restoreMindmapBreaks(
                  e.textContent,
                  JSON.parse(decodeURIComponent(t)),
                )),
                  e.setAttribute("data-processed", "true"),
                  e.setAttribute("data-diagram-sig", "mindmap:" + t),
                  l(e, n));
              } catch (t) {
                ((e.className = "vditor-reset--error"),
                  (e.innerHTML = "mindmap render error: <br>".concat(t)));
              }
          }
        });
      });
  };
};
