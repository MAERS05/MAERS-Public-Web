/** 导图浏览器回归：几何边界、缩放、触摸、折叠动画及全屏视口保持。 */
import { test, expect } from './fixtures.mjs';

function diagramMarkdown() {
    const lines = ['- 导图测试'];
    for (let index = 0; index < 6; index++) {
        lines.push('  - 模块 ' + index);
        for (let step = 0; step < 7; step++) lines.push('    - ' + (step === 1
            ? '自动换行的长节点，需要按文字实际边界避让。'.repeat(3) : '步骤 ' + step));
    }
    lines.push('  - 手动<br>换行\\n继续');
    return ['mindmap', 'markmap', 'mindmap-both'].map(type => '```' + type + '\n' + lines.join('\n') + '\n```').join('\n\n');
}

function viewport(svg) {
    return svg.evaluate(element => {
        const matrix = element.getScreenCTM(), frame = element.getBoundingClientRect();
        return { scale: matrix.a, x: (frame.x + frame.width / 2 - matrix.e) / matrix.a,
            y: (frame.y + frame.height / 2 - matrix.f) / matrix.d };
    });
}

async function expectViewport(svg, before) {
    await expect.poll(async () => {
        const after = await viewport(svg);
        return Math.max(...Object.keys(before).map(key => Math.abs(before[key] - after[key])));
    }).toBeLessThan(0.001);
}

async function expectGeometry(svg, fit = false) {
    const result = await svg.evaluate(element => {
        const boxes = [...element.querySelectorAll('[data-mindmap-node] > rect')]
            .map(rect => rect.getBoundingClientRect().toJSON());
        const frame = element.getBoundingClientRect();
        return { count: boxes.length, edges: element.querySelectorAll('path').length,
            overlap: boxes.some((box, index) => boxes.slice(index + 1).some(other =>
                box.x < other.right && other.x < box.right && box.y < other.bottom && other.y < box.bottom)),
            fits: boxes.every(box => box.x >= frame.x - 1 && box.right <= frame.right + 1
                && box.y >= frame.y - 1 && box.bottom <= frame.bottom + 1) };
    });
    expect(result.overlap).toBe(false);
    expect(result.edges).toBe(result.count - 1);
    if (fit) expect(result.fits).toBe(true);
}

async function expectRootToggle(svg, root) {
    await root.tap();
    await expect(svg.locator('[data-mindmap-node]')).toHaveCount(1);
    await root.tap();
    await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
    await expect(svg).not.toHaveAttribute('data-mindmap-animating', 'true');
}

async function expectPinchAndPan(send, svg, root) {
    const rect = await root.locator('rect').boundingBox();
    let points = [{ id: 1, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }];
    points.push({ id: 2, x: points[0].x + 60, y: points[0].y });
    const before = await viewport(svg);
    await send('touchStart', points);
    const beforePinch = await svg.getAttribute('viewBox');
    points = points.map((point, index) => ({ ...point, x: point.x + (index ? 24 : -12), y: point.y + 12 }));
    await send('touchMove', points);
    await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(beforePinch);
    expect((await viewport(svg)).scale / before.scale).toBeCloseTo(1.6, 1);
    const scaled = await viewport(svg);
    const beforePan = await svg.getAttribute('viewBox');
    points = points.map(point => ({ ...point, x: point.x + 12, y: point.y + 8 }));
    await send('touchMove', points);
    await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(beforePan);
    const panned = await viewport(svg);
    expect(panned.scale).toBeCloseTo(scaled.scale, 5);
    expect((scaled.x - panned.x) * scaled.scale).toBeCloseTo(12, 1);
    expect((scaled.y - panned.y) * scaled.scale).toBeCloseTo(8, 1);
    return { points, panned };
}

