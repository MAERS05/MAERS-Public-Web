/**
 * MAERS Content URL - 正文地址解析
 * 职责：把 CMS 节点的 Markdown 相对路径解析为读取地址。
 * 本机读取物理文件，线上从配置的公开正文地址读取云端镜像。
 */

/** 判断当前页面是否来自本机服务（localhost / 127.0.0.1 / file://）。 */
export function isLocalEnv() {
    if (typeof window === 'undefined' || !window.location) return false;
    return ['localhost', '127.0.0.1', '[::1]', ''].includes(window.location.hostname || '');
}

/**
 * @param {string} mdPath 相对项目根的正文路径，例如 markdown/notes/root-标题.md
 * @param {{local?: boolean}} [options] local 为 true 时强制读取本机文件（私密正文等）
 * @returns {string}
 */
export function markdownUrl(mdPath, { local = isLocalEnv() } = {}) {
    const encoded = String(mdPath).split('/').map(encodeURIComponent).join('/');
    if (local) return encoded;
    const base = (window.MAERS?.Config?.CONTENT_PUBLIC_BASE || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('公开正文地址不能为空，请在存储设置填写');
    return `${base}/${encoded}`;
}

