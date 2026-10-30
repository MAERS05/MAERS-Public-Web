/** Vditor 169 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  "use strict";
  n.d(t, { P: () => a });
  var r = n(793),
    i = n(998),
    o = n(781),
    a = function (e, t) {
      void 0 === t && (t = r.g.CDN);
      var n = o.flowchartRenderAdapter.getElements(e);
      0 !== n.length &&
        (0, i.G)(
          "".concat(t, "/dist/js/flowchart.js/flowchart.min.js"),
          "vditorFlowchartScript",
        ).then(function () {
          n.forEach(function (e) {
            if ("true" !== e.getAttribute("data-processed")) {
              var t = flowchart.parse(o.flowchartRenderAdapter.getCode(e));
              ((e.innerHTML = ""),
                t.drawSVG(e),
                e.setAttribute("data-processed", "true"),
                window.__mountDiagramFsBtn && window.__mountDiagramFsBtn(e));
            }
          });
        });
    };
};