async function expectOneFingerContinuation(send, svg, gesture) {
    const { points, panned } = gesture;
    await send('touchEnd', points.slice(1));
    expect((await viewport(svg)).scale).toBeCloseTo(panned.scale, 5);
    const before = await svg.getAttribute('viewBox');
    await send('touchMove', [{ ...points[0], x: points[0].x + 10, y: points[0].y + 6 }]);
    await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(before);
    expect((panned.x - (await viewport(svg)).x) * panned.scale).toBeCloseTo(10, 1);
    await send('touchEnd', []);
}

async function expectTouchGestures(page, svg, card) {
    const touch = await page.context().newCDPSession(page);
    const send = (type, touchPoints) => touch.send('Input.dispatchTouchEvent', { type, touchPoints });
    try {
        const root = svg.locator('[role="button"][aria-label="导图测试"]');
        await expectRootToggle(svg, root);
        // 从可折叠节点开始双指缩放，再平移并切回单指拖动，避免误触折叠。
        const gesture = await expectPinchAndPan(send, svg, root);
        await expectOneFingerContinuation(send, svg, gesture);
        await expect(root).toHaveAttribute('aria-expanded', 'true');
        await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
        await expect(card).not.toHaveClass(/cms-svg-dragging/);
    } finally {
        await touch.detach();
    }
}

async function expectWheelZoom(page, svg) {
    const frame = await svg.boundingBox();
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
    for (const delta of [300, -600, 300]) {
        const before = await svg.getAttribute('viewBox');
        await page.mouse.wheel(0, delta);
        await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(before);
        await expectGeometry(svg);
    }
}

