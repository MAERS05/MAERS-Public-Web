/** 共用线性图标：固定图形和描边，不接受外部 HTML。 */
const paths = {
    "home": "<path d=\"m3 10 9-7 9 7v11H3Z\"/><path d=\"M9 21v-8h6v8\"/>",
    "book": "<path d=\"M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14\"/>",
    "photo": "<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"3\"/><circle cx=\"8\" cy=\"8\" r=\"1.5\"/><path d=\"m3 17 5-5 4 4 4-6 5 7\"/>",
    "music": "<path d=\"M9 18V5l11-2v13M9 8l11-2\"/><ellipse cx=\"6\" cy=\"18\" rx=\"3\" ry=\"3\"/><ellipse cx=\"17\" cy=\"16\" rx=\"3\" ry=\"3\"/>",
    "collection": "<path d=\"M5 4h14v17l-7-4-7 4Z\"/>",
    "folder": "<path d=\"M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\"/>",
    "note": "<path d=\"M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9Z\"/><path d=\"M14 3v7h7M7 14h10M7 17h7\"/>",
    "video": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"3\"/><path d=\"m10 9 5 3-5 3Z\"/>",
    "game": "<path d=\"M7 7h10c3 0 5 12 2 13-2 1-4-4-7-4s-5 5-7 4C2 19 4 7 7 7Z\"/><path d=\"M6 11h5M8.5 8.5v5M16 10h.01M18 13h.01\"/>",
    "search": "<circle cx=\"10.5\" cy=\"10.5\" r=\"6.5\"/><path d=\"m16 16 5 5\"/>",
    "tag": "<path d=\"M3 3h8l10 10-8 8L3 11Z\"/><circle cx=\"7\" cy=\"7\" r=\"1\"/>",
    "clock": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/>",
    "back": "<path d=\"m14 5-7 7 7 7\"/>",
    "forward": "<path d=\"m9 5 7 7-7 7\"/>",
    "close": "<path d=\"m6 6 12 12M6 18 18 6\"/>",
    "plus": "<path d=\"M12 5v14M5 12h14\"/>",
    "more": "<circle cx=\"5\" cy=\"12\" r=\"1\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"19\" cy=\"12\" r=\"1\"/>",
    "edit": "<path d=\"m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z\"/>",
    "trash": "<path d=\"M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7\"/>",
    "settings": "<path d=\"m10 3-.5 3-2 .8L5 5l-2 3 2.5 2v3L3 15l2 3 2.5-1.5 2 .8.5 3h4l.5-3 2-.8L19 18l2-3-2.5-2v-3L21 8l-2-3-2.5 1.8-2-.8L14 3Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
    "info": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 11v6M12 7h.01\"/>",
    "help": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 17h.01\"/>",
    "download": "<path d=\"M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5\"/>",
    "upload": "<path d=\"M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5\"/>",
    "check": "<path d=\"m5 12 4 4L19 6\"/>",
    "play": "<path d=\"m8 4 12 8-12 8Z\"/>",
    "pause": "<path d=\"M8 5v14M16 5v14\"/>",
    "refresh": "<path d=\"M20 8a8 8 0 1 0 0 8M20 3v5h-5\"/>",
    "link": "<path d=\"m9 15 6-6M8 17l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0m2-2 2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0\"/>",
    "copy": "<rect x=\"8\" y=\"8\" width=\"13\" height=\"13\" rx=\"2\"/><path d=\"M16 8V3H3v13h5\"/>",
    "lock": "<rect x=\"5\" y=\"10\" width=\"14\" height=\"11\" rx=\"2\"/><path d=\"M8 10V7a4 4 0 0 1 8 0v3M12 14v3\"/>"
};
export function icon(name, size = 20) {
    return '<svg class="app-icon" width="' + size + '" height="' + size +
        '" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        (paths[name] || paths.note) + '</svg>';
}
