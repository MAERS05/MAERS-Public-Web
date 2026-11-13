/** CodeMirror 的固定构建入口，页面只按需加载这一个本地模块。 */
export { basicSetup, EditorView } from 'codemirror';
export { keymap } from '@codemirror/view';
export { indentWithTab } from '@codemirror/commands';
export { markdown } from '@codemirror/lang-markdown';
export { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
export { tags } from '@lezer/highlight';
