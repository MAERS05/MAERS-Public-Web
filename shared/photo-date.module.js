/** 只读取 TIFF/EXIF 的三个时间字段，保留相机记录的钟面时间，不做时区转换。 */
export function exifDateLabel(value) {
    const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value).replace(/\0/g, '').trim());
    if (!match || Number(match[1]) < 1) return '';
    const [, year, month, day, hour, minute, second] = match;
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) && date.toISOString() === iso ? `${year}${month}${day}_${hour}${minute}${second}` : '';
}

export function readExifDate(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dates = new Map();
    // JPEG、PNG、WebP 与 HEIF/AVIF 的 EXIF 均包含独立 TIFF 数据，偏移以该数据的起点为准。
    for (let start = 0; start + 8 <= bytes.length; start++) {
        const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49 && bytes[start + 2] === 42 && bytes[start + 3] === 0;
        const big = bytes[start] === 0x4d && bytes[start + 1] === 0x4d && bytes[start + 2] === 0 && bytes[start + 3] === 42;
        if (!little && !big) continue;
        const inBounds = (offset, length) => offset >= start && offset + length <= bytes.length;
        const readDirectory = offset => {
            const position = start + offset;
            if (offset < 8 || !inBounds(position, 2)) return 0;
            const count = view.getUint16(position, little);
            if (!inBounds(position + 2, count * 12 + 4)) return 0;
            let exif = 0;
            for (let i = 0; i < count; i++) {
                const entry = position + 2 + i * 12;
                const tag = view.getUint16(entry, little), type = view.getUint16(entry + 2, little);
                const size = view.getUint32(entry + 4, little), value = view.getUint32(entry + 8, little);
                if (tag === 0x8769 && type === 4 && size === 1) exif = value;
                if (![36867, 36868, 306].includes(tag) || type !== 2 || size < 19 || size > 64) continue;
                const textAt = start + value;
                if (!inBounds(textAt, size)) continue;
                const label = exifDateLabel(String.fromCharCode(...bytes.subarray(textAt, textAt + size)));
                if (label && !dates.has(tag)) dates.set(tag, label);
            }
            return exif;
        };
        const exif = readDirectory(view.getUint32(start + 4, little));
        if (exif) readDirectory(exif);
        if (dates.has(36867)) return dates.get(36867);
    }
    return dates.get(36868) || dates.get(306) || '';
}

export async function photoDateLabel(file, timestamp = Date.now()) {
    const exif = readExifDate(await file.arrayBuffer());
    if (exif) return exif;
    const date = new Date(timestamp), pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
