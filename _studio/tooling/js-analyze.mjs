/** Acorn 语法分析桥：批量解析源码，返回规则计数、导入与导出。 */
import { parse } from 'acorn';
import fs from 'node:fs';

function maskRanges(source, ranges) {
    const chars = source.split('');
    for (const [start, end] of ranges) {
        for (let index = start; index < end; index++) {
            if (chars[index] !== '\n') chars[index] = ' ';
        }
    }
    return chars.join('');
}

function memberName(node) {
    if (node?.type === 'Identifier') return node.name;
    if (node?.type === 'Literal') return node.value;
    return null;
}

function collectBinding(node, names) {
    if (!node) return;
    switch (node.type) {
        case 'Identifier':
            names.push(node.name);
            break;
        case 'ObjectPattern':
            node.properties.forEach(property => collectBinding(property.value || property.argument, names));
            break;
        case 'ArrayPattern':
            node.elements.forEach(element => collectBinding(element, names));
            break;
        default:
            collectBinding(node.argument || node.left, names);
    }
}

function countCall(callee, counts) {
    if (callee.type === 'Identifier' && callee.name === 'alert') counts.alert++;
    if (callee.type !== 'MemberExpression') return;
    const object = memberName(callee.object);
    const property = memberName(callee.property);
    if (object === 'console' && property === 'log') counts.console++;
    if (['window', 'globalThis'].includes(object) && property === 'alert') counts.alert++;
}

function collectModuleReferences(node, result) {
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
        result.imports.push(node.source.value);
    }
    if (node.type === 'ImportExpression' && typeof node.source.value === 'string') {
        result.imports.push(node.source.value);
    }
    if (node.type === 'ExportDefaultDeclaration') result.exports.push('default');
    if (node.type === 'ExportAllDeclaration') {
        if (node.exported) result.exports.push(memberName(node.exported));
        else result.stars.push(node.source.value);
    }
    if (node.type !== 'ExportNamedDeclaration') return;
    node.specifiers.forEach(specifier => result.exports.push(memberName(specifier.exported)));
    if (node.declaration?.type === 'VariableDeclaration') {
        node.declaration.declarations.forEach(declaration => collectBinding(declaration.id, result.exports));
    } else if (node.declaration?.id) {
        collectBinding(node.declaration.id, result.exports);
    }
}

function walkAst(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => walkAst(child, visit));
        else if (value && typeof value === 'object') walkAst(value, visit);
    }
}

function analyze(source) {
    const comments = [];
    const ast = parse(source, {
        ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true,
        onComment: (_, text, start, end) => comments.push([start, end])
    });
    const result = { counts: { debugger: 0, var: 0, console: 0, alert: 0 }, imports: [], exports: [], stars: [] };
    const literals = [...comments];
    walkAst(ast, node => {
        if (node.type === 'DebuggerStatement') result.counts.debugger++;
        if (node.type === 'VariableDeclaration' && node.kind === 'var') result.counts.var++;
        if (node.type === 'Literal' || node.type === 'TemplateElement') literals.push([node.start, node.end]);
        if (node.type === 'CallExpression') countCall(node.callee, result.counts);
        collectModuleReferences(node, result);
    });
    result.clean = maskRanges(source, comments);
    result.code = maskRanges(source, literals);
    return result;
}

const sources = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(sources.map(analyze)));