async function expectCollapseMotion(svg) {
    const branch = svg.locator('[role="button"][aria-label="模块 2"]');
    const motion = await branch.evaluate(async element => {
        const svg = element.ownerSVGElement;
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const active = svg.hasAttribute('data-mindmap-animating');
        const before = [...svg.querySelectorAll('path')].map(path => path.getAttribute('d'));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { active, moving: [...svg.querySelectorAll('path')].some((path, index) => path.getAttribute('d') !== before[index]),
            ghost: [...svg.querySelectorAll('[data-mindmap-node], path')].some(node => getComputedStyle(node).opacity !== '1') };
    });
    expect(motion).toEqual({ active: true, moving: true, ghost: false });
    await expect(svg.locator('[data-mindmap-node]')).toHaveCount(43);
    await expectGeometry(svg);
    await branch.focus();
    await branch.press('Enter');
    await expect(svg).not.toHaveAttribute('data-mindmap-animating', 'true');
    await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
    await expect(branch).toBeFocused();
    await expectGeometry(svg);
    await branch.evaluate(element => {
        const svg = element.ownerSVGElement;
        for (let index = 0; index < 2; index++) svg.querySelector('[aria-label="模块 2"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(svg).not.toHaveAttribute('data-mindmap-animating', 'true');
    await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
    await expectGeometry(svg);
}

async function inspectDiagram({ page, type, isMobile }) {
    const card = page.locator('.language-' + type).filter({ has: page.locator('svg[data-mindmap-direction="LR"]') });
    const svg = card.locator(':scope > svg');
    await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
    await expect(card).toHaveClass(/cms-svg-interactive/);
    const inlineView = await viewport(svg);
    await card.locator('.cms-diagram-fs-btn').click();
    await expectViewport(svg, inlineView);
    await expectGeometry(svg, true);
    if (isMobile) await expectTouchGestures(page, svg, card);
    await expectWheelZoom(page, svg);
    await expectCollapseMotion(svg);
    const beforeClose = await viewport(svg);
    await page.keyboard.press('Escape');
    await expect(card).not.toHaveClass(/cms-diagram-card--fullscreen/);
    await expectViewport(svg, beforeClose);
    expect(await card.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(420);
    await expectGeometry(svg);
}

async function inspectBidirectionalDiagram(page) {
    const bothCard = page.locator('.language-mindmap').filter({ has: page.locator('svg[data-mindmap-direction="both"]') });
    const bothSvg = bothCard.locator(':scope > svg');
    await expect(bothSvg.locator('[data-mindmap-node]')).toHaveCount(50);
    await expectGeometry(bothSvg);
    const sides = await bothSvg.evaluate(svg => {
        const root = svg.querySelector('[data-mindmap-side="center"] > rect').getBoundingClientRect();
        const rights = [...svg.querySelectorAll('[data-mindmap-side="right"] > rect')].map(r => r.getBoundingClientRect());
        const lefts = [...svg.querySelectorAll('[data-mindmap-side="left"] > rect')].map(r => r.getBoundingClientRect());
        return {
            hasRight: rights.length > 0,
            hasLeft: lefts.length > 0,
            total: rights.length + lefts.length + 1,
            allRightOfRoot: rights.every(box => box.left > root.right),
            allLeftOfRoot: lefts.every(box => box.right < root.left)
        };
    });
    expect(sides).toEqual({ hasRight: true, hasLeft: true, total: 50, allRightOfRoot: true, allLeftOfRoot: true });
    await expectCollapseMotion(bothSvg);
}

test('密集思维导图紧凑适配，缩放与折叠不重叠、不丢节点连线', async ({ page, isMobile, pageErrors }) => {
    await page.route('**/markdown/notes/browser.md*', route => route.fulfill({
        status: 200, contentType: 'text/markdown; charset=utf-8', body: diagramMarkdown()
    }));
    await page.goto('/notes.html?openNoteId=browser-note');
    for (const type of ['mindmap', 'markmap']) {
        await test.step(type, () => inspectDiagram({ page, type, isMobile }));
    }
    await test.step('mindmap-both', () => inspectBidirectionalDiagram(page));
    expect(pageErrors).toEqual([]);
});

test('Mindmap 和 Markmap 原生层数配置兼容单向与双向，手动收展仍生效', async ({ page, pageErrors }) => {
    const tree = ['- 应用', '  - 国内', '    - 音乐', '      - 播放器',
        '  - 国外', '    - 工具', '      - 编辑器'].join('\n');
    const cases = ['mindmap', 'markmap', 'mindmap-both', 'markmap-both'].flatMap(type =>
        [1, 0, -1].map(level => ({ type, level })));
    const body = cases.map(({ type, level }) => {
        const config = type.startsWith('mindmap') ? 'initialTreeDepth: ' + level
            : 'markmap:\n  initialExpandLevel: ' + level;
        return '```' + type + '\n---\n' + config + '\n---\n' + tree + '\n```';
    }).join('\n\n');
    await page.route('**/markdown/notes/browser.md*', route => route.fulfill({ status: 200,
        contentType: 'text/markdown; charset=utf-8', body }));
    await page.goto('/notes.html?openNoteId=browser-note');
    const diagrams = page.locator('svg[data-mindmap]');
    await expect(diagrams).toHaveCount(cases.length);
    for (const [index, { type, level }] of cases.entries()) {
        const svg = diagrams.nth(index);
        await expect(svg).toHaveAttribute('data-mindmap-direction', type.endsWith('-both') ? 'both' : 'LR');
        await expect(svg.locator('[data-mindmap-node]')).toHaveCount(level < 0 ? 7 : level === 0 ? 1 : 3);
        if (level !== 1) continue;
        const domestic = svg.locator('[aria-label="国内"]'), foreign = svg.locator('[aria-label="国外"]');
        await expect(domestic).toHaveAttribute('aria-expanded', 'false');
        await domestic.locator('circle').click();
        await expect(svg).not.toHaveAttribute('data-mindmap-animating', 'true');
        await expect(svg.locator('[data-mindmap-node]')).toHaveCount(4);
        await expect(foreign).toHaveAttribute('aria-expanded', 'false');
    }
    expect(pageErrors).toEqual([]);
});

test('Mermaid 组织架构复用导图收展，普通流程图保留语义', async ({ page, pageErrors }) => {
    const tree = ['flowchart TB', 'root["账号"] --> mail["邮箱"]', 'root --> phone["手机号"]'];
    for (let index = 0; index < 5; index++) tree.push(`mail --> mail${index}["工作邮箱与日常关联账号 ${index}"]`);
    tree.push('phone --> mobile["13800000000（生活且不对外提供）"]');
    const body = '```mermaid\n' + tree.join('\n') + '\n```\n\n```mermaid\nflowchart TB\nA[开始] --> B{是否继续}\nB -->|是| C[结束]\n```';
    await page.route('**/markdown/notes/browser.md*', route => route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body }));
    await page.goto('/notes.html?openNoteId=browser-note');
    const card = page.locator('.language-mermaid').filter({ has: page.locator('svg[data-mindmap]') });
    const svg = card.locator('svg[data-mindmap]');
    await expect(svg.locator('[data-mindmap-node]')).toHaveCount(3, { timeout: 20000 });
    await svg.locator('[aria-label="邮箱"]').locator('circle').click();
    await expect(svg).not.toHaveAttribute('data-mindmap-animating', 'true');
    await expect(svg.locator('[data-mindmap-node]')).toHaveCount(8);
    await expectGeometry(svg);
    await expect(svg.locator('marker')).toHaveCount(0);
    await svg.locator('[aria-label="邮箱"]').focus();
    await svg.locator('[aria-label="邮箱"]').press('Enter');
    await expect(svg.locator('[data-mindmap-node]')).toHaveCount(3);
    await expect(svg).not.toHaveAttribute('data-mindmap-animating', 'true');
    const before = await viewport(svg);
    await card.locator('.cms-diagram-fs-btn').click();
    await expectViewport(svg, before);
    await expectWheelZoom(page, svg);
    await page.keyboard.press('Escape');
    const flowchart = page.locator('.language-mermaid').nth(1);
    await expect(flowchart.locator('svg')).toHaveCount(1);
    await expect(flowchart.locator('[data-mindmap-node]')).toHaveCount(0);
    await expect(flowchart).toContainText('是否继续');
    expect(pageErrors).toEqual([]);
});

test('ECharts 宽节点避让，缩放平移后进出全屏保持节点位置', async ({ page, pageErrors }) => {
    const categories = Array.from({ length: 5 }, (_, index) => ({ name: `1380000000${index}（生活且不对外提供）`,
        children: Array.from({ length: 4 }, (_, item) => ({ name: `关联应用 ${index}-${item}` })) }));
    const option = { animation: false, series: [{ type: 'tree', orient: 'TB', edgeShape: 'polyline', roam: true,
        left: '8%', right: '8%', top: 45, bottom: 60, emphasis: { disabled: true },
        symbol: 'roundRect', symbolSize: [240, 34], initialTreeDepth: 1, expandAndCollapse: true,
        label: { position: 'inside', width: 224, overflow: 'truncate', fontSize: 12 },
        data: [{ name: '账号', children: [{ name: '邮箱', children: categories }, { name: '手机号' }, { name: '其他' }] }] }] };
    const body = '```echarts\n' + JSON.stringify(option) + '\n```';
    await page.route('**/markdown/notes/browser.md*', route => route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body }));
    await page.goto('/notes.html?openNoteId=browser-note');
    const card = page.locator('.language-echarts');
    await card.waitFor({ state: 'attached', timeout: 20000 });
    await expect.poll(() => card.evaluate(element => !!element.__diagramChart), { timeout: 20000 }).toBe(true);
    const positions = () => card.evaluate(element => {
        const chart = element.__diagramChart;
        const series = chart.getModel().getSeriesByIndex(0), data = series.getData();
        const nodes = [];
        data.eachItemGraphicEl((graphic, index) => {
            if (!graphic.__zr) return;
            const matrix = graphic.getComputedTransform();
            const box = graphic.getBoundingRect().clone();
            box.applyTransform(matrix);
            nodes.push({ id: data.getId(index), x: matrix[4] - chart.getWidth() / 2,
                y: matrix[5] - chart.getHeight() / 2, width: box.width, height: box.height });
        });
        return { zoom: series.coordinateSystem.getZoom(), nodes };
    });
    const expectPositions = async before => {
        await expect.poll(async () => {
            const after = await positions();
            if (after.nodes.length !== before.nodes.length || after.nodes.some((node, i) => node.id !== before.nodes[i].id))
                return Infinity;
            return Math.max(Math.abs(after.zoom - before.zoom), ...after.nodes.flatMap((node, i) =>
                ['x', 'y', 'width', 'height'].map(key => Math.abs(node[key] - before.nodes[i][key]))));
        }).toBeLessThan(0.01);
    };
    const overlap = () => card.evaluate(element => {
        const chart = element.__diagramChart;
        const data = chart.getModel().getSeriesByIndex(0).getData();
        const boxes = [];
        data.eachItemGraphicEl(graphic => {
            if (!graphic.__zr) return;
            const box = graphic.getBoundingRect().clone();
            box.applyTransform(graphic.getComputedTransform());
            boxes.push(box);
        });
        return boxes.some((box, index) => boxes.slice(index + 1).some(other =>
            box.x < other.x + other.width - 1 && other.x < box.x + box.width - 1 &&
            box.y < other.y + other.height - 1 && other.y < box.y + box.height - 1));
    });
    const nodePosition = index => card.evaluate((element, index) => {
        const chart = element.__diagramChart, series = chart.getModel().getSeriesByIndex(0);
        const matrix = series.getData().getItemGraphicEl(index).getComputedTransform();
        return [matrix[4], matrix[5], series.coordinateSystem.getZoom()];
    }, index);
    const toggleBranch = async index => {
        const before = await nodePosition(index);
        await card.evaluate((element, index) => element.__diagramChart.dispatchAction({
            type: 'treeExpandAndCollapse', seriesIndex: 0, dataIndex: index
        }), index);
        await expect.poll(async () => Math.max(...(await nodePosition(index))
            .map((value, i) => Math.abs(value - before[i])))).toBeLessThan(0.01);
    };
    expect(await overlap()).toBe(false);
    await toggleBranch(2);
    await toggleBranch(3);
    expect(await overlap()).toBe(false);
    const beforeOpen = await positions();
    await card.locator('.cms-diagram-fs-btn').click();
    await expectPositions(beforeOpen);
    await expect.poll(overlap).toBe(false);
    const origin = await card.evaluate(element => {
        const chart = element.__diagramChart;
        const data = chart.getModel().getSeriesByIndex(0).getData();
        const root = data.tree.root.children[0];
        const matrix = data.getItemGraphicEl(root.dataIndex).getComputedTransform();
        const frame = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { x: frame.x + parseFloat(style.paddingLeft) + matrix[4],
            y: frame.y + parseFloat(style.paddingTop) + matrix[5] };
    });
    await page.mouse.move(origin.x, origin.y);
    for (let step = 0; step < 10; step++) {
        const zoom = (await positions()).zoom;
        await page.mouse.wheel(0, 160);
        await expect.poll(async () => (await positions()).zoom).toBeLessThan(zoom);
    }
    expect(await overlap()).toBe(false);
    await toggleBranch(3);
    await toggleBranch(3);
    await toggleBranch(2);
    await toggleBranch(2);
    await expect.poll(overlap).toBe(false);
    const beforeClose = await positions();
    await page.keyboard.press('Escape');
    await expectPositions(beforeClose);
    await expect.poll(overlap).toBe(false);
    await card.locator('.cms-diagram-fs-btn').click();
    await expectPositions(beforeClose);
    await card.locator('.cms-diagram-fs-btn').click();
    await expectPositions(beforeClose);
    expect(pageErrors).toEqual([]);
});
