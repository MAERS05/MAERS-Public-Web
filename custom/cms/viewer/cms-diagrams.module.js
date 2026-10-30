/** MAERS 阅读器导图：全屏视口、SVG 平移缩放及图表资源释放。 */
let _exitDiagramFullscreen = null;

// Transfer the current roam center relative to the diagram's layout bounds.
// Keep out-of-bounds coordinates: a deliberately clipped diagram stays clipped.
export function resizeDiagramChart(chart, width, height) {
    if (!chart || chart.isDisposed() || width <= 0 || height <= 0) return;
    if (chart.getWidth() === width && chart.getHeight() === height) return;
    const views = [];
    chart.getModel().eachSeries((series) => {
        const coord = series.coordinateSystem;
        if (coord?.type !== 'view' || typeof series.setCenter !== 'function') return;
        const rect = coord.getBoundingRect();
        const center = coord.getCenter();
        if (rect.width > 0 && rect.height > 0) {
            views.push({ series, x: (center[0] - rect.x) / rect.width,
                y: (center[1] - rect.y) / rect.height, zoom: coord.getZoom() });
        }
    });
    const options = { width, height, animation: { duration: 0 } };
    // Re-layout first to obtain the destination bounds, then transfer its view.
    // Both passes finish in one animation frame without replacing the live data.
    chart.resize(options);
    views.forEach(({ series, x, y, zoom }) => {
        const rect = series.coordinateSystem.getBoundingRect();
        series.setCenter([rect.x + x * rect.width, rect.y + y * rect.height]);
        series.setZoom(zoom);
    });
    if (views.length) chart.resize(options);
}

