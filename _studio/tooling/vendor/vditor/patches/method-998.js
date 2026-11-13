/** Vditor 998 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  n.d(t, { G: () => a, J: () => r, D: () => scheduleDiagrams });
  function scheduleDiagrams(container, elements, render) {
    const items = Array.from(elements).filter(item => item.getAttribute("data-processed") !== "true");
    const root = container.closest?.(".reader-scroll-area");
    let stopped = false;
    const run = item => Promise.resolve().then(() => {
      if (!stopped && item.isConnected !== false) return render(item);
    }).catch(error => console.error("[MAERS] 图表加载失败", error));
    if (elements.length < 8 || !items.length || !root || typeof IntersectionObserver !== "function") {
      items.forEach(run);
      return;
    }

    const pending = new Map();
    const ready = new Set();
    const cleanups = container.__diagramCleanups ??= new Set();
    container.__disposeDeferredDiagrams ??= () => cleanups.forEach(cancel => cancel());
    let frame = 0, running = false;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) ready.add(entry.target);
        else ready.delete(entry.target);
      }
      schedule();
    }, { root, rootMargin: "320px 0px" });
    function cancel() {
      stopped = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      for (const target of pending.keys()) target.classList.remove("cms-diagram-pending");
      pending.clear();
      ready.clear();
      cleanups.delete(cancel);
    }
    function schedule() {
      if (stopped || frame || running || !ready.size) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const target = ready.values().next().value;
        if (!target) return;
        ready.delete(target);
        const item = pending.get(target);
        if (!item) { schedule(); return; }
        pending.delete(target);
        observer.unobserve(target);
        running = true;
        run(item).finally(() => {
          target.classList.remove("cms-diagram-pending");
          running = false;
          if (pending.size) schedule();
          else cancel();
        });
      });
    }
    cleanups.add(cancel);
    for (const item of items) {
      const target = item.closest("pre") || item;
      target.classList.add("cms-diagram-pending");
      pending.set(target, item);
      observer.observe(target);
    }
  }

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
    a = function (e, t) {
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
