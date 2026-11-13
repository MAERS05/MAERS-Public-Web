/** Vditor 379 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  n.d(t, { p: () => l });
  const installedLayouts = new WeakSet();

  // 与 Mermaid 一样，以被收展的节点固定布局和相机，分支向该节点聚拢。
  function anchorTreeToggle(series, model, api, payload) {
    if (payload?.type !== "treeExpandAndCollapse" || !Number.isInteger(payload.dataIndex) ||
        !model.queryComponents({ mainType: "series", subType: "tree", query: payload }).includes(series)) return;
    const view = api.getViewOfSeriesModel(series);
    const graphic = view?._data?.getItemGraphicEl(payload.dataIndex);
    const camera = graphic?.parent?.getComputedTransform();
    const data = series.getData(), target = data.getItemLayout(payload.dataIndex);
    const previousBounds = series.coordinateSystem?.getBoundingRect();
    if (!camera || !target || !previousBounds) return;
    const zoom = Math.hypot(camera[0], camera[1]);
    if (!(zoom > 0)) return;
    const dx = graphic.x - target.x, dy = graphic.y - target.y;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    data.each(index => {
      const point = data.getItemLayout(index);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const x = point.x + dx, y = point.y + dy;
      data.setItemLayout(index, { x, y }, true);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    // TreeView reuses the previous extent on a degenerate axis (e.g. only root).
    const centerX = maxX > minX ? (minX + maxX) / 2 : previousBounds.x + previousBounds.width / 2;
    const centerY = maxY > minY ? (minY + maxY) / 2 : previousBounds.y + previousBounds.height / 2;
    const origin = series.layoutInfo;
    series.setZoom(zoom);
    series.setCenter([origin.x + (centerX - camera[4]) / zoom,
      origin.y + (centerY - camera[5]) / zoom]);
  }

  // 等 ECharts 解析各节点的尺寸后，用标签边界同时决定框体和布局。
  function installTreeSpacing(engine) {
    if (installedLayouts.has(engine)) return;
    installedLayouts.add(engine);
    engine.registerLayout(engine.PRIORITY.VISUAL.POST_CHART_LAYOUT, (model, api, payload) => {
      model.eachSeriesByType("tree", series => {
        if (series.get("layout") === "radial" ||
            !["rect", "roundRect"].includes(series.get("symbol")) ||
            series.get(["label", "position"]) !== "inside") return;
        const direction = series.getOrient();
        const vertical = direction === "TB" || direction === "BT";
        const levels = [];
        const data = series.getData();
        const root = data.tree.root.children[0];
        if (!root) return;
        function measure(node, depth) {
          const index = node.dataIndex;
          const symbolSize = data.getItemVisual(index, "symbolSize");
          const size = Array.isArray(symbolSize) ? symbolSize : [symbolSize, symbolSize];
          const baseWidth = Number(size[0]) || 0;
          const baseHeight = Number(size[1]) || 0;
          const label = node.getModel().getModel("label");
          const style = {
            ...engine.helper.createTextStyle(label, { state: "normal" }),
            text: series.getFormattedLabel(index) ?? node.name,
          };
          const text = new engine.graphic.Text({ style }).getBoundingRect();
          const width = Math.max(baseWidth, text.width + 16);
          const height = Math.max(baseHeight, text.height + 12);
          if ((width > baseWidth || height > baseHeight) && label.get("position") === "inside" &&
              label.get("show") !== false && ["rect", "roundRect"].includes(data.getItemVisual(index, "symbol"))) {
            data.setItemVisual(index, "symbolSize", [width, height]);
          }
          const breadth = vertical ? width : height;
          levels[depth] = Math.max(levels[depth] || 0, vertical ? height : width);
          const item = { node, depth, shift: 0, contour: [[-breadth / 2, breadth / 2]] };
          item.children = node.isExpand ? node.children.map(child => measure(child, depth + 1)) : [];
          const contour = [];
          item.children.forEach((child, index) => {
            if (index) child.shift = Math.max(...child.contour.map((range, level) =>
              contour[level] ? contour[level][1] + 24 - range[0] : 0));
            child.contour.forEach((range, level) => {
              const min = range[0] + child.shift, max = range[1] + child.shift;
              contour[level] = contour[level] ? [Math.min(contour[level][0], min), Math.max(contour[level][1], max)] : [min, max];
            });
          });
          const center = item.children.length ? (item.children[0].shift + item.children.at(-1).shift) / 2 : 0;
          item.children.forEach(child => { child.shift -= center; });
          contour.forEach(range => item.contour.push([range[0] - center, range[1] - center]));
          return item;
        }
        const tree = measure(root, 0);
        const depths = [levels[0] / 2];
        for (let depth = 1; depth < levels.length; depth++) {
          depths[depth] = depths[depth - 1] + levels[depth - 1] / 2 + 56 + levels[depth] / 2;
        }
        const box = series.layoutInfo;
        const reverse = direction === "BT" || direction === "RL";
        function place(item, cross) {
          const along = reverse ? (vertical ? box.height : box.width) - depths[item.depth] : depths[item.depth];
          item.node.setLayout(vertical ? { x: box.width / 2 + cross, y: along } :
            { x: along, y: box.height / 2 + cross }, true);
          item.children.forEach(child => place(child, cross + child.shift));
        }
        place(tree, 0);
        anchorTreeToggle(series, model, api, payload);
      });
    });
  }

  // ECharts 默认让标签保持屏幕字号；矩形树须与节点一起缩放，避免缩小后文字溢出，同时为收起节点自适应着色。
  function syncTreeLabels(chart) {
    if (!chart || chart.isDisposed()) return;
    const dark = Boolean(chart.__maersDark);
    chart.getModel().eachSeriesByType("tree", series => {
      if (series.get("layout") === "radial" ||
          !["rect", "roundRect"].includes(series.get("symbol")) ||
          series.get(["label", "position"]) !== "inside") return;
      const zoom = series.coordinateSystem?.getZoom() || 1;
      const factor = Math.max(0.05, (zoom - 1) * series.get("nodeScaleRatio") + 1);
      const data = series.getData();
      data.eachItemGraphicEl((graphic, index) => {
        const shape = graphic.childAt(0);
        const text = shape?.getTextContent();
        if (!shape || !text) return;
        const node = data.tree?.getNodeByDataIndex(index);
        const collapsed = Boolean(node?.children?.length && !node.isExpand);
        // 仅叠加收起高亮；展开时由 ECharts 重绘恢复已解析的颜色，保留 inherit / auto 等配置语义。
        if (collapsed) {
          const fill = dark ? "#0c4a6e" : "#e0f2fe";
          const stroke = dark ? "#38bdf8" : "#0284c7";
          if (shape.style.fill !== fill || shape.style.stroke !== stroke) {
            shape.setStyle({ fill, stroke });
          }
          const textFill = dark ? "#7dd3fc" : "#0369a1";
          if (text.style.fill !== textFill) {
            text.setStyle({ fill: textFill });
          }
        }
        const label = data.getItemModel(index).getModel("label");
        const fontSize = (Number(label.get("fontSize")) || 12) * factor;
        if (Math.abs((Number(text.style.fontSize) || 0) - fontSize) < 0.001) return;
        const style = { fontSize, font: null };
        for (const key of ["width", "height", "lineHeight"]) {
          const value = label.get(key);
          if (typeof value === "number") style[key] = value * factor;
        }
        const padding = label.get("padding");
        if (padding != null) style.padding = Array.isArray(padding)
          ? padding.map(value => value * factor) : padding * factor;
        text.setStyle(style);
      });
    });
  }
  var r = n(793),
    a = n(998),
    i = n(781),
    o = n(446),
    c = function (e, t, n, r) {
      return new (n || (n = Promise))(function (a, i) {
        function o(e) {
          try {
            s(r.next(e));
          } catch (e) {
            i(e);
          }
        }
        function c(e) {
          try {
            s(r.throw(e));
          } catch (e) {
            i(e);
          }
        }
        function s(e) {
          var t;
          e.done
            ? a(e.value)
            : ((t = e.value),
              t instanceof n
                ? t
                : new n(function (e) {
                    e(t);
                  })).then(o, c);
        }
        s((r = r.apply(e, t || [])).next());
      });
    },
    s = function (e, t) {
      var n,
        r,
        a,
        i,
        o = {
          label: 0,
          sent: function () {
            if (1 & a[0]) throw a[1];
            return a[1];
          },
          trys: [],
          ops: [],
        };
      return (
        (i = { next: c(0), throw: c(1), return: c(2) }),
        "function" == typeof Symbol &&
          (i[Symbol.iterator] = function () {
            return this;
          }),
        i
      );
      function c(c) {
        return function (s) {
          return (function (c) {
            if (n) throw new TypeError("Generator is already executing.");
            for (; i && ((i = 0), c[0] && (o = 0)), o;)
              try {
                if (
                  ((n = 1),
                  r &&
                    (a =
                      2 & c[0]
                        ? r.return
                        : c[0]
                          ? r.throw || ((a = r.return) && a.call(r), 0)
                          : r.next) &&
                    !(a = a.call(r, c[1])).done)
                )
                  return a;
                switch (((r = 0), a && (c = [2 & c[0], a.value]), c[0])) {
                  case 0:
                  case 1:
                    a = c;
                    break;
                  case 4:
                    return (o.label++, { value: c[1], done: !1 });
                  case 5:
                    (o.label++, (r = c[1]), (c = [0]));
                    continue;
                  case 7:
                    ((c = o.ops.pop()), o.trys.pop());
                    continue;
                  default:
                    if (
                      !((a = o.trys),
                      (a = a.length > 0 && a[a.length - 1]) ||
                        (6 !== c[0] && 2 !== c[0]))
                    ) {
                      o = 0;
                      continue;
                    }
                    if (3 === c[0] && (!a || (c[1] > a[0] && c[1] < a[3]))) {
                      o.label = c[1];
                      break;
                    }
                    if (6 === c[0] && o.label < a[1]) {
                      ((o.label = a[1]), (a = c));
                      break;
                    }
                    if (a && o.label < a[2]) {
                      ((o.label = a[2]), o.ops.push(c));
                      break;
                    }
                    (a[2] && o.ops.pop(), o.trys.pop());
                    continue;
                }
                c = t.call(e, o);
              } catch (e) {
                ((c = [6, e]), (r = 0));
              } finally {
                n = a = 0;
              }
            if (5 & c[0]) throw c[1];
            return { value: c[0] ? c[1] : void 0, done: !0 };
          })([c, s]);
        };
      }
    },
    l = function (e, t, n) {
      (void 0 === e && (e = document), void 0 === t && (t = r.g.CDN));
      var l = i.chartRenderAdapter.getElements(e);
      let runtime;
      a.D(e, l, function (e) {
        runtime ??= a.G(
          "".concat(t, "/dist/js/echarts/echarts.min.js?v=5.5.1"),
          "vditorEchartsScript",
        ).then(() => installTreeSpacing(echarts));
        return runtime
          .then(function () {
            return c(void 0, void 0, void 0, function () {
              var t, r, a;
              return s(this, function (c) {
                switch (c.label) {
                  case 0:
                    if (e.isConnected === false || e.getAttribute("data-processed") === "true")
                      return [2];
                    if (
                      e.parentElement.classList.contains(
                        "vditor-wysiwyg__pre",
                      ) ||
                      e.parentElement.classList.contains(
                        "vditor-ir__marker--pre",
                      )
                    )
                      return [2];
                    if (!(t = i.chartRenderAdapter.getCode(e).trim()))
                      return [2];
                    c.label = 1;
                  case 1:
                    return (
                      c.trys.push([1, 3, , 4]),
                      "true" === e.getAttribute("data-processed")
                        ? [2]
                        : [4, (0, o.Qf)(t)]
                    );
                  case 2:
                    r = c.sent();
                    // 解析期间可能已切换正文；旧节点和已复用的实例不再初始化。
                    if (e.isConnected === false || e.getAttribute("data-processed") === "true")
                      return [2];
                    return (
                      ([r.series].flat().filter(Boolean).forEach(series => {
                        if (series.type === "tree" && ["rect", "roundRect"].includes(series.symbol) && series.label?.position === "inside") {
                          const dark = "dark" === n;
                          series.nodeScaleRatio ??= 1;
                          series.itemStyle = {
                            color: dark ? "#1e293b" : "#f8fafc",
                            borderColor: dark ? "#475569" : "#cbd5e1",
                            borderWidth: 1.5,
                            ...series.itemStyle,
                          };
                          series.lineStyle = {
                            color: dark ? "#64748b" : "#94a3b8",
                            width: 1.5,
                            ...series.lineStyle,
                          };
                          series.label = {
                            color: dark ? "#f1f5f9" : "#1e293b",
                            ...series.label,
                          };
                          series.emphasis = {
                            disabled: true,
                            ...series.emphasis,
                          };
                        }
                      })),
                      // 默认背景跟随阅读器；深色箱体避免继承白色，显式颜色始终优先。
                      (r.backgroundColor ??= "transparent"),
                      ("dark" === n && [r.series].flat().filter(Boolean).forEach(function (series) {
                        if (series.type === "boxplot") {
                          series.itemStyle = { color: "#1e293b", ...series.itemStyle };
                        }
                      })),
                      (e.__diagramChart = echarts.init(
                        e,
                        "dark" === n ? "dark" : void 0,
                      )),
                      (e.__diagramChart.__maersDark = "dark" === n),
                      e.__diagramChart.setOption(r),
                      e.__diagramChart.on("treeroam", () => syncTreeLabels(e.__diagramChart)),
                      e.__diagramChart.on("treeExpandAndCollapse", () => syncTreeLabels(e.__diagramChart)),
                      e.__diagramChart.on("click", () => syncTreeLabels(e.__diagramChart)),
                      e.__diagramChart.on("finished", () => syncTreeLabels(e.__diagramChart)),
                      syncTreeLabels(e.__diagramChart),
                      e.setAttribute("data-diagram-sig", "echarts:" + t),
                      e.setAttribute("data-processed", "true"),
                      window.__mountDiagramFsBtn &&
                        window.__mountDiagramFsBtn(e),
                      [3, 4]
                    );
                  case 3:
                    return (
                      (a = c.sent()),
                      (e.className = "vditor-reset--error"),
                      (e.innerHTML = "echarts render error: <br>".concat(a)),
                      [3, 4]
                    );
                  case 4:
                    return [2];
                }
              });
            });
          });
      });
    };
};
