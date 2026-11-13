/** 正文刷新时按源码和主题复用图表节点，保留画布实例及其交互状态。 */
(container, html) => {
    container.__disposeDeferredDiagrams?.();
    const savedDiagrams = new Map();
    const theme = container.ownerDocument?.documentElement?.classList.contains('light-mode') ? 'light' : 'dark';
    const previousTheme = container.getAttribute('data-preview-theme');
    if (previousTheme === null || previousTheme === theme) {
        for (const diagram of container.querySelectorAll('[data-processed="true"][data-diagram-sig]')) {
            if (diagram.__diagramChart?.isDisposed()) continue;
            const signature = diagram.getAttribute('data-diagram-sig');
            const matchingDiagrams = savedDiagrams.get(signature) ?? [];
            matchingDiagrams.push(diagram);
            savedDiagrams.set(signature, matchingDiagrams);
        }
    }
    container.setAttribute('data-preview-theme', theme);

    container.innerHTML = html;
    if (!savedDiagrams.size) return;

    const types = ['mindmap', 'markmap', 'mermaid', 'echarts', 'flowchart', 'graphviz'];
    const selector = types.map(type => `.language-${type}`).join(', ');
    for (const placeholder of container.querySelectorAll(selector)) {
        const type = types.find(type => placeholder.classList.contains(`language-${type}`));
        const source = (placeholder.textContent || '').trim() || placeholder.getAttribute('data-code') || '';
        const signature = `${type}:${source}`;
        const matchingDiagrams = savedDiagrams.get(signature);
        if (matchingDiagrams?.length) {
            placeholder.closest('pre')?.classList.add('cms-diagram-pre');
            placeholder.replaceWith(matchingDiagrams.shift());
        }
    }
};
