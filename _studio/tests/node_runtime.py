# -*- coding: utf-8 -*-
"""
Node.js 运行时夹具：在 PROJECT_ROOT 下以原生 ESM 执行断言脚本。

未安装 Node.js 时失败，禁止将未执行的加密验证报告为通过。
"""

import shutil
import subprocess
import unittest

from .helpers import PROJECT_ROOT

NODE_BIN = shutil.which('node')

# 脚本以该标记结尾才视为执行完整（防止中途 return / 未捕获的 Promise 被误判为通过）
_OK_MARKER = '__MAERS_NODE_OK__'

# ---------- 可组合的浏览器环境 mock 片段 ----------

MOCK_KV = """
const memoryKV = () => {
    const entries = new Map();
    return {
        entries,
        async get(key, type) {
            const value = entries.get(key)?.value;
            return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
        },
        async getWithMetadata(key, type) {
            assert.equal(type, 'stream');
            const entry = entries.get(key);
            return entry ? {value: new Blob([entry.value]).stream(), metadata:entry.metadata} :
                {value:null, metadata:null};
        },
        async put(key, value, options) {
            assert.equal(options.expirationTtl, 30 * 24 * 60 * 60);
            entries.set(key, {value:typeof value === 'string' ? value : await new Response(value).arrayBuffer(),
                metadata:options.metadata});
        },
        async list({prefix, cursor, limit}) {
            const all = [...entries.keys()].filter(name=>name.startsWith(prefix)).sort();
            const start = Number(cursor || 0), end = start + limit;
            return {keys:all.slice(start,end).map(name=>({name, metadata:entries.get(name).metadata})),
                list_complete:end >= all.length, cursor:String(end)};
        },
        async delete(key) { entries.delete(key); }
    };
};
"""

MOCK_SESSION_STORAGE = """
const __ss = new Map();
globalThis.sessionStorage = {
    getItem: (k) => __ss.has(k) ? __ss.get(k) : null,
    setItem: (k, v) => __ss.set(k, String(v)),
    removeItem: (k) => __ss.delete(k)
};
"""

MOCK_LOCAL_STORAGE = """
const __ls = new Map();
globalThis.localStorage = {
    getItem: (k) => __ls.has(k) ? __ls.get(k) : null,
    setItem: (k, v) => __ls.set(k, String(v)),
    removeItem: (k) => __ls.delete(k)
};
"""

MOCK_DOM = """
const __mockEl = () => ({
    style: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    setAttribute(){}, removeAttribute(){},
    get firstElementChild(){ return __mockEl(); },
    appendChild(){}, remove(){}, addEventListener(){},
    querySelector(){ return __mockEl(); }
});
globalThis.document = {
    getElementById: () => null,
    createElement: () => __mockEl(),
    head: __mockEl(),
    body: __mockEl()
};
"""


# 保留父子关系及节点身份，验证原位渲染而非只检查输出字符串。
MOCK_TREE_DOM = MOCK_DOM + r"""
class Element {
    constructor(tag='div') {
        this.tagName=tag; this.children=[]; this.dataset={}; this.style={};
        this.attrs={}; this.className=''; this.listeners=new Map();
    }
    get classList() {
        const names=()=>new Set(this.className.split(' ').filter(Boolean));
        const toggle=(name,on)=>{
            const values=names(); if(on??!values.has(name))values.add(name); else values.delete(name);
            this.className=[...values].join(' '); return values.has(name);
        };
        return {contains:name=>names().has(name),toggle,
            add:(...values)=>values.forEach(name=>toggle(name,true)),
            remove:(...values)=>values.forEach(name=>toggle(name,false))};
    }
    set innerHTML(value) { for(const child of [...this.children])child.remove(); }
    get firstChild() { return this.children[0]; }
    get parentNode() { return this.parent || null; }
    appendChild(child) {
        if(child.tagName==='fragment')for(const item of [...child.children])this.appendChild(item);
        else { child.remove(); this.children.push(child); child.parent=this; }
        return child;
    }
    remove() {
        if(!this.parent)return;
        this.parent.children.splice(this.parent.children.indexOf(this),1); this.parent=null;
    }
    replaceWith(other) {
        const parent=this.parent,index=parent.children.indexOf(this); this.remove(); other.remove();
        parent.children.splice(index,0,other); other.parent=parent;
    }
    insertBefore(child,before) {
        child.remove(); const index=this.children.indexOf(before);
        this.children.splice(index<0?this.children.length:index,0,child); child.parent=this;
    }
    setAttribute(key,value) {
        this.attrs[key]=String(value); if(key==='data-src')this.dataset.src=String(value);
    }
    getAttribute(key) { return this.attrs[key]??null; }
    removeAttribute(key) { delete this.attrs[key]; if(key==='data-src')delete this.dataset.src; }
    querySelectorAll(selector) {
        return this.children.flatMap(child=>[
            ...(child.classList.contains(selector.slice(1))?[child]:[]),...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0]||null; }
    addEventListener(name,callback) { this.listeners.set(name,callback); }
}
const __domListeners=new Map();
document.addEventListener=(name,callback)=>{
    const callbacks=__domListeners.get(name)||[]; callbacks.push(callback); __domListeners.set(name,callbacks);
};
document.createElement=tag=>new Element(tag);
document.createDocumentFragment=()=>new Element('fragment');
"""


