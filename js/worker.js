/*
 * worker.js — 在后台线程执行滤镜链，避免阻塞 UI。
 * 预览：接收 transferable ArrayBuffer，处理后传回（零拷贝）。
 * 导出：处理后用 OffscreenCanvas.convertToBlob 直接产出 Blob。
 */
importScripts('filters.js');

self.onmessage = function (e) {
  const msg = e.data;
  try {
    const data = new Uint8ClampedArray(msg.buffer);
    Filters.applyChain(data, msg.width, msg.height, msg.chain);

    if (msg.kind === 'export') {
      const canvas = new OffscreenCanvas(msg.width, msg.height);
      const ctx = canvas.getContext('2d');
      ctx.putImageData(new ImageData(data, msg.width, msg.height), 0, 0);
      canvas.convertToBlob({ type: msg.format, quality: msg.quality }).then(function (blob) {
        self.postMessage({ id: msg.id, kind: 'exportResult', blob: blob });
      }, function (err) {
        self.postMessage({ id: msg.id, kind: 'error', message: String(err) });
      });
    } else {
      self.postMessage(
        { id: msg.id, kind: 'result', buffer: data.buffer, width: msg.width, height: msg.height },
        [data.buffer]
      );
    }
  } catch (err) {
    self.postMessage({ id: msg.id, kind: 'error', message: String(err && err.message || err) });
  }
};
