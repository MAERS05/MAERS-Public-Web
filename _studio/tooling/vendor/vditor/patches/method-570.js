/** Vditor 570 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  n.d(t, { i: () => l });
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
      void 0 === t && (t = r.g.CDN);
      var l = i.mermaidRenderAdapter.getElements(e);
      0 !== l.length &&
        (0, a.G)(
          "".concat(t, "/dist/js/mermaid/mermaid.min.js"),
          "vditorMermaidScript",
        ).then(function () {
          // 与思维导图统一节点与连线配色；保留各图的语义形状。
          var dark = "dark" === n,
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
          (mermaid.initialize(e),
            l.forEach(function (e) {
              return c(void 0, void 0, void 0, function () {
                var t, n, r, a, c;
                return s(this, function (s) {
                  switch (s.label) {
                    case 0:
                      if (
                        ((t = i.mermaidRenderAdapter.getCode(e)),
                        "true" === e.getAttribute("data-processed") ||
                          "" === t.trim())
                      )
                        return [2];
                      ((n = "mermaid" + (0, o.Wb)()), (s.label = 1));
                    case 1:
                      return (
                        s.trys.push([1, 3, , 4]),
                        [
                          4,
                          mermaid.render(
                            n,
                            /^\s*classDiagram(?:-v2)?\b/m.test(t)
                              ? '%%{init: {"flowchart": {"htmlLabels": false}}}%%\n' +
                                  t
                              : t,
                          ),
                        ]
                      );
                    case 2:
                      return ((r = s.sent()), (e.innerHTML = r.svg), [3, 4]);
                    case 3:
                      return (
                        (a = s.sent()),
                        (c = document.querySelector("#" + n)),
                        (e.innerHTML = ""
                          .concat(
                            c.outerHTML,
                            '<br>\n<div style="text-align: left"><small>',
                          )
                          .concat(
                            a.message.replace(/\n/, "<br>"),
                            "</small></div>",
                          )),
                        c.parentElement.remove(),
                        [3, 4]
                      );
                    case 4:
                      return (
                        e.setAttribute("data-processed", "true"),
                        window.__mountDiagramFsBtn &&
                          window.__mountDiagramFsBtn(e),
                        [2]
                      );
                  }
                });
              });
            }));
        });
    };
};