// Renderer width/height can describe a narrow output canvas rather than the
// drawing itself (or use percentages). Fit the actual SVG geometry once on mount.
function _prepareSvgDiagramViewport(svg) {
    if (svg.__cmsPanZoomBound) return;
    let bounds = null;
    try {
        const box = svg.getBBox();
        if ([box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0) {
            const padding = Math.max(12, Math.min(box.width, box.height) * 0.03);
            bounds = [box.x - padding, box.y - padding, box.width + padding * 2, box.height + padding * 2];
        }
    } catch (_) { /* Detached/hidden SVGs may not have measurable geometry yet. */ }
    if (!bounds) {
        const box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) bounds = box;
    }
    if (!bounds) {
        const dimension = name => {
            const value = (svg.getAttribute(name) || '').trim();
            return /^(?:\d+\.?\d*|\.\d+)(?:px|pt)?$/.test(value) ? parseFloat(value) : 0;
        };
        const width = dimension('width');
        const height = dimension('height');
        if (width > 0 && height > 0) bounds = [0, 0, width, height];
    }
    if (bounds) {
        svg.setAttribute('viewBox', bounds.join(' '));
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
}

// SVG 共用视口：尺寸变化只扩展可见范围，保留中心与屏幕缩放倍率。
function _mountSvgDiagramInteraction(card, svg) {
    if (svg.__cmsPanZoomBound) return;
    const box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return;
    svg.__cmsPanZoomBound = true;
    card.classList.add('cms-svg-interactive');
    let view = box.slice();
    let zoom = 1;
    const pointers = new Map();
    let gesture = null;
    let suppressClick = false;
    const apply = () => svg.setAttribute('viewBox', view.join(' '));
    let unitsPerPixel = null;
    const resizeViewport = () => {
        const { width, height } = svg.getBoundingClientRect();
        if (width <= 0 || height <= 0) return;
        unitsPerPixel ??= Math.max(view[2] / width, view[3] / height);
        const nextWidth = width * unitsPerPixel, nextHeight = height * unitsPerPixel;
        view = [view[0] + (view[2] - nextWidth) / 2, view[1] + (view[3] - nextHeight) / 2,
            nextWidth, nextHeight];
        apply();
        if (pointers.size) beginGesture();
    };
    resizeViewport();
    const toLocal = (x, y) => {
        const m = svg.getScreenCTM();
        if (!m) return null;
        const det = m.a * m.d - m.b * m.c;
        if (!det) return null;
        return [(m.d * (x - m.e) - m.c * (y - m.f)) / det,
            (-m.b * (x - m.e) + m.a * (y - m.f)) / det];
    };
    // 导图节点也可作为拖动起点；全屏按钮、链接等独立控件仍保留自身操作。
    const isControl = target => target.closest('button, a, input, textarea, select, [role="button"]:not([data-mindmap-node])');
    const sampleGesture = () => {
        const [a, b] = [...pointers.values()];
        if (!a) return null;
        return b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
            distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) } : { x: a.x, y: a.y, distance: 1 };
    };
    function beginGesture() {
        const sample = sampleGesture();
        gesture = sample ? { ...sample, anchor: toLocal(sample.x, sample.y), zoom } : null;
    }
    const transformView = (x, y, nextZoom, anchor = toLocal(x, y)) => {
        const point = toLocal(x, y);
        if (!point || !anchor) return;
        const next = Math.max(0.1, Math.min(10, nextZoom));
        const scale = zoom / next;
        unitsPerPixel *= scale;
        view = [anchor[0] - (point[0] - view[0]) * scale,
            anchor[1] - (point[1] - view[1]) * scale, view[2] * scale, view[3] * scale];
        zoom = next;
        apply();
    };
    card.addEventListener('pointerdown', e => {
        if (e.button !== 0 || isControl(e.target) || !toLocal(e.clientX, e.clientY)) return;
        if (!pointers.size) suppressClick = false;
        // 节点自己捕获指针，轻点仍能触发折叠；手势结束后不把点击改派到卡片。
        const capture = e.target.closest('[data-mindmap-node]') || card;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, capture });
        if (pointers.size > 1) suppressClick = true;
        capture.setPointerCapture(e.pointerId);
        beginGesture();
        card.classList.add('cms-svg-dragging');
        e.preventDefault();
    });
    card.addEventListener('pointermove', e => {
        const pointer = pointers.get(e.pointerId);
        if (!pointer || !gesture) return;
        pointer.x = e.clientX;
        pointer.y = e.clientY;
        if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > 3) suppressClick = true;
        const sample = sampleGesture();
        // 固定两指起始中心对应的图内坐标，同时根据间距缩放、根据中心位移平移。
        transformView(sample.x, sample.y, gesture.zoom * sample.distance / gesture.distance, gesture.anchor);
        e.preventDefault();
    });
    const endGesture = e => {
        const pointer = pointers.get(e.pointerId);
        if (!pointer) return;
        pointers.delete(e.pointerId);
        // 一指与双指切换时重新确定锚点，避免视口跳动。
        beginGesture();
        card.classList.toggle('cms-svg-dragging', pointers.size > 0);
        if (pointer.capture.hasPointerCapture(e.pointerId)) pointer.capture.releasePointerCapture(e.pointerId);
    };
    card.addEventListener('pointerup', endGesture);
    card.addEventListener('pointercancel', endGesture);
    card.addEventListener('lostpointercapture', endGesture);
    card.addEventListener('click', e => {
        // 键盘和程序化点击不属于手势结束后派生的点击，继续正常响应。
        if (!suppressClick || e.detail === 0 || isControl(e.target)) return;
        suppressClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);
    card.addEventListener('wheel', e => {
        if (pointers.size || isControl(e.target)) return;
        e.preventDefault();
        const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? card.clientHeight : 1);
        transformView(e.clientX, e.clientY, zoom * Math.exp(-delta * 0.0015));
    }, { passive: false });
    return resizeViewport;
}

