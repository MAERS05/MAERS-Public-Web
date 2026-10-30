/** Vditor 379 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  "use strict";
  n.d(t, { p: () => c });
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
      (void 0 === e && (e = document), void 0 === t && (t = r.g.CDN));
      var c = o.chartRenderAdapter.getElements(e);
      c.length > 0 &&
        (0, i.G)(
          "".concat(t, "/dist/js/echarts/echarts.min.js?v=5.5.1"),
          "vditorEchartsScript",
        ).then(function () {
          c.forEach(function (e) {
            return l(void 0, void 0, void 0, function () {
              var t, r, i;
              return s(this, function (l) {
                switch (l.label) {
                  case 0:
                    if (
                      e.parentElement.classList.contains(
                        "vditor-wysiwyg__pre",
                      ) ||
                      e.parentElement.classList.contains(
                        "vditor-ir__marker--pre",
                      )
                    )
                      return [2];
                    if (!(t = o.chartRenderAdapter.getCode(e).trim()))
                      return [2];
                    l.label = 1;
                  case 1:
                    return (
                      l.trys.push([1, 3, , 4]),
                      "true" === e.getAttribute("data-processed")
                        ? [2]
                        : [4, (0, a.Qf)(t)]
                    );
                  case 2:
                    return (
                      (r = l.sent()),
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
                      )).setOption(r),
                      e.setAttribute("data-processed", "true"),
                      window.__mountDiagramFsBtn &&
                        window.__mountDiagramFsBtn(e),
                      [3, 4]
                    );
                  case 3:
                    return (
                      (i = l.sent()),
                      (e.className = "vditor-reset--error"),
                      (e.innerHTML = "echarts render error: <br>".concat(i)),
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
