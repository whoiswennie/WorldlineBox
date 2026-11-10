/* eslint-disable @typescript-eslint/no-require-imports -- Executed as a standalone CommonJS worker. */
/* global require, Buffer */
// PNG is encoded one horizontal band at a time, outside Electron's main thread.
const { parentPort, workerData } = require('node:worker_threads');
const { createWriteStream } = require('node:fs');
const { stat } = require('node:fs/promises');
const { once } = require('node:events');
const { createDeflate } = require('node:zlib');
const path = require('node:path');
const sharp = require(workerData.sharpModule);
sharp.cache(false);
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, bytes) {
  const output = Buffer.allocUnsafe(bytes.length + 12);
  output.writeUInt32BE(bytes.length); output.write(type, 4, 4, 'ascii'); bytes.copy(output, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < output.length - 4; i++) crc = crcTable[(crc ^ output[i]) & 255] ^ (crc >>> 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
let output, deflate, pump, width, height, bandHeight, band, bandY = 0, writtenX = 0;
async function write(bytes) { if (!output.write(bytes)) await once(output, 'drain'); }
let chain = Promise.resolve();
parentPort.on('message', message => {
  chain = chain.then(async () => {
    if (message.type === 'start') {
      ({ width, height, bandHeight } = message);
      output = createWriteStream(path.join(workerData.directory, 'page.png'));
      output.on('error', error => { deflate?.destroy(error); parentPort.postMessage({ error: error.message }); });
      await write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
      await write(chunk('IHDR', header));
      deflate = createDeflate({ level: 3 });
      pump = (async () => { for await (const bytes of deflate) await write(chunk('IDAT', bytes)); })();
      pump.catch(error => parentPort.postMessage({ error: error.message }));
    } else if (message.type === 'tile') {
      const { x, y, tileWidth, tileHeight } = message;
      if (y !== bandY || x !== writtenX) throw Error('长图分块顺序不一致。');
      band ??= Buffer.allocUnsafe(width * tileHeight * 3);
      let source = sharp(Buffer.from(message.bytes), { limitInputPixels: false, ...(message.bitmap ? { raw: { ...message.bitmap, channels: 4 } } : {}) }).flatten({ background: '#fff' }).removeAlpha().toColourspace('srgb');
      if (message.bitmap) source = source.recomb([[0, 0, 1], [0, 1, 0], [1, 0, 0]]);
      const decoded = await source.resize(tileWidth, tileHeight, { fit: 'fill' }).raw().toBuffer();
      for (let row = 0; row < tileHeight; row++) decoded.copy(band, (row * width + x) * 3, row * tileWidth * 3, (row + 1) * tileWidth * 3);
      writtenX += tileWidth;
      if (writtenX === width) {
        await sharp(band, { raw: { width, height: tileHeight, channels: 3 }, limitInputPixels: false })
          .resize({ width: Math.min(width, 1000), withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(path.join(workerData.directory, `preview-${Math.floor(y / bandHeight)}.jpg`));
        const rowBytes = Buffer.allocUnsafe(width * 3 + 1); rowBytes[0] = 0;
        for (let row = 0; row < tileHeight; row++) {
          band.copy(rowBytes, 1, row * width * 3, (row + 1) * width * 3);
          await new Promise((resolve, reject) => deflate.write(rowBytes, error => error ? reject(error) : resolve()));
        }
        band = undefined; writtenX = 0; bandY += tileHeight;
      }
    } else if (message.type === 'finish') {
      if (bandY !== height || writtenX) throw Error('长图数据不完整。');
      deflate.end(); await pump; await write(chunk('IEND', Buffer.alloc(0)));
      await new Promise((resolve, reject) => { output.once('error', reject); output.end(resolve); });
      parentPort.postMessage({ seq: message.seq, bytes: (await stat(path.join(workerData.directory, 'page.png'))).size }); return;
    }
    parentPort.postMessage({ seq: message.seq });
  }).catch(error => { output?.destroy(); deflate?.destroy(); parentPort.postMessage({ seq: message.seq, error: error.message }); });
});
