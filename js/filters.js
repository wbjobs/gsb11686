/*
 * filters.js — 纯函数像素滤镜库
 * 同时运行于：主线程、Web Worker (importScripts)、Node (单元测试)
 * 所有函数直接原地修改 Uint8ClampedArray (RGBA)。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Filters = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function mixAmount(amount) {
    const a = Number(amount);
    return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1;
  }

  /* 灰度：ITU-R 601 亮度，amount 控制与原图混合比例 */
  function grayscale(data, w, h, params) {
    const amount = mixAmount(params && params.amount != null ? params.amount : 1);
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      data[i]     = data[i]     + (luma - data[i])     * amount;
      data[i + 1] = data[i + 1] + (luma - data[i + 1]) * amount;
      data[i + 2] = data[i + 2] + (luma - data[i + 2]) * amount;
    }
  }

  /* 反色 */
  function invert(data, w, h, params) {
    const amount = mixAmount(params && params.amount != null ? params.amount : 1);
    for (let i = 0; i < data.length; i += 4) {
      data[i]     = data[i]     + (255 - 2 * data[i])     * amount;
      data[i + 1] = data[i + 1] + (255 - 2 * data[i + 1]) * amount;
      data[i + 2] = data[i + 2] + (255 - 2 * data[i + 2]) * amount;
    }
  }

  /* 单次可分离盒式模糊（滑动窗口，O(n)，与半径无关） */
  function boxBlurPass(src, dst, w, h, radius) {
    const size = radius * 2 + 1;
    // 水平
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      let r = 0, g = 0, b = 0, a = 0;
      for (let x = -radius; x <= radius; x++) {
        const cx = Math.min(w - 1, Math.max(0, x));
        const i = row + cx * 4;
        r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
      }
      for (let x = 0; x < w; x++) {
        const o = row + x * 4;
        dst[o] = r / size; dst[o + 1] = g / size; dst[o + 2] = b / size; dst[o + 3] = a / size;
        const addX = Math.min(w - 1, x + radius + 1);
        const subX = Math.max(0, x - radius);
        const ai = row + addX * 4, si = row + subX * 4;
        r += src[ai] - src[si]; g += src[ai + 1] - src[si + 1];
        b += src[ai + 2] - src[si + 2]; a += src[ai + 3] - src[si + 3];
      }
    }
    // 垂直（水平结果 -> dst，再写回 src 供下一趟使用）
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = -radius; y <= radius; y++) {
        const cy = Math.min(h - 1, Math.max(0, y));
        const i = (cy * w + x) * 4;
        r += dst[i]; g += dst[i + 1]; b += dst[i + 2]; a += dst[i + 3];
      }
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        src[o] = r / size; src[o + 1] = g / size; src[o + 2] = b / size; src[o + 3] = a / size;
        const addY = Math.min(h - 1, y + radius + 1);
        const subY = Math.max(0, y - radius);
        const ai = (addY * w + x) * 4, si = (subY * w + x) * 4;
        r += dst[ai] - dst[si]; g += dst[ai + 1] - dst[si + 1];
        b += dst[ai + 2] - dst[si + 2]; a += dst[ai + 3] - dst[si + 3];
      }
    }
  }

  /* 模糊：3 趟盒式模糊近似高斯，O(n) 滑动窗口实现 */
  function blur(data, w, h, params) {
    let radius = Math.round(params && params.radius != null ? params.radius : 5);
    radius = Math.min(100, Math.max(1, radius));
    const tmp = new Uint8ClampedArray(data.length);
    for (let pass = 0; pass < 3; pass++) boxBlurPass(data, tmp, w, h, radius);
  }

  /* 锐化：3x3 卷积 [0,-1,0,-1,5,-1,0,-1,0]，amount 混合 */
  function sharpen(data, w, h, params) {
    const amount = mixAmount(params && params.amount != null ? params.amount : 1);
    if (amount === 0) return;
    const src = new Uint8ClampedArray(data);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const up = (Math.max(0, y - 1) * w + x) * 4;
        const dn = (Math.min(h - 1, y + 1) * w + x) * 4;
        const lf = (y * w + Math.max(0, x - 1)) * 4;
        const rt = (y * w + Math.min(w - 1, x + 1)) * 4;
        for (let c = 0; c < 3; c++) {
          const v = 5 * src[o + c] - src[up + c] - src[dn + c] - src[lf + c] - src[rt + c];
          data[o + c] = src[o + c] + (v - src[o + c]) * amount;
        }
      }
    }
  }

  /* 边缘检测：Sobel 梯度幅值，输出灰度图 */
  function edgeDetect(data, w, h) {
    const luma = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const xm = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
        const ym = Math.max(0, y - 1), yr = Math.min(h - 1, y + 1);
        const tl = luma[ym * w + xm], tc = luma[ym * w + x], tr = luma[ym * w + xr];
        const ml = luma[y * w + xm],  mr = luma[y * w + xr];
        const bl = luma[yr * w + xm], bc = luma[yr * w + x], br = luma[yr * w + xr];
        const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
        const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
        const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy));
        const o = (y * w + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = mag;
        out[o + 3] = data[o + 3];
      }
    }
    data.set(out);
  }

  /* 色调映射：Reinhard 算子作用于亮度，保持色彩比例 */
  function toneMap(data, w, h, params) {
    const amount = mixAmount(params && params.amount != null ? params.amount : 1);
    let exposure = Number(params && params.exposure != null ? params.exposure : 1);
    if (!Number.isFinite(exposure) || exposure <= 0) exposure = 1;
    for (let i = 0; i < data.length; i += 4) {
      const L = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      if (L <= 0) continue;
      const mapped = (L * exposure) / (1 + L * exposure);
      const scale = 1 + (mapped / L - 1) * amount;
      data[i]     = data[i]     * scale;
      data[i + 1] = data[i + 1] * scale;
      data[i + 2] = data[i + 2] * scale;
    }
  }

  /* 滤镜注册表：label / 参数 schema（驱动 UI）/ 实现 */
  const DEFS = {
    grayscale: { label: '灰度',     fn: grayscale,
      params: { amount: { label: '强度', min: 0, max: 1, step: 0.01, def: 1 } } },
    invert:    { label: '反色',     fn: invert,
      params: { amount: { label: '强度', min: 0, max: 1, step: 0.01, def: 1 } } },
    blur:      { label: '模糊',     fn: blur,
      params: { radius: { label: '半径', min: 1, max: 50, step: 1, def: 5 } } },
    sharpen:   { label: '锐化',     fn: sharpen,
      params: { amount: { label: '强度', min: 0, max: 2, step: 0.01, def: 1 } } },
    edge:      { label: '边缘检测', fn: edgeDetect, params: {} },
    tonemap:   { label: '色调映射', fn: toneMap,
      params: {
        amount:   { label: '强度', min: 0, max: 1, step: 0.01, def: 1 },
        exposure: { label: '曝光', min: 0.25, max: 4, step: 0.05, def: 1 },
      } },
  };

  /* 按链顺序依次应用滤镜；chain 元素: { id, type, params } */
  function applyChain(data, w, h, chain) {
    for (const item of chain) {
      const def = DEFS[item.type];
      if (!def) throw new Error('未知滤镜: ' + item.type);
      def.fn(data, w, h, item.params || {});
    }
  }

  /* CSS 滤镜降级映射：返回 { css, unsupported[] } */
  const CSS_MAP = {
    grayscale: (p) => 'grayscale(' + (p.amount != null ? p.amount : 1) + ')',
    invert:    (p) => 'invert(' + (p.amount != null ? p.amount : 1) + ')',
    blur:      (p) => 'blur(' + (p.radius != null ? p.radius : 5) + 'px)',
  };

  function toCSSFilter(chain) {
    const parts = [], unsupported = [];
    for (const item of chain) {
      const mapper = CSS_MAP[item.type];
      if (mapper) parts.push(mapper(item.params || {}));
      else unsupported.push(item.type);
    }
    return { css: parts.join(' '), unsupported };
  }

  return { DEFS, applyChain, toCSSFilter };
});
