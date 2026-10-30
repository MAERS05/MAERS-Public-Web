/** Vditor 570 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  "use strict";
  n.d(t, { i: () => c });
  var r = n(793),
    i = n(998),
    o = n(781),
    a = n(446),
    l = function (e, t, n, r) {
      return new (n || (n = Promise))(function (i, o) {
        function a(e) {
          try {
            s(r.next(e));
          } catch (e) {
            o(e);
          }
        }
        function l(e) {
          try {
            s(r.throw(e));
          } catch (e) {
            o(e);
          }
        }
        function s(e) {
          var t;
          e.done
            ? i(e.value)
            : ((t = e.value),
              t instanceof n
                ? t
                : new n(function (e) {
                    e(t);
                  })).then(a, l);
        }
        s((r = r.apply(e, t || [])).next());
      });
    },
    s = function (e, t) {
      var n,
        r,
        i,
        o,
        a = {
          label: 0,
          sent: function () {
            if (1 & i[0]) throw i[1];
            return i[1];
          },
          trys: [],
          ops: [],
        };
      return (
        (o = { next: l(0), throw: l(1), return: l(2) }),
        "function" == typeof Symbol &&
          (o[Symbol.iterator] = function () {
            return this;
          }),
        o
      );
      function l(l) {
        return function (s) {
          return (function (l) {
            if (n) throw new TypeError("Generator is already executing.");
            for (; o && ((o = 0), l[0] && (a = 0)), a;)
              try {
                if (
                  ((n = 1),
                  r &&
                    (i =
                      2 & l[0]
                        ? r.return
                        : l[0]
                          ? r.throw || ((i = r.return) && i.call(r), 0)
                          : r.next) &&
                    !(i = i.call(r, l[1])).done)
                )
                  return i;
                switch (((r = 0), i && (l = [2 & l[0], i.value]), l[0])) {
                  case 0:
                  case 1:
                    i = l;
                    break;
                  case 4:
                    return (a.label++, { value: l[1], done: !1 });
                  case 5:
                    (a.label++, (r = l[1]), (l = [0]));
                    continue;
                  case 7:
                    ((l = a.ops.pop()), a.trys.pop());
                    continue;
                  default:
                    if (
                      !((i = a.trys),
                      (i = i.length > 0 && i[i.length - 1]) ||
                        (6 !== l[0] && 2 !== l[0]))
                    ) {
                      a = 0;
                      continue;
                    }
                    if (3 === l[0] && (!i || (l[1] > i[0] && l[1] < i[3]))) {
                      a.label = l[1];
                      break;
                    }
                    if (6 === l[0] && a.label < i[1]) {
                      ((a.label = i[1]), (i = l));
                      break;
                    }
                    if (i && a.label < i[2]) {
                      ((a.label = i[2]), a.ops.push(l));
                      break;
                    }
                    (i[2] && a.ops.pop(), a.trys.pop());
                    continue;
                }
                l = t.call(e, a);
              } catch (e) {
                ((l = [6, e]), (r = 0));
              } finally {
                n = i = 0;
              }
            if (5 & l[0]) throw l[1];
            return { value: l[0] ? l[1] : void 0, done: !0 };
          })([l, s]);
        };
      }
    },
    c = function (e, t, n) {
      void 0 === t && (t = r.g.CDN);
      var c = o.mermaidRenderAdapter.getElements(e);
      0 !== c.length &&
        (0, i.G)(
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
            c.forEach(function (e) {
              return l(void 0, void 0, void 0, function () {
                var t, n, r, i, l;
                return s(this, function (s) {
                  switch (s.label) {
                    case 0:
                      if (
                        ((t = o.mermaidRenderAdapter.getCode(e)),
                        "true" === e.getAttribute("data-processed") ||
                          "" === t.trim())
                      )
                        return [2];
                      ((n = "mermaid" + (0, a.Wb)()), (s.label = 1));
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
                        (i = s.sent()),
                        (l = document.querySelector("#" + n)),
                        (e.innerHTML = ""
                          .concat(
                            l.outerHTML,
                            '<br>\n<div style="text-align: left"><small>',
                          )
                          .concat(
                            i.message.replace(/\n/, "<br>"),
                            "</small></div>",
                          )),
                        l.parentElement.remove(),
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
