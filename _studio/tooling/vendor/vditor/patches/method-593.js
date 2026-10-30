/** Vditor 593 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  n.d(t, { K: () => s });
  var r = n(793),
    a = n(998),
    i = n(781);
  var l = n(558).T;
  var c = function parseMarkmapSource(source) {
    var lines = String(source || "")
      .replace(/^---[\s\S]*?---\s*\n/, "")
      .split(/\r?\n/);
    var root = { name: "Root", children: [] };
    var stack = [{ node: root, level: 0 }];
    var clean = function (text) {
      return text
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .trim();
    };
    lines.forEach(function (line) {
      if (!line.trim()) return;
      var heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
      var list = !heading && line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.+?)\s*$/);
      if (!heading && !list) {
        if (stack.length > 1) {
          var previous = stack[stack.length - 1].node;
          previous.name =
            previous.name.replace(/(?:[ \t]+|\\)$/, "") + "\n" + clean(line);
        }
        return;
      }
      var level = heading
        ? heading[1].length
        : 10 + Math.floor(list[1].replace(/\t/g, "  ").length / 2);
      var node = { name: clean(heading ? heading[2] : list[2]) };
      while (stack.length > 1 && stack[stack.length - 1].level >= level)
        stack.pop();
      var parent = stack[stack.length - 1].node;
      if (!parent.children) parent.children = [];
      parent.children.push(node);
      stack.push({ node: node, level: level });
    });
    return root.children.length === 1
      ? root.children[0]
      : root.children.length > 1
        ? { name: "", children: root.children }
        : { name: String(source || "").trim() || "Empty" };
  };
  var s = function (e, t, n) {
    void 0 === t && (t = r.g.CDN);
    var o = i.markmapRenderAdapter.getElements(e);
    0 !== o.length &&
      (0, a.G)(
        "".concat(t, "/dist/js/echarts/echarts.min.js?v=5.5.1"),
        "vditorEchartsScript",
      ).then(function () {
        o.forEach(function (e) {
          var t = i.markmapRenderAdapter.getCode(e);
          if ("true" !== e.getAttribute("data-processed") && "" !== t.trim()) {
            var r = document.createElement("div");
            ((r.className = "language-markmap"),
              (r.style.height = "420px"),
              (r.style.overflow = "hidden"),
              r.setAttribute("data-processed", "true"),
              r.setAttribute("data-diagram-sig", "markmap:" + t.trim()),
              e.parentNode && "PRE" === e.parentNode.nodeName
                ? e.parentNode.replaceWith(r)
                : e.replaceWith(r),
              (r.__treeData = c(t)),
              l(r, n));
          }
        });
      });
  };
};
