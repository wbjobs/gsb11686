export const MAX_DIMENSION = 8192;
export const PREVIEW_LONG_EDGE = 1600;
export const PREVIEW_AREA = 2_000_000;
export const FALLBACK_AREA = 12_000_000;

export function getExportLimits() {
  const memory = typeof navigator !== "undefined" ? navigator.deviceMemory || 4 : 4;
  return {
    maxDimension: MAX_DIMENSION,
    maxArea: memory >= 8 ? 24_000_000 : memory <= 2 ? 12_000_000 : 16_000_000
  };
}

export function fitDimensions(width, height, maxLongEdge, maxArea) {
  const widthScale = maxLongEdge / width;
  const heightScale = maxLongEdge / height;
  const areaScale = Math.sqrt(maxArea / (width * height));
  const scale = Math.min(1, widthScale, heightScale, areaScale);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale
  };
}

export function getPreviewDimensions(width, height) {
  return fitDimensions(width, height, PREVIEW_LONG_EDGE, PREVIEW_AREA);
}

export function getSafeExportDimensions(width, height) {
  const limits = getExportLimits();
  return fitDimensions(width, height, limits.maxDimension, limits.maxArea);
}

export async function getImageDimensions(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function decodeToCanvas(blob, naturalWidth, naturalHeight, options = {}) {
  const target = fitDimensions(
    naturalWidth,
    naturalHeight,
    options.maxLongEdge || MAX_DIMENSION,
    options.maxArea || Number.MAX_SAFE_INTEGER
  );
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建 Canvas 2D 上下文");

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: options.quality || "high",
      imageOrientation: "from-image"
    });
  } catch {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  }

  try {
    context.drawImage(bitmap, 0, 0, target.width, target.height);
  } finally {
    bitmap.close();
  }

  return { canvas, ...target };
}

export function canvasToBlob(canvas, format, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片编码失败"));
    }, format, quality);
  });
}

export function flattenImageData(image) {
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] / 255;
    data[index] = Math.round(data[index] * alpha + 255 * (1 - alpha));
    data[index + 1] = Math.round(data[index + 1] * alpha + 255 * (1 - alpha));
    data[index + 2] = Math.round(data[index + 2] * alpha + 255 * (1 - alpha));
    data[index + 3] = 255;
  }
  return image;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function isFormatSupported(format) {
  if (format !== "image/webp") return true;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas.toDataURL("image/webp").startsWith("data:image/webp");
}
