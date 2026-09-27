/*
 * main.js — 应用主逻辑
 * 预览：降采样 + Web Worker + transferable buffer + 防抖 + 过期任务丢弃
 * 导出：全分辨率在 Worker 内处理并 convertToBlob
 * 撤销：栈中只存链配置 JSON（小），持久化到 IndexedDB
 * 降级：无 Worker / OffscreenCanvas 时使用 CSS filter 预览与导出
 */
(function () {
  'use strict';

  const PREVIEW_MAX = 1600;        // 预览最长边
  const UNDO_LIMIT = 100;          // 撤销栈上限
  const LARGE_IMAGE_PIXELS = 40e6; // 大图提示阈值
  const DEBOUNCE_MS = 120;

  const els = {
    fileInput: document.getElementById('fileInput'),
    undoBtn: document.getElementById('undoBtn'),
    redoBtn: document.getElementById('redoBtn'),
    exportBtn: document.getElementById('exportBtn'),
    formatSelect: document.getElementById('formatSelect'),
    qualityInput: document.getElementById('qualityInput'),
    palette: document.getElementById('palette'),
    chainList: document.getElementById('chainList'),
    chainEmpty: document.getElementById('chainEmpty'),
    previewCanvas: document.getElementById('previewCanvas'),
    dropHint: document.getElementById('dropHint'),
    stage: document.querySelector('.stage'),
    statusInfo: document.getElementById('statusInfo'),
    statusPerf: document.getElementById('statusPerf'),
    statusFallback: document.getElementById('statusFallback'),
  };

  const state = {
    bitmap: null,          // ImageBitmap 原图（显存驻留，不占 JS 堆）
    fileName: 'image',
    width: 0,
    height: 0,
    chain: [],             // [{ id, type, params }]
    undoStack: [],
    redoStack: [],
    nextId: 1,
  };

  /* ---------- Worker 管理 ---------- */
  let worker = null;
  let workerSupported = typeof Worker !== 'undefined';
  let jobSeq = 0;
  let lastPreviewJob = 0;
  const pendingExports = new Map();

  function getWorker() {
    if (!worker && workerSupported) {
      try {
        worker = new Worker('js/worker.js');
        worker.onmessage = onWorkerMessage;
        worker.onerror = () => degradeToCSS('Worker 运行出错');
      } catch (e) {
        degradeToCSS('Worker 不可用');
      }
    }
    return worker;
  }

  function degradeToCSS(reason) {
    workerSupported = false;
    if (worker) { worker.terminate(); worker = null; }
    els.statusFallback.textContent = '已降级为 CSS 滤镜预览（' + reason + '），锐化/边缘检测/色调映射不可用';
    schedulePreview();
  }

  function onWorkerMessage(e) {
    const msg = e.data;
    if (msg.kind === 'error') {
      console.error('worker error:', msg.message);
      degradeToCSS('处理失败');
      return;
    }
    if (msg.kind === 'result') {
      if (msg.id !== lastPreviewJob) return; // 过期结果丢弃
      const t1 = performance.now();
      els.previewCanvas.width = msg.width;
      els.previewCanvas.height = msg.height;
      els.previewCanvas.style.filter = '';
      els.previewCanvas.getContext('2d')
        .putImageData(new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height), 0, 0);
      els.statusPerf.textContent = '渲染 ' + Math.round(t1 - msg.t0) + ' ms';
    } else if (msg.kind === 'exportResult') {
      const cb = pendingExports.get(msg.id);
      pendingExports.delete(msg.id);
      if (cb) cb(null, msg.blob);
    }
  }

  /* ---------- 预览管线 ---------- */
  let debounceTimer = 0;

  function schedulePreview() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runPreview, DEBOUNCE_MS);
  }

  function fitSize(w, h, max) {
    const scale = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }

  // 复用 scratch canvas，避免反复分配
  const scratch = document.createElement('canvas');

  function runPreview() {
    if (!state.bitmap) return;
    if (!workerSupported || !getWorker()) return cssPreview();

    const { w, h } = fitSize(state.width, state.height, PREVIEW_MAX);
    scratch.width = w;
    scratch.height = h;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(state.bitmap, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);

    const jobId = ++jobSeq;
    lastPreviewJob = jobId;
    const t0 = performance.now();
    // buffer 以 transferable 方式转移，零拷贝；imgData 随之失效，下轮重新取
    getWorker().postMessage(
      { kind: 'preview', id: jobId, width: w, height: h, buffer: imgData.data.buffer, chain: state.chain, t0 },
      [imgData.data.buffer]
    );
  }

  function cssPreview() {
    const { w, h } = fitSize(state.width, state.height, PREVIEW_MAX);
    els.previewCanvas.width = w;
    els.previewCanvas.height = h;
    const { css, unsupported } = Filters.toCSSFilter(state.chain);
    els.previewCanvas.style.filter = css;
    els.previewCanvas.getContext('2d').drawImage(state.bitmap, 0, 0, w, h);
    if (unsupported.length) {
      els.statusFallback.textContent = 'CSS 降级模式：' +
        unsupported.map((t) => Filters.DEFS[t].label).join('、') + ' 不参与预览/导出';
    }
  }

  /* ---------- 滤镜链管理 ---------- */
  function defaultParams(type) {
    const params = {};
    for (const [key, schema] of Object.entries(Filters.DEFS[type].params)) params[key] = schema.def;
    return params;
  }

  function mutateChain(mutator) {
    state.undoStack.push(JSON.stringify(state.chain));
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
    state.redoStack = [];
    mutator();
    afterChainChange();
  }

  function afterChainChange() {
    renderChainList();
    updateUndoButtons();
    schedulePreview();
    persist();
  }

  function addFilter(type) {
    if (!state.bitmap) { setStatus('请先打开图片'); return; }
    mutateChain(() => state.chain.push({ id: state.nextId++, type, params: defaultParams(type) }));
  }

  function removeFilter(id) {
    mutateChain(() => { state.chain = state.chain.filter((f) => f.id !== id); });
  }

  function moveFilter(id, dir) {
    mutateChain(() => {
      const i = state.chain.findIndex((f) => f.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= state.chain.length) return;
      [state.chain[i], state.chain[j]] = [state.chain[j], state.chain[i]];
    });
  }

  function setParam(id, key, value, commit) {
    const item = state.chain.find((f) => f.id === id);
    if (!item) return;
    if (commit) {
      mutateChain(() => { item.params[key] = value; });
    } else {
      item.params[key] = value; // 拖动中：只改参数做实时预览，不进撤销栈
      schedulePreview();
    }
  }

  /* ---------- 撤销 / 重做 ---------- */
  function undo() {
    if (!state.undoStack.length) return;
    state.redoStack.push(JSON.stringify(state.chain));
    state.chain = JSON.parse(state.undoStack.pop());
    afterChainChange();
  }

  function redo() {
    if (!state.redoStack.length) return;
    state.undoStack.push(JSON.stringify(state.chain));
    state.chain = JSON.parse(state.redoStack.pop());
    afterChainChange();
  }

  function updateUndoButtons() {
    els.undoBtn.disabled = !state.undoStack.length;
    els.redoBtn.disabled = !state.redoStack.length;
  }

  /* ---------- IndexedDB 持久化 ---------- */
  let persistTimer = 0;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      DB.set('chain', state.chain).catch(() => {});
      DB.set('undoStack', state.undoStack).catch(() => {});
      DB.set('redoStack', state.redoStack).catch(() => {});
    }, 300);
  }

  async function restoreSession() {
    try {
      const [chain, undoStack, redoStack, blob, name] = await Promise.all([
        DB.get('chain'), DB.get('undoStack'), DB.get('redoStack'), DB.get('image'), DB.get('fileName'),
      ]);
      if (Array.isArray(chain)) state.chain = chain;
      if (Array.isArray(undoStack)) state.undoStack = undoStack;
      if (Array.isArray(redoStack)) state.redoStack = redoStack;
      if (chain && chain.length) state.nextId = Math.max(...chain.map((f) => f.id || 0)) + 1;
      if (blob) {
        state.fileName = name || 'image';
        await loadBitmap(blob);
      } else {
        renderChainList();
        updateUndoButtons();
      }
    } catch (e) { /* 首次使用或 IndexedDB 不可用，忽略 */ }
  }

  /* ---------- 图片加载 ---------- */
  async function loadBitmap(source) {
    const bitmap = await createImageBitmap(source);
    if (state.bitmap) state.bitmap.close();
    state.bitmap = bitmap;
    state.width = bitmap.width;
    state.height = bitmap.height;
    els.dropHint.classList.add('hidden');
    els.exportBtn.disabled = false;

    const mp = (state.width * state.height / 1e6).toFixed(1);
    setStatus(state.fileName + ' · ' + state.width + '×' + state.height + ' · ' + mp + ' MP'
      + (state.width * state.height > LARGE_IMAGE_PIXELS ? ' · 大图模式：预览已降采样' : ''));
    renderChainList();
    updateUndoButtons();
    schedulePreview();
  }

  function openFile(file) {
    if (!file || !file.type.startsWith('image/')) { setStatus('请选择图片文件'); return; }
    state.fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
    DB.set('image', file).catch(() => {});
    DB.set('fileName', state.fileName).catch(() => {});
    loadBitmap(file).catch((e) => setStatus('图片加载失败: ' + e.message));
  }

  /* ---------- 导出 ---------- */
  function exportImage() {
    if (!state.bitmap) return;
    const format = els.formatSelect.value;
    const quality = parseFloat(els.qualityInput.value);
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[format] || 'png';
    setStatus('导出中…');

    const done = (err, blob) => {
      if (err) { setStatus('导出失败: ' + err.message); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = state.fileName + '-filtered.' + ext;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus('已导出 ' + a.download + '（' + (blob.size / 1024).toFixed(0) + ' KB）');
    };

    if (workerSupported && getWorker() && typeof OffscreenCanvas !== 'undefined') {
      // 全分辨率处理：原图 -> ImageData -> Worker -> Blob
      scratch.width = state.width;
      scratch.height = state.height;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(state.bitmap, 0, 0);
      const imgData = ctx.getImageData(0, 0, state.width, state.height);
      const jobId = ++jobSeq;
      pendingExports.set(jobId, done);
      getWorker().postMessage(
        { kind: 'export', id: jobId, width: state.width, height: state.height,
          buffer: imgData.data.buffer, chain: state.chain, format, quality },
        [imgData.data.buffer]
      );
    } else {
      // CSS 降级导出
      const { css, unsupported } = Filters.toCSSFilter(state.chain);
      if (unsupported.length) setStatus('注意：部分滤镜在降级模式下未应用');
      const out = document.createElement('canvas');
      out.width = state.width;
      out.height = state.height;
      const ctx = out.getContext('2d');
      ctx.filter = css || 'none';
      ctx.drawImage(state.bitmap, 0, 0);
      out.toBlob((blob) => done(blob ? null : new Error('toBlob 失败'), blob), format, quality);
    }
  }

  /* ---------- UI 渲染 ---------- */
  function setStatus(text) { els.statusInfo.textContent = text; }

  function renderPalette() {
    for (const [type, def] of Object.entries(Filters.DEFS)) {
      const btn = document.createElement('button');
      btn.textContent = '+ ' + def.label;
      btn.onclick = () => addFilter(type);
      els.palette.appendChild(btn);
    }
  }

  function renderChainList() {
    els.chainList.innerHTML = '';
    els.chainEmpty.style.display = state.chain.length ? 'none' : 'block';
    state.chain.forEach((item, index) => {
      const def = Filters.DEFS[item.type];
      const div = document.createElement('div');
      div.className = 'chain-item';

      const head = document.createElement('div');
      head.className = 'head';
      head.innerHTML = '<span class="order">' + (index + 1) + '</span>'
        + '<span class="name">' + def.label + '</span>';
      const up = iconBtn('↑', '上移', () => moveFilter(item.id, -1));
      const dn = iconBtn('↓', '下移', () => moveFilter(item.id, 1));
      const rm = iconBtn('✕', '移除', () => removeFilter(item.id));
      up.disabled = index === 0;
      dn.disabled = index === state.chain.length - 1;
      head.append(up, dn, rm);
      div.appendChild(head);

      for (const [key, schema] of Object.entries(def.params)) {
        const row = document.createElement('div');
        row.className = 'param-row';
        const label = document.createElement('label');
        label.textContent = schema.label;
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = schema.min; slider.max = schema.max; slider.step = schema.step;
        slider.value = item.params[key];
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = item.params[key];
        slider.addEventListener('input', () => {
          val.textContent = slider.value;
          setParam(item.id, key, parseFloat(slider.value), false);
        });
        slider.addEventListener('change', () => {
          setParam(item.id, key, parseFloat(slider.value), true);
        });
        row.append(label, slider, val);
        div.appendChild(row);
      }
      els.chainList.appendChild(div);
    });
  }

  function iconBtn(text, title, onclick) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.textContent = text;
    b.title = title;
    b.onclick = onclick;
    return b;
  }

  /* ---------- 事件绑定 ---------- */
  els.fileInput.addEventListener('change', (e) => {
    openFile(e.target.files[0]);
    e.target.value = '';
  });
  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);
  els.exportBtn.addEventListener('click', exportImage);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  });

  ['dragover', 'dragleave', 'drop'].forEach((type) => {
    els.stage.addEventListener(type, (e) => {
      e.preventDefault();
      els.stage.classList.toggle('dragover', type === 'dragover');
      if (type === 'drop') openFile(e.dataTransfer.files[0]);
    });
  });

  /* ---------- 启动 ---------- */
  renderPalette();
  renderChainList();
  restoreSession();
})();
