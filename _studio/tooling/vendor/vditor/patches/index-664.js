/** Vditor 664 模块的 MAERS 定制实现；由 vendor-build.mjs 注入固定版本基准。 */
(e, t, n) => {
  "use strict";
  n.d(t, { default: () => O });
  var r = n(386),
    i = n(781),
    o = n(379),
    a = n(895),
    l = n(169),
    s = n(572),
    c = n(702),
    d = function (e) {
      void 0 === e && (e = document);
      var t = function (e) {
        var t = document.createElement("img");
        ((t.src = e.getAttribute("data-src")),
          t.addEventListener("load", function () {
            (e.getAttribute("style") ||
              e.getAttribute("class") ||
              e.getAttribute("width") ||
              e.getAttribute("height") ||
              (t.naturalHeight > t.naturalWidth &&
                t.naturalWidth / t.naturalHeight <
                  document.querySelector(".vditor-reset").clientWidth /
                    (window.innerHeight - 40) &&
                t.naturalHeight > window.innerHeight - 40 &&
                (e.style.height = window.innerHeight - 40 + "px")),
              (e.src = t.src));
          }),
          e.removeAttribute("data-src"));
      };
      if (!("IntersectionObserver" in window))
        return (
          e.querySelectorAll("img").forEach(function (e) {
            e.getAttribute("data-src") && t(e);
          }),
          !1
        );
      window.vditorImageIntersectionObserver
        ? (window.vditorImageIntersectionObserver.disconnect(),
          e.querySelectorAll("img").forEach(function (e) {
            window.vditorImageIntersectionObserver.observe(e);
          }))
        : ((window.vditorImageIntersectionObserver = new IntersectionObserver(
            function (e) {
              e.forEach(function (e) {
                (void 0 === e.isIntersecting
                  ? 0 !== e.intersectionRatio
                  : e.isIntersecting) &&
                  e.target.getAttribute("data-src") &&
                  t(e.target);
              });
            },
          )),
          e.querySelectorAll("img").forEach(function (e) {
            window.vditorImageIntersectionObserver.observe(e);
          }));
    },
    u = n(982),
    p = n(431),
    m = n(570),
    f = n(593),
    h = n(558),
    v = n(182),
    g = n(931),
    y = n(793),
    b = n(652),
    w = n(998),
    E = n(118),
    k = n(2),
    S = n(65),
    L = n(307),
    T = function (e, t) {
      if (
        (void 0 === t && (t = "zh_CN"),
        "undefined" != typeof speechSynthesis &&
          "undefined" != typeof SpeechSynthesisUtterance)
      ) {
        var n = function () {
            var e, n;
            return (
              speechSynthesis.getVoices().forEach(function (r) {
                (r.lang === t.replace("_", "-") && (e = r),
                  r.default && (n = r));
              }),
              e || (e = n),
              e
            );
          },
          r = '<svg><use xlink:href="#vditor-icon-play"></use></svg>',
          i = '<svg><use xlink:href="#vditor-icon-pause"></use></svg>';
        document.getElementById("vditorIconScript") ||
          ((r =
            '<svg viewBox="0 0 32 32"><path d="M3.436 0l25.128 16-25.128 16v-32z"></path></svg>'),
          (i =
            '<svg viewBox="0 0 32 32"><path d="M20.617 0h9.128v32h-9.128v-32zM2.255 32v-32h9.128v32h-9.128z"></path></svg>'));
        var o = document.querySelector(".vditor-speech");
        o ||
          (((o = document.createElement("button")).className = "vditor-speech"),
          e.insertAdjacentElement("beforeend", o),
          void 0 !== speechSynthesis.onvoiceschanged &&
            (speechSynthesis.onvoiceschanged = n));
        var a = n(),
          l = new SpeechSynthesisUtterance();
        ((l.voice = a),
          (l.onend = l.onerror =
            function () {
              ((o.style.display = "none"),
                speechSynthesis.cancel(),
                o.classList.remove("vditor-speech--current"),
                (o.innerHTML = r));
            }),
          e.addEventListener(
            void 0 !== window.ontouchstart ? "touchend" : "click",
            function (t) {
              var n = t.target;
              if (
                n.classList.contains("vditor-speech") ||
                n.parentElement.classList.contains("vditor-speech")
              )
                return (
                  o.classList.contains("vditor-speech--current")
                    ? speechSynthesis.speaking &&
                      (speechSynthesis.paused
                        ? (speechSynthesis.resume(), (o.innerHTML = i))
                        : (speechSynthesis.pause(), (o.innerHTML = r)))
                    : ((l.text = o.getAttribute("data-text")),
                      speechSynthesis.speak(l),
                      o.classList.add("vditor-speech--current"),
                      (o.innerHTML = i)),
                  (0, L.Hc)(window.vditorSpeechRange),
                  void e.focus()
                );
              if (
                ((o.style.display = "none"),
                speechSynthesis.cancel(),
                o.classList.remove("vditor-speech--current"),
                (o.innerHTML = r),
                0 !== getSelection().rangeCount)
              ) {
                var a = getSelection().getRangeAt(0),
                  s = a.toString().trim();
                if (s) {
                  window.vditorSpeechRange = a.cloneRange();
                  var c = a.getBoundingClientRect();
                  ((o.innerHTML = r),
                    (o.style.display = "block"),
                    (o.style.top =
                      c.top +
                      c.height +
                      document.querySelector("html").scrollTop -
                      20 +
                      "px"),
                    void 0 !== window.ontouchstart
                      ? (o.style.left =
                          t.changedTouches[t.changedTouches.length - 1].pageX +
                          2 +
                          "px")
                      : (o.style.left = t.clientX + 2 + "px"),
                    o.setAttribute("data-text", s));
                }
              }
            },
          ));
      }
    },
    C = function (e, t, n, r) {
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
    M = function (e, t) {
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
    x = function (e) {
      var t,
        n = {
          anchor: 0,
          cdn: y.g.CDN,
          customEmoji: {},
          emojiPath: "".concat(y.g.CDN, "/dist/images/emoji"),
          hljs: y.g.HLJS_OPTIONS,
          icon: "ant",
          lang: "zh_CN",
          markdown: y.g.MARKDOWN_OPTIONS,
          math: y.g.MATH_OPTIONS,
          mode: "light",
          speech: { enable: !1 },
          render: { media: { enable: !0 } },
          theme: y.g.THEME_OPTIONS,
        };
      return (
        e.cdn &&
          ((null === (t = e.theme) || void 0 === t ? void 0 : t.path) ||
            (n.theme.path = "".concat(e.cdn, "/dist/css/content-theme")),
          e.emojiPath ||
            (n.emojiPath = "".concat(e.cdn, "/dist/images/emoji"))),
        (0, k.T)(n, e)
      );
    },
    A = function (e, t) {
      var n = x(t);
      return (0, w.G)(
        "".concat(n.cdn, "/dist/js/lute/lute.min.js"),
        "vditorLuteScript",
      ).then(function () {
        var r = (0, S.X)({
          autoSpace: n.markdown.autoSpace,
          gfmAutoLink: n.markdown.gfmAutoLink,
          codeBlockPreview: n.markdown.codeBlockPreview,
          emojiSite: n.emojiPath,
          emojis: n.customEmoji,
          fixTermTypo: n.markdown.fixTermTypo,
          footnotes: n.markdown.footnotes,
          headingAnchor: 0 !== n.anchor,
          inlineMathDigit: n.math.inlineDigit,
          lazyLoadImage: n.lazyLoadImage,
          linkBase: n.markdown.linkBase,
          linkPrefix: n.markdown.linkPrefix,
          listStyle: n.markdown.listStyle,
          mark: n.markdown.mark,
          mathBlockPreview: n.markdown.mathBlockPreview,
          paragraphBeginningSpace: n.markdown.paragraphBeginningSpace,
          sanitize: n.markdown.sanitize,
          toc: n.markdown.toc,
        });
        return (
          (null == t ? void 0 : t.renderers) &&
            r.SetJSRenderers({ renderers: { Md2HTML: t.renderers } }),
          r.SetHeadingID(!0),
          r.Md2HTML(e)
        );
      });
    },
    _ = function (e, t, n) {
      return C(void 0, void 0, void 0, function () {
        var i, v, y, k;
        return M(this, function (S) {
          switch (S.label) {
            case 0:
              return ((i = x(n)), [4, A(t, i)]);
            case 1:
              if (
                ((v = S.sent()),
                i.transform && (v = i.transform(v)),
                (function () {
                  var t = new Map();
                  (e
                    .querySelectorAll(
                      '[data-processed="true"][data-diagram-sig]',
                    )
                    .forEach(function (e) {
                      var n = e.getAttribute("data-diagram-sig");
                      (t.has(n) || t.set(n, []), t.get(n).push(e));
                    }),
                    (e.innerHTML = v),
                    t.size > 0 &&
                      (e
                        .querySelectorAll(".language-mindmap")
                        .forEach(function (e) {
                          var n =
                              "mindmap:" + (e.getAttribute("data-code") || ""),
                            r = t.get(n);
                          r && r.length && e.replaceWith(r.shift());
                        }),
                      e
                        .querySelectorAll("code.language-markmap")
                        .forEach(function (e) {
                          var n = "markmap:" + (e.textContent || "").trim(),
                            r = t.get(n);
                          if (r && r.length && e.parentNode) {
                            var i = r.shift();
                            (e.parentNode.classList.add("cms-diagram-pre"),
                              e.replaceWith(i));
                          }
                        })));
                })(),
                e.classList.add("vditor-reset"),
                i.i18n)
              )
                return [3, 5];
              if (
                [
                  "en_US",
                  "fr_FR",
                  "pt_BR",
                  "ja_JP",
                  "ko_KR",
                  "ru_RU",
                  "sv_SE",
                  "zh_CN",
                  "zh_TW",
                ].includes(i.lang)
              )
                return [3, 2];
              throw new Error(
                "options.lang error, see https://ld246.com/article/1549638745630#options",
              );
            case 2:
              return (
                (k = (y = "vditorI18nScript") + i.lang),
                document
                  .querySelectorAll('head script[id^="'.concat(y, '"]'))
                  .forEach(function (e) {
                    e.id !== k && document.head.removeChild(e);
                  }),
                [
                  4,
                  (0, w.G)(
                    "".concat(i.cdn, "/dist/js/i18n/").concat(i.lang, ".js"),
                    k,
                  ),
                ]
              );
            case 3:
              (S.sent(), (S.label = 4));
            case 4:
              return [3, 6];
            case 5:
              ((window.VditorI18n = i.i18n), (S.label = 6));
            case 6:
              return i.icon
                ? [
                    4,
                    (0, w.G)(
                      "".concat(i.cdn, "/dist/js/icons/").concat(i.icon, ".js"),
                      "vditorIconScript",
                    ),
                  ]
                : [3, 8];
            case 7:
              (S.sent(), (S.label = 8));
            case 8:
              return (
                (0, b.Z)(i.theme.current, i.theme.path),
                1 === i.anchor && e.classList.add("vditor-reset--anchor"),
                (0, a.O)(e, i.hljs),
                (0, c.s)(i.hljs, e, i.cdn),
                (0, u.H)(e, { cdn: i.cdn, math: i.math }),
                (0, m.i)(e, i.cdn, i.mode),
                (0, f.K)(e, i.cdn, i.mode),
                (0, l.P)(e, i.cdn),
                (0, s.v)(e, i.cdn),
                (0, o.p)(e, i.cdn, i.mode),
                (0, h.P)(e, i.cdn, i.mode),
                (0, g.B)(e, i.cdn),
                (0, r.Q)(e, i.cdn),
                i.render.media.enable && (0, p.Y)(e),
                i.speech.enable && T(e),
                0 !== i.anchor &&
                  ((L = i.anchor),
                  document
                    .querySelectorAll(".vditor-anchor")
                    .forEach(function (e) {
                      (1 === L && e.classList.add("vditor-anchor--left"),
                        (e.onclick = function () {
                          var t = e.getAttribute("href").substr(1),
                            n = document.getElementById(
                              "vditorAnchor-" + t,
                            ).offsetTop;
                          document.querySelector("html").scrollTop = n;
                        }));
                    }),
                  (window.onhashchange = function () {
                    var e = document.getElementById(
                      "vditorAnchor-" +
                        decodeURIComponent(window.location.hash.substr(1)),
                    );
                    e &&
                      (document.querySelector("html").scrollTop = e.offsetTop);
                  })),
                i.after && i.after(),
                i.lazyLoadImage && d(e),
                e.addEventListener("click", function (t) {
                  var n = (0, E.lG)(t.target, "SPAN");
                  if (n && (0, E.fb)(n, "vditor-toc")) {
                    var r = e.querySelector(
                      "#" + n.getAttribute("data-target-id"),
                    );
                    r && window.scrollTo(window.scrollX, r.offsetTop);
                  } else;
                }),
                [2]
              );
          }
          var L;
        });
      });
    },
    H = n(971),
    N = n(34);
  const O = (function () {
    function e() {}
    return (
      (e.adapterRender = i),
      (e.previewImage = H.E),
      (e.codeRender = a.O),
      (e.graphvizRender = s.v),
      (e.highlightRender = c.s),
      (e.mathRender = u.H),
      (e.mermaidRender = m.i),
      (e.markmapRender = f.K),
      (e.flowchartRender = l.P),
      (e.chartRender = o.p),
      (e.abcRender = r.Q),
      (e.mindmapRender = h.P),
      (e.plantumlRender = g.B),
      (e.outlineRender = v.k),
      (e.mediaRender = p.Y),
      (e.speechRender = T),
      (e.lazyLoadImageRender = d),
      (e.md2html = A),
      (e.preview = _),
      (e.setCodeTheme = N.Y),
      (e.setContentTheme = b.Z),
      e
    );
  })();
};
