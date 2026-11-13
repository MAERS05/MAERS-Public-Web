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
            if (e.isConnected === false || ["true", "pending"].includes(e.getAttribute("data-processed"))) return;
            const source = i.graphvizRenderAdapter.getCode(e).trim();
            if (
              !e.parentElement.classList.contains("vditor-wysiwyg__pre") &&
              !e.parentElement.classList.contains("vditor-ir__marker--pre") &&
              source
            ) {
              const urls = window.URL || window.webkitURL;
              let worker = null, workerUrl = null, released = false;
              // 渲染完成或正文被替换时释放工作线程及临时脚本地址。
              const releaseWorker = () => {
                if (released) return;
                released = true;
                worker?.terminate();
                if (workerUrl) urls.revokeObjectURL(workerUrl);
                if (e.__disposeDiagramDOM === releaseWorker) delete e.__disposeDiagramDOM;
              };
              try {
                const script = new Blob(
                    [
                      "importScripts('".concat(
                        document
                          .getElementById("vditorGraphVizScript")
                          .src.replace("viz.js", "full.render.js"),
                        "');",
                      ),
                    ],
                    { type: "application/javascript" },
                  );
                workerUrl = urls.createObjectURL(script);
                worker = new Worker(workerUrl);
                e.__disposeDiagramDOM = releaseWorker;
                e.setAttribute("data-processed", "pending");
                new Viz({ worker })
                  .renderSVGElement(source)
                  .then(function (svg) {
                    if (released || e.isConnected === false) return;
                    e.innerHTML = svg.outerHTML;
                    e.setAttribute("data-diagram-sig", "graphviz:" + source);
                    e.setAttribute("data-processed", "true");
                    window.__mountDiagramFsBtn?.(e);
                  })
                  .catch(function (error) {
                    if (released || e.isConnected === false) return;
                    e.textContent = "graphviz render error: " + error.message;
                    e.className = "vditor-reset--error";
                  }).finally(releaseWorker);
              } catch (error) {
                releaseWorker();
                console.error("graphviz error", error);
              }
            }
          });
        });
    };
};
