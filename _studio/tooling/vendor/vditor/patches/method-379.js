/** Vditor 379 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  n.d(t, { p: () => l });
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
      l.length > 0 &&
        (0, a.G)(
          "".concat(t, "/dist/js/echarts/echarts.min.js?v=5.5.1"),
          "vditorEchartsScript",
        ).then(function () {
          l.forEach(function (e) {
            return c(void 0, void 0, void 0, function () {
              var t, r, a;
              return s(this, function (c) {
                switch (c.label) {
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
                    return (
                      (r = c.sent()),
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