export function mountDiagramFullscreenButton(diagramEl) {
    if (!diagramEl || !diagramEl.isConnected || diagramEl.tagName === 'CODE' || diagramEl.querySelector('.cms-diagram-fs-btn')) return;
    // Renderers replace their content asynchronously. Wait until their source has
    // been consumed so the button survives and cannot enter the diagram source.
    if (diagramEl.getAttribute('data-processed') !== 'true') return;
    diagramEl.classList.add('cms-diagram-card');
    const svg = diagramEl.querySelector(':scope > svg');
    let resizeSvgViewport;
    if (svg) {
        _prepareSvgDiagramViewport(svg);
        resizeSvgViewport = _mountSvgDiagramInteraction(diagramEl, svg);
    }
    diagramEl.style.position = 'relative';

    const btn = document.createElement('button');
    btn.className = 'cms-diagram-fs-btn';
    btn.type = 'button';
    btn.setAttribute('title', '全屏查看');
    btn.setAttribute('aria-label', '全屏查看');
    btn.innerHTML = '<img src="ui/full-screen.svg?v=3" alt="全屏" class="cms-diagram-fs-icon">';

    let placeholder = null;
    let portal = null;
    let resizeFrame = 0;
    let cardObserver = null;
    diagramEl.__disposeDiagramDOM?.();
    const resizeChart = () => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
            if (!diagramEl.isConnected) return;
            resizeSvgViewport?.();
            // Only resize: keep zoom, pan and collapsed nodes instead of rebuilding the tree.
            // Use the owning instance even if another script load replaced the global registry.
            const chart = diagramEl.__diagramChart || window.echarts?.getInstanceByDom(diagramEl);
            if (!chart || chart.isDisposed()) return;
            const style = getComputedStyle(diagramEl);
            const width = diagramEl.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
            const height = diagramEl.clientHeight - parseFloat(style.paddingTop || 0) - parseFloat(style.paddingBottom || 0);
            if (width > 0 && height > 0) {
                resizeDiagramChart(chart, width, height);
            }
        });
    };
    const updateButton = (active) => {
        btn.title = active ? '退出全屏' : '全屏查看';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', String(active));
        btn.querySelector('img').src = active ? 'ui/exit-fullscreen.svg?v=3' : 'ui/full-screen.svg?v=3';
    };
    const exitFullscreen = () => {
        if (!portal) return;

        diagramEl.classList.remove('cms-diagram-card--fullscreen');
        if (placeholder?.parentNode) placeholder.replaceWith(diagramEl);
        else diagramEl.remove();
        portal.remove();
        portal = null;
        placeholder = null;
        document.body.classList.remove('cms-diagram-fs-open');
        _exitDiagramFullscreen = null;
        updateButton(false);
        resizeChart();
        if (btn.isConnected) btn.focus({ preventScroll: true });
    };
    updateButton(false);
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (portal) {
            exitFullscreen();
            return;
        }
        _exitDiagramFullscreen?.();
        placeholder = document.createElement('div');
        placeholder.style.height = `${diagramEl.getBoundingClientRect().height}px`;
        placeholder.style.margin = getComputedStyle(diagramEl).margin;
        diagramEl.before(placeholder);
        portal = document.createElement('div');
        portal.className = 'cms-diagram-fs-layer';
        if (diagramEl.closest('.light-mode')) portal.classList.add('light-mode');
        document.body.appendChild(portal);
        portal.appendChild(diagramEl);
        diagramEl.classList.add('cms-diagram-card--fullscreen');
        document.body.classList.add('cms-diagram-fs-open');
        _exitDiagramFullscreen = exitFullscreen;
        updateButton(true);

        resizeChart();
        btn.focus({ preventScroll: true });
    });

    diagramEl.appendChild(btn);
    // 同时响应源码抽屉、目录与全屏的尺寸变化；销毁正文时一并释放监听。
    if (typeof ResizeObserver !== 'undefined') {
        cardObserver = new ResizeObserver(resizeChart);
        cardObserver.observe(diagramEl);
    } else window.addEventListener('resize', resizeChart);
    diagramEl.__disposeDiagramDOM = () => {
        if (portal) exitFullscreen();
        cardObserver?.disconnect();
        window.removeEventListener('resize', resizeChart);
        cancelAnimationFrame(resizeFrame);
        delete diagramEl.__disposeDiagramDOM;
    };

    if (typeof window !== 'undefined' && !window.__diagramFsEscBound) {
        window.__diagramFsEscBound = true;
        window.addEventListener('keydown', (evt) => {
            if (evt.key === 'Escape') {
                _exitDiagramFullscreen?.();
            }
        });
    }
}

if (typeof window !== 'undefined') {
    window.__mountDiagramFsBtn = mountDiagramFullscreenButton;
}

export function exitReaderDiagramFullscreen() {
    _exitDiagramFullscreen?.();
}

/** 释放即将被替换的图表，避免画布实例继续持有旧 DOM。 */
export function disposeReaderDiagrams(container) {
    exitReaderDiagramFullscreen();
    if (!container) return;
    const selector = '.cms-diagram-card, .language-mindmap, .language-markmap, .language-echarts';
    const diagrams = [...(container.matches?.(selector) ? [container] : []), ...container.querySelectorAll(selector)];
    diagrams.forEach(el => {
        el.__disposeDiagramDOM?.();
        const chart = el.__diagramChart || window.echarts?.getInstanceByDom(el);
        if (chart && !chart.isDisposed()) chart.dispose();
        delete el.__diagramChart;
    });
}
