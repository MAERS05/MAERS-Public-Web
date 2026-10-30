/** Vditor 998 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  "use strict";
  n.d(t, { G: () => i, J: () => r });
  var r = function (e, t) {
      if (document.getElementById(t)) return !1;
      var n = new XMLHttpRequest();
      (n.open("GET", e, !1),
        n.setRequestHeader(
          "Accept",
          "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
        ),
        n.send(""));
      var r = document.createElement("script");
      ((r.type = "text/javascript"),
        (r.text = n.responseText),
        (r.id = t),
        document.head.appendChild(r));
    },
    i = function (e, t) {
      var s = document.getElementById(t);
      if (s) return s.__vditorLoadPromise || Promise.resolve(!0);
      ((s = document.createElement("script")),
        (s.id = t),
        (s.src = e),
        (s.async = !0));
      var p = new Promise(function (n, r) {
        ((s.onload = function () {
          n(!0);
        }),
          (s.onerror = function (e) {
            (s.remove(), r(e));
          }));
      });
      return ((s.__vditorLoadPromise = p), document.head.appendChild(s), p);
    };
};
