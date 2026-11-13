/** Vditor 169 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  n.d(t, { P: () => o });
  var r = n(793),
    a = n(998),
    i = n(781),
    o = function (e, t) {
      void 0 === t && (t = r.g.CDN);
      var n = i.flowchartRenderAdapter.getElements(e);
      0 !== n.length &&
        (0, a.G)(
          "".concat(t, "/dist/js/flowchart.js/flowchart.min.js"),
          "vditorFlowchartScript",
        ).then(function () {
          n.forEach(function (e) {
            if (e.isConnected !== false && "true" !== e.getAttribute("data-processed")) {
              const source = i.flowchartRenderAdapter.getCode(e).trim();
              if (!source) return;
              var t = flowchart.parse(source);
              ((e.innerHTML = ""),
                t.drawSVG(e),
                e.setAttribute("data-diagram-sig", "flowchart:" + source),
                e.setAttribute("data-processed", "true"),
                window.__mountDiagramFsBtn && window.__mountDiagramFsBtn(e));
            }
          });
        });
    };
};
