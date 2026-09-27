'use strict';
const assert = require('node:assert');
const Filters = require('../js/filters.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

/* 构造 w×h RGBA 数据，px(x,y) -> [r,g,b,a] */
function makeImage(w, h, px) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = px(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return data;
}
const at = (data, w, x, y) => {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

console.log('filters.test.js');

/* ---- 灰度 ---- */
test('灰度：输出 R=G=B 且等于 ITU-R 601 亮度', () => {
  const d = makeImage(2, 1, () => [200, 100, 50]);
  Filters.DEFS.grayscale.fn(d, 2, 1, { amount: 1 });
  const [r, g, b] = at(d, 2, 0, 0);
  assert.strictEqual(r, g);
  assert.strictEqual(g, b);
  assert(Math.abs(r - Math.round(0.299 * 200 + 0.587 * 100 + 0.114 * 50)) <= 1);
});

test('灰度：amount=0 时不变', () => {
  const d = makeImage(1, 1, () => [10, 20, 30]);
  Filters.DEFS.grayscale.fn(d, 1, 1, { amount: 0 });
  assert.deepStrictEqual(at(d, 1, 0, 0).slice(0, 3), [10, 20, 30]);
});

/* ---- 反色 ---- */
test('反色：v -> 255-v，两次应用还原', () => {
  const d = makeImage(1, 1, () => [10, 128, 250]);
  Filters.DEFS.invert.fn(d, 1, 1, { amount: 1 });
  assert.deepStrictEqual(at(d, 1, 0, 0).slice(0, 3), [245, 127, 5]);
  Filters.DEFS.invert.fn(d, 1, 1, { amount: 1 });
  assert.deepStrictEqual(at(d, 1, 0, 0).slice(0, 3), [10, 128, 250]);
});

/* ---- 模糊 ---- */
test('模糊：纯色图不变', () => {
  const d = makeImage(8, 8, () => [100, 150, 200]);
  Filters.DEFS.blur.fn(d, 8, 8, { radius: 3 });
  for (let i = 0; i < d.length; i += 4) {
    assert(Math.abs(d[i] - 100) <= 1 && Math.abs(d[i + 1] - 150) <= 1 && Math.abs(d[i + 2] - 200) <= 1);
  }
});

test('模糊：脉冲峰值被摊平、向四周扩散', () => {
  const w = 9, h = 9;
  const d = makeImage(w, h, (x, y) => (x === 4 && y === 4 ? [255, 255, 255] : [0, 0, 0]));
  Filters.DEFS.blur.fn(d, w, h, { radius: 2 });
  const center = at(d, w, 4, 4)[0];
  const neighbor = at(d, w, 5, 4)[0];
  assert(center < 255 && center > 0, '中心应被摊平');
  assert(neighbor > 0, '邻近像素应被扩散到');
});

/* ---- 锐化 ---- */
test('锐化：纯色图不变，阶跃边缘对比增强', () => {
  const flat = makeImage(5, 5, () => [128, 128, 128]);
  Filters.DEFS.sharpen.fn(flat, 5, 5, { amount: 1 });
  assert.deepStrictEqual(at(flat, 5, 2, 2).slice(0, 3), [128, 128, 128]);

  const w = 10, h = 3;
  const step = makeImage(w, h, (x) => (x < 5 ? [0, 0, 0] : [200, 200, 200]));
  Filters.DEFS.sharpen.fn(step, w, h, { amount: 1 });
  // 边缘暗侧更暗（被钳到 0 附近），亮侧更亮
  assert(at(step, w, 4, 1)[0] <= 0 + 1, '暗侧应保持/更暗');
  assert(at(step, w, 5, 1)[0] > 200, '亮侧应过冲变亮');
});

/* ---- 边缘检测 ---- */
test('边缘检测：纯色图为黑，垂直边缘处出现亮线', () => {
  const flat = makeImage(6, 6, () => [128, 128, 128]);
  Filters.DEFS.edge.fn(flat, 6, 6, {});
  for (let i = 0; i < flat.length; i += 4) assert.strictEqual(flat[i], 0);

  const w = 10, h = 6;
  const d = makeImage(w, h, (x) => (x < 5 ? [0, 0, 0] : [255, 255, 255]));
  Filters.DEFS.edge.fn(d, w, h, {});
  assert(at(d, w, 4, 3)[0] > 100 || at(d, w, 5, 3)[0] > 100, '边界处应有亮线');
  assert(at(d, w, 1, 3)[0] === 0, '远离边界应为黑');
});

/* ---- 色调映射 ---- */
test('色调映射：黑色不变，高亮被压缩，单调不降', () => {
  const d = makeImage(3, 1, (x) => [0, 128, 255][x] * 1 ? [[0,0,0],[128,128,128],[255,255,255]][x] : [0,0,0]);
  Filters.DEFS.tonemap.fn(d, 3, 1, { amount: 1, exposure: 1 });
  assert.strictEqual(at(d, 3, 0, 0)[0], 0, '黑色保持');
  const mid = at(d, 3, 1, 0)[0];
  const hi = at(d, 3, 2, 0)[0];
  assert(mid < 128, '中间调被压缩: ' + mid);
  assert(hi <= 255 && hi > mid, '单调且高亮压缩');
});

/* ---- 滤镜链 ---- */
test('滤镜链：空链为恒等', () => {
  const d = makeImage(2, 2, (x, y) => [x * 50, y * 50, 100]);
  const copy = new Uint8ClampedArray(d);
  Filters.applyChain(d, 2, 2, []);
  assert.deepStrictEqual(d, copy);
});

test('滤镜链：顺序影响结果（blur∘edge ≠ edge∘blur）', () => {
  const w = 12, h = 12;
  const src = makeImage(w, h, (x) => (x < 6 ? [0, 0, 0] : [255, 255, 255]));
  const chainAB = [
    { id: 1, type: 'edge', params: {} },
    { id: 2, type: 'blur', params: { radius: 2 } },
  ];
  const chainBA = [
    { id: 1, type: 'blur', params: { radius: 2 } },
    { id: 2, type: 'edge', params: {} },
  ];
  const a = new Uint8ClampedArray(src);
  const b = new Uint8ClampedArray(src);
  Filters.applyChain(a, w, h, chainAB);
  Filters.applyChain(b, w, h, chainBA);
  assert.notDeepStrictEqual(a, b, '不同顺序应产生不同结果');
});

test('滤镜链：依次应用等价于逐个手动应用', () => {
  const w = 6, h = 6;
  const src = makeImage(w, h, (x, y) => [(x * 40) % 256, (y * 40) % 256, 128]);
  const chain = [
    { id: 1, type: 'grayscale', params: { amount: 1 } },
    { id: 2, type: 'invert', params: { amount: 1 } },
  ];
  const viaChain = new Uint8ClampedArray(src);
  Filters.applyChain(viaChain, w, h, chain);
  const manual = new Uint8ClampedArray(src);
  Filters.DEFS.grayscale.fn(manual, w, h, { amount: 1 });
  Filters.DEFS.invert.fn(manual, w, h, { amount: 1 });
  assert.deepStrictEqual(viaChain, manual);
});

test('滤镜链：未知滤镜抛出错误', () => {
  const d = makeImage(1, 1, () => [0, 0, 0]);
  assert.throws(() => Filters.applyChain(d, 1, 1, [{ type: 'nope', params: {} }]), /未知滤镜/);
});

/* ---- CSS 降级映射 ---- */
test('CSS 降级：可映射滤镜生成 CSS，不可映射的列入 unsupported', () => {
  const { css, unsupported } = Filters.toCSSFilter([
    { type: 'grayscale', params: { amount: 0.5 } },
    { type: 'blur', params: { radius: 4 } },
    { type: 'edge', params: {} },
  ]);
  assert.strictEqual(css, 'grayscale(0.5) blur(4px)');
  assert.deepStrictEqual(unsupported, ['edge']);
});

/* ---- 性能冒烟：1080p 全链应在可接受时间完成 ---- */
test('性能：1920×1080 全滤镜链处理 < 5s', () => {
  const w = 1920, h = 1080;
  const d = makeImage(w, h, (x, y) => [(x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256]);
  const chain = [
    { id: 1, type: 'blur', params: { radius: 8 } },
    { id: 2, type: 'sharpen', params: { amount: 1 } },
    { id: 3, type: 'grayscale', params: { amount: 0.5 } },
    { id: 4, type: 'tonemap', params: { amount: 1, exposure: 1.2 } },
    { id: 5, type: 'edge', params: {} },
  ];
  const t0 = Date.now();
  Filters.applyChain(d, w, h, chain);
  const ms = Date.now() - t0;
  console.log('    (1080p 全链耗时 ' + ms + ' ms)');
  assert(ms < 5000, '耗时 ' + ms + 'ms 超出阈值');
});

console.log('\n全部 ' + passed + ' 个测试通过');
