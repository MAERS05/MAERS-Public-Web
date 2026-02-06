/**
 * MAERS Literature Viewer - Flowing Path Engine
 * 基于虚拟滚动优化的流动路径引擎
 * @version 3.0.0 - ES6 Module (Modularized)
 */

import { FlowEngine, setEditor } from './flow/literature-flow-engine.module.js';

// Dependency Injection
let Editor = null;

export function initLiteratureView(deps) {
    Editor = deps.Editor;
    setEditor(deps.Editor);
}

// View 对象
export const LiteratureView = {
    engine: null,

    async init() {
        const container = document.getElementById('path-container');
        if (!container) {
            console.warn('[MAERS.Literature.View] #path-container not found, creating...');
            this.createContainers();
        }

        this.engine = new FlowEngine();
        await this.engine.init();
    },

    setMode: function (mode) {
        if (this.engine) {
            this.engine.setMode(mode);
        }
    },

    createContainers: function () {
        const viewport = document.createElement('div');
        viewport.id = 'viewport';
        viewport.className = 'viewport gallery-mode';

        const pathContainer = document.createElement('div');
        pathContainer.id = 'path-container';
        pathContainer.className = 'path-container';

        viewport.appendChild(pathContainer);
        document.body.insertBefore(viewport, document.body.firstChild);
    },

    openNode: function (node) {
        if (this.engine) {
            this.engine.pauseAnimation();
            this.engine.viewport.style.display = 'none';
            if (Editor) Editor.open(node);
        }
    }
};
