/** 本机内存加密桥：复用站点加密实现，密钥仅经标准输入传入，不写文件或日志。 */
import { importDataKey, fromB64, encryptRecord, decryptRecord } from '../../data-manage/encrypt/crypto.module.js';

try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const { key: raw, operation, values } = JSON.parse(input);
    const key = await importDataKey(fromB64(raw));
    if (!['encrypt', 'decrypt'].includes(operation) || !Array.isArray(values)) throw Error();
    const result = await Promise.all(values.map(async value => {
        if (operation === 'encrypt') return encryptRecord(value, key);
        const plain = await decryptRecord(value, key);
        if (!plain || typeof plain !== 'object') throw Error();
        return plain;
    }));
    process.stdout.write(JSON.stringify(result));
} catch {
    process.stderr.write('Private crypto operation failed');
    process.exitCode = 1;
}
