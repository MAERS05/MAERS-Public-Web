/** Acorn 语法分析桥：批量解析源码，返回规则计数、导入与导出。 */
import { parse } from 'acorn';
import fs from 'node:fs';
function analyze(source) {
    const comments = [];
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true,
        onComment: (_, text, start, end) => comments.push([start, end]) });
    const result = { counts: { debugger: 0, var: 0, console: 0, alert: 0 }, imports: [], exports: [], stars: [] };
    const erase = ranges => {
        const chars = source.split('');
        for (const [start, end] of ranges) for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' ';
        return chars.join('');
    };
    result.clean = erase(comments);
    const literals = [...comments];
    const member = n => n?.type === 'Identifier' ? n.name : n?.type === 'Literal' ? n.value : null;
    const binding = n => {
        if (!n) return;
        if (n.type === 'Identifier') result.exports.push(n.name);
        else if (n.type === 'ObjectPattern') n.properties.forEach(p => binding(p.value || p.argument));
        else if (n.type === 'ArrayPattern') n.elements.forEach(binding);
        else binding(n.argument || n.left);
    };
    function visit(n) {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'DebuggerStatement') result.counts.debugger++;
        if (n.type === 'VariableDeclaration' && n.kind === 'var') result.counts.var++;
        if (n.type === 'Literal' || n.type === 'TemplateElement') literals.push([n.start, n.end]);
        if (n.type === 'CallExpression') {
            const callee = n.callee;
            if (callee.type === 'Identifier' && callee.name === 'alert') result.counts.alert++;
            if (callee.type === 'MemberExpression') {
                if (member(callee.object) === 'console' && member(callee.property) === 'log') result.counts.console++;
                if (['window', 'globalThis'].includes(member(callee.object)) && member(callee.property) === 'alert') result.counts.alert++;
            }
        }
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(n.type) && n.source) result.imports.push(n.source.value);
        if (n.type === 'ImportExpression' && typeof n.source.value === 'string') result.imports.push(n.source.value);
        if (n.type === 'ExportDefaultDeclaration') result.exports.push('default');
        if (n.type === 'ExportAllDeclaration') {
            if (n.exported) result.exports.push(member(n.exported));
            else result.stars.push(n.source.value);
        }
        if (n.type === 'ExportNamedDeclaration') {
            n.specifiers.forEach(s => result.exports.push(member(s.exported)));
            if (n.declaration?.type === 'VariableDeclaration') n.declaration.declarations.forEach(d => binding(d.id));
            else if (n.declaration?.id) binding(n.declaration.id);
        }
        for (const value of Object.values(n)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
    }
    visit(ast); result.code = erase(literals);
    return result;
}
const sources = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(sources.map(analyze)));
