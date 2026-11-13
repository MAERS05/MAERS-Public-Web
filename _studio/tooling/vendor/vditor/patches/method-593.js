/** Vditor 593 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  n.d(t, { K: () => s });
  const { markmapRenderAdapter } = n(781);
  const { T: l, parseLinkedLabel } = n(558);
  var c = function parseMarkmapSource(source, defaultDirection) {
    var options = { direction: defaultDirection || "LR" };
    var text = String(source || "");
    // 兼容原生 Markmap frontmatter，也允许前置的双向布局注释。
    var frontmatter = text.match(/^((?:(?:[ \t]*%%[^\r\n]*)?[ \t]*\r?\n)*)---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (frontmatter) {
      var fmDir = frontmatter[2].match(/^[ \t]*direction[ \t]*:[ \t]*(both|lr|tb)[ \t]*$/im);
      if (fmDir) options.direction = fmDir[1].toLowerCase() === "both" ? "both" : fmDir[1].toUpperCase();
      var fmDepth = frontmatter[2].match(/^[ \t]*initialExpandLevel[ \t]*:[ \t]*(-?\d+)[ \t]*(?:#.*)?$/m);
      if (fmDepth) options.initialDepth = Number(fmDepth[1]) < 0 ? Infinity : Number(fmDepth[1]);
      text = frontmatter[1] + text.slice(frontmatter[0].length);
    }
    var lines = text.split(/\r?\n/);
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
    const readLabel = text => parseLinkedLabel(text) || { name: clean(text) };
    lines.forEach(function (line) {
      if (!line.trim()) return;
      var commentDir = line.match(/^[ \t]*%%[ \t]*(?:direction[ \t]*:[ \t]*)?(both|lr|tb)[ \t]*$/i);
      if (commentDir) {
        options.direction = commentDir[1].toLowerCase() === "both" ? "both" : commentDir[1].toUpperCase();
        return;
      }
      if (/^[ \t]*%%/.test(line)) return;
      if (stack.length === 1) {
        var plainDir = line.match(/^[ \t]*direction[ \t]*:[ \t]*(both|lr|tb)[ \t]*$/i);
        if (plainDir) {
          options.direction = plainDir[1].toLowerCase() === "both" ? "both" : plainDir[1].toUpperCase();
          return;
        }
      }
      var heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
      var list = !heading && line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.+?)\s*$/);
      if (!heading && !list) {
        if (stack.length > 1) {
          var previous = stack[stack.length - 1].node;
          const addition = readLabel(line);
          if (previous.parts || addition.parts) {
            previous.parts ??= [{ text: previous.name }];
            const last = previous.parts.at(-1);
            last.text = last.text.replace(/(?:[ \t]+|\\)$/, "") + "\n";
            previous.parts.push(...(addition.parts || [{ text: addition.name }]));
          }
          previous.name =
            previous.name.replace(/(?:[ \t]+|\\)$/, "") + "\n" + addition.name;
        }
        return;
      }
      var level = heading
        ? heading[1].length
        : 10 + Math.floor(list[1].replace(/\t/g, "  ").length / 2);
      var node = readLabel(heading ? heading[2] : list[2]);
      while (stack.length > 1 && stack[stack.length - 1].level >= level)
        stack.pop();
      var parent = stack[stack.length - 1].node;
      if (!parent.children) parent.children = [];
      parent.children.push(node);
      stack.push({ node: node, level: level });
    });
    var tree = root.children.length === 1
      ? root.children[0]
      : root.children.length > 1
        ? { name: "", children: root.children }
        : parseLinkedLabel(text.trim()) || { name: text.trim() || "Empty" };
    return { tree: tree, options: options };
  };
  const s = function (container = document, _cdn, theme) {
    container.querySelectorAll(".language-markmap, code.language-markmap-both").forEach(element => {
      const source = markmapRenderAdapter.getCode(element).trim();
      if (element.getAttribute("data-processed") === "true" || !source) return;
      const both = element.classList.contains("language-markmap-both");
      const target = document.createElement("div");
      target.className = both ? "language-markmap language-markmap-both" : "language-markmap";
      target.style.height = "420px";
      target.style.overflow = "hidden";
      target.setAttribute("data-processed", "true");
      target.setAttribute("data-diagram-sig", "markmap:" + source);
      (element.closest("pre") || element).replaceWith(target);
      try {
        const parsed = c(source, both ? "both" : undefined);
        target.__treeData = parsed.tree;
        l(target, theme, parsed.options);
      } catch (error) {
        target.className = "vditor-reset--error";
        target.textContent = "markmap render error: " + error.message;
      }
    });
  };
};
