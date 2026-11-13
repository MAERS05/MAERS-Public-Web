/** CodeMirror 源码模型：按需挂载、事务式插入、行位置与销毁；正文不经过 HTML。 */
const loadEditor = () => import('../../../plugins/ui-components/editor.module.js');

export class MarkdownSource {
    constructor(host, text, load = loadEditor) {
        this.host = host;
        this.text = String(text || '').replace(/\r\n?/g, '\n');
        this.load = load;
        this.view = null;
        this.pending = null;
        this.disposed = false;
    }

    get value() {
        if (this.text === null) this.text = this.view.state.doc.toString();
        return this.text;
    }
    set value(text) {
        const next = String(text).replace(/\r\n?/g, '\n');
        if (next === this.value) return;
        this.silent = true;
        try {
            if (this.view) this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: next } });
            this.text = next;
        } finally { this.silent = false; }
    }
    get selectionStart() { return this.view?.state.selection.main.from ?? this.value.length; }
    get selectionEnd() { return this.view?.state.selection.main.to ?? this.value.length; }
    get scrollElement() { return this.view?.scrollDOM; }
    get isConnected() { return !this.disposed && this.host.isConnected; }

    async mount() {
        if (this.view || this.disposed) return;
        if (this.pending) return this.pending;
        this.host.setAttribute('aria-busy', 'true');
        this.pending = this.load().then(({ EditorView, basicSetup, markdown, keymap, indentWithTab, syntaxHighlighting, HighlightStyle, tags }) => {
            if (!this.isConnected) return;
            const highlight = HighlightStyle.define([
                { tag: tags.heading, color: 'var(--accent-color, #56b6c2)', fontWeight: 'bold' },
                { tag: [tags.emphasis, tags.strong], color: 'var(--text-main)' },
                { tag: [tags.link, tags.url], color: 'var(--accent-color, #56b6c2)' },
                { tag: [tags.comment, tags.meta], color: 'var(--text-sub, #89939e)' },
                { tag: [tags.string, tags.contentSeparator], color: 'var(--accent-color, #56b6c2)' }
            ]);
            this.view = new EditorView({ parent: this.host, doc: this.value,
                extensions: [basicSetup, markdown(), keymap.of([indentWithTab]), EditorView.lineWrapping,
                    syntaxHighlighting(highlight), EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码', spellcheck: 'false' }),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) {
                            this.text = null;
                            if (!this.silent) this.host.dispatchEvent(new Event('sourcechange'));
                        }
                        if (update.geometryChanged || update.viewportChanged) this.host.dispatchEvent(new Event('sourcelayout'));
                    })] });
        }).finally(() => { this.pending = null; this.host.removeAttribute('aria-busy'); });
        return this.pending;
    }

    replace(from, to, text) {
        if (this.view) this.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
        else {
            this.text = this.value.slice(0, from) + text + this.value.slice(to);
            this.host.dispatchEvent(new Event('sourcechange'));
        }
    }
    replaceText(find, replacement) {
        const index = this.value.indexOf(find);
        if (index < 0) return;
        // 不指定 selection，上传期间用户移动过的光标由 CodeMirror 事务映射。
        if (this.view) this.view.dispatch({ changes: { from: index, to: index + find.length, insert: replacement } });
        else this.replace(index, index + find.length, replacement);
    }
    setSelectionRange(start, end) {
        this.view?.dispatch({ selection: { anchor: start, head: end } });
    }
    focus() { this.view?.focus(); }
    lineTop(line) {
        if (!this.view) return 0;
        const doc = this.view.state.doc;
        if (line >= doc.lines) return this.scrollElement.scrollHeight;
        const position = doc.line(Math.max(1, Math.floor(line) + 1)).from;
        return this.view.lineBlockAt(position).top + this.view.documentPadding.top;
    }
    destroy() {
        this.disposed = true;
        this.view?.destroy(); this.view = null;
        this.text = '';
        this.host.replaceChildren?.();
    }
}
