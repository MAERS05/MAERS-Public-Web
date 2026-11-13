/** 上传传输进度：沿用 Response 接口，传输完成后单独等待服务端处理结果。 */
export function uploadMeter(progress, label = '图片') {
    return (sent, total) => {
        if (total > 0) progress.update(Math.round(sent / total * 100), 100, `正在上传${label}`, '%');
        else progress.update(0, 0, `${label}已传输，等待处理和保存`);
    };
}

export function uploadFetch(url, options, onProgress) {
    if (!onProgress || typeof XMLHttpRequest === 'undefined') return fetch(url, options);
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open(options.method || 'POST', url);
        request.responseType = 'arraybuffer';
        new Headers(options.headers).forEach((value, key) => request.setRequestHeader(key, value));
        request.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : 0);
        request.upload.onload = () => onProgress(0, 0);
        request.onload = () => {
            const headers = new Headers();
            for (const line of request.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
                const colon = line.indexOf(':');
                if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
            }
            resolve(new Response(request.status === 204 ? null : request.response, {
                status: request.status, statusText: request.statusText, headers
            }));
        };
        request.onerror = () => reject(new Error('上传连接失败，请检查网络后重试'));
        request.onabort = () => reject(new Error('上传已中断'));
        request.send(options.body);
    });
}