# 相同的真实主题模块配上可观察 DOM、动画帧及存储，避免各用例复制环境。
MOCK_THEME_RUNTIME = r"""
const __themeFs=await import('node:fs');
const __themeVm=await import('node:vm');
async function loadThemeFixture(configuration,theme='dark-mode') {
    const fixture={classes:new Set(theme==='light-mode'?['light-mode']:[]),frames:[],listeners:new Map(),
        metas:new Map(),values:new Map([['theme',theme],['autoThemeConfig',JSON.stringify(configuration)]]),
        checkbox:null,transitions:0};
    const {classes,frames,listeners,metas,values}=fixture;
    const context=__themeVm.createContext({console,setTimeout,clearTimeout,
        requestAnimationFrame:callback=>frames.push(callback),
        localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},
        document:{querySelector:()=>fixture.checkbox,getElementById:()=>null,
            createElement:()=>({name:'',content:''}),
            head:{querySelector:sel=>{const m=/meta\[name="([^"]+)"\]/.exec(sel);return m?metas.get(m[1])||null:null;},
                appendChild:el=>{if(el.name)metas.set(el.name,el);}},
            addEventListener:(name,callback)=>listeners.set(name,callback),
            documentElement:{offsetWidth:100,style:{removeProperty(){}},classList:{
                contains:name=>classes.has(name),add:name=>classes.add(name),
                remove:(...names)=>names.forEach(name=>classes.delete(name)),
                toggle:(name,on)=>on?classes.add(name):classes.delete(name)}},
            startViewTransition(callback){fixture.transitions++;callback();
                return {finished:Promise.resolve(),skipTransition(){}};}},
        window:{matchMedia:()=>({matches:false,addEventListener(){}})}
    });
    const module=new __themeVm.SourceTextModule(
        __themeFs.readFileSync('shared/theme/theme-core.module.js','utf8'),{context});
    await module.link(()=>{throw Error('主题核心不应有额外依赖');});
    await module.evaluate();
    fixture.core=module.namespace;
    fixture.flush=()=>{while(frames.length)frames.shift()();};
    return fixture;
}
"""


def mock_window(pathname, *, hostname='localhost', is_admin=None):
    """生成 globalThis.window mock 片段"""
    admin = '' if is_admin is None else f", IS_ADMIN: {'true' if is_admin else 'false'}"
    origin = f'http://{hostname}:8000' if hostname == 'localhost' else f'https://{hostname}'
    return (
        f"globalThis.window = {{ location: {{ hostname: '{hostname}', search: '', hash: '', "
        f"origin: '{origin}', href: '{origin}{pathname}', pathname: '{pathname}' }}, "
        f"history: {{ state: null, replaceState() {{}} }}{admin} }};\n"
    )


class NodeTestCase(unittest.TestCase):
    """提供 run_node_esm()：组合 mock 前置片段 + 断言主体，并校验完成标记"""

    @classmethod
    def setUpClass(cls):
        if not NODE_BIN:
            raise RuntimeError("未检测到 Node.js，无法执行前端与加密测试")

    timeout = 30

    def run_node_esm(self, body, *, preamble=(), node_args=()):
        """
        body 中应使用动态 import()，确保在 preamble 注入全局 mock 之后才加载被测模块
        （静态 import 会被提升到脚本最前执行）。
        """
        script = '\n'.join((
            "import assert from 'node:assert/strict';",
            *preamble,
            body,
            f"console.log('{_OK_MARKER}');",
        ))
        proc = subprocess.run(
            [NODE_BIN, *node_args, '--input-type=module', '-e', script],
            cwd=PROJECT_ROOT, capture_output=True, text=True,
            encoding='utf-8', errors='replace', timeout=self.timeout,
        )
        if proc.returncode != 0 or _OK_MARKER not in proc.stdout:
            self.fail(
                f"Node.js 运行时测试失败 (exit={proc.returncode}):\n"
                f"STDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"
            )
        return proc.stdout.replace(_OK_MARKER, '').strip()
