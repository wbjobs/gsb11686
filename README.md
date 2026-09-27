# 滤镜工作室

纯前端图片滤镜应用：Canvas + ImageData + Web Worker + IndexedDB + Blob，零依赖、零构建。

## 运行

```bash
python3 -m http.server 8000   # 或任意静态服务器（Worker 要求 http(s) 协议）
# 打开 http://localhost:8000
```

## 测试

```bash
node test/filters.test.js     # 14 个单元测试：滤镜正确性 / 链顺序 / CSS 映射 / 性能冒烟
```

## 功能

- 六种滤镜：灰度、反色、模糊（3 趟可分离盒式模糊 ≈ 高斯）、锐化（3×3 卷积）、边缘检测（Sobel）、色调映射（Reinhard）
- 滤镜链：任意组合、上下调序、参数滑杆、实时预览
- 撤销/重做：Ctrl+Z / Ctrl+Shift+Z，刷新后仍可恢复
- 导出：PNG / JPEG / WebP，全分辨率输出，质量可调

## 关键设计

| 问题 | 方案 |
|---|---|
| 大图内存 | 原图仅存 `ImageBitmap`（不占 JS 堆）；`ImageData` 即用即弃；buffer 以 transferable 零拷贝传递 |
| 实时预览流畅 | 预览降采样至 ≤1600px + 120ms 防抖 + 过期任务按 job id 丢弃；处理全在 Worker 中不阻塞 UI |
| 滤镜顺序 | 链为有序数组，自上而下依次应用；顺序不同结果不同（有测试保证） |
| 撤销栈内存 | 栈中只存链配置 JSON（每条几十字节），上限 100 条，持久化到 IndexedDB，绝不存位图快照 |
| 导出 | 全分辨率在 Worker 内处理，`OffscreenCanvas.convertToBlob` 直接产 Blob，`URL.createObjectURL` 触发下载 |
| 降级 | 无 Worker/OffscreenCanvas 时自动切 CSS `filter` 预览与 `ctx.filter` 导出；锐化/边缘/色调映射无法 CSS 表达，UI 明确提示 |
| 性能 | 模糊为滑动窗口 O(n)（与半径无关）；1080p 全链约 200ms（Node 实测） |

## 文件结构

```
index.html        页面骨架
css/style.css     样式
js/filters.js     滤镜核心（主线程 / Worker / Node 三端共用）
js/worker.js      Worker：预览处理 + 导出 convertToBlob
js/db.js          IndexedDB 极简封装（链 / 撤销栈 / 原图 Blob 持久化）
js/main.js        UI、预览管线、撤销、导出、CSS 降级
test/filters.test.js  Node 单元测试
```
