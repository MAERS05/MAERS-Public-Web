/** Vditor 572 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  n.d(t, { v: () => o });
  var r = n(793),
    a = n(998),
    i = n(781),
    o = function (e, t) {
      void 0 === t && (t = r.g.CDN);
      var n = i.graphvizRenderAdapter.getElements(e);
      0 !== n.length &&
        (0, a.G)(
          "".concat(t, "/dist/js/graphviz/viz.js"),
          "vditorGraphVizScript",
        ).then(function () {
          n.forEach(function (e) {
            var t = i.graphvizRenderAdapter.getCode(e);
            if (
              !e.parentElement.classList.contains("vditor-wysiwyg__pre") &&
              !e.parentElement.classList.contains("vditor-ir__marker--pre") &&
              "true" !== e.getAttribute("data-processed") &&
              "" !== t.trim()
            ) {
              try {
                var n = new Blob(
                    [
                      "importScripts('".concat(
                        document
                          .getElementById("vditorGraphVizScript")
                          .src.replace("viz.js", "full.render.js"),
                        "');",
                      ),
                    ],
                    { type: "application/javascript" },
                  ),
                  r = (window.URL || window.webkitURL).createObjectURL(n),
                  a = new Worker(r);
                new Viz({ worker: a })
                  .renderSVGElement(t)
                  .then(function (t) {
                    ((e.innerHTML = t.outerHTML),
                      window.__mountDiagramFsBtn &&
                        window.__mountDiagramFsBtn(e));
                  })
                  .catch(function (t) {
                    ((e.innerHTML = "graphviz render error: <br>".concat(t)),
                      (e.className = "vditor-reset--error"));
                  });
              } catch (e) {
                console.error("graphviz error", e);
              }
              e.setAttribute("data-processed", "true");
            }
          });
        });
    };
};
