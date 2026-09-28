export const FILTER_LABELS = Object.freeze({
  grayscale: "灰度",
  invert: "反色",
  blur: "模糊",
  sharpen: "锐化",
  edges: "边缘检测",
  tone: "色调映射"
});

let filterId = 0;

export function createFilter(type) {
  const base = { id: `${type}_${Date.now()}_${filterId++}`, type, enabled: true };
  if (type === "grayscale") return { ...base, amount: 100 };
  if (type === "invert") return { ...base, amount: 100 };
  if (type === "blur") return { ...base, radius: 8, passes: 3 };
  if (type === "sharpen") return { ...base, amount: 50 };
  if (type === "edges") return { ...base, amount: 100 };
  if (type === "tone") return { ...base, mode: "reinhard", exposure: 1, amount: 100 };
  throw new Error(`未知滤镜：${type}`);
}

export function applyFilterChain(image, chain, scratch = {}) {
  let current = image;
  for (const filter of chain) {
    if (!filter.enabled) continue;
    current = applyFilter(current, filter, scratch);
  }
  if (current !== image) image.data.set(current.data);
  return image;
}

export function applyFilter(image, filter, scratch = {}) {
  if (filter.type === "grayscale") return applyGrayscale(image, Number(filter.amount) || 0);
  if (filter.type === "invert") return applyInvert(image, Number(filter.amount) || 0);
  if (filter.type === "blur") return applyBlur(image, filter, scratch);
  if (filter.type === "sharpen") return applySharpen(image, Number(filter.amount) || 0, scratch);
  if (filter.type === "edges") return applyEdges(image, Number(filter.amount) || 0, scratch);
  if (filter.type === "tone") return applyToneMap(image, filter);
  throw new Error(`未知滤镜：${filter.type}`);
}

function ensureScratch(scratch, size, key) {
  if (!scratch[key] || scratch[key].length !== size) scratch[key] = new Float64Array(size);
  return scratch[key];
}

function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function applyGrayscale(image, percent) {
  const amount = Math.min(100, Math.max(0, percent)) / 100;
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
    data[index] += (gray - data[index]) * amount;
    data[index + 1] += (gray - data[index + 1]) * amount;
    data[index + 2] += (gray - data[index + 2]) * amount;
  }
  return image;
}

function applyInvert(image, percent) {
  const amount = Math.min(100, Math.max(0, percent)) / 100;
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    data[index] += (255 - data[index] * 2) * amount;
    data[index + 1] += (255 - data[index + 1] * 2) * amount;
    data[index + 2] += (255 - data[index + 2] * 2) * amount;
  }
  return image;
}

function applyToneMap(image, options) {
  const percent = Math.min(100, Math.max(0, Number(options.amount) ?? 100)) / 100;
  const exposure = Math.min(8, Math.max(0, Number(options.exposure) || 1));
  const mode = options.mode || "reinhard";
  const data = image.data;

  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const original = data[index + channel] / 255;
      const linear = decodeSrgb(original) * exposure;
      const mapped = mode === "aces" ? acesFilm(linear) : reinhard(linear);
      data[index + channel] = clamp255(Math.round((original + (encodeSrgb(mapped) - original) * percent) * 255));
    }
  }
  return image;
}

function reinhard(value) {
  return value / (1 + value);
}

function acesFilm(value) {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  return Math.max(0, Math.min(1, (value * (a * value + b)) / (value * (c * value + d) + e)));
}

function decodeSrgb(value) {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function encodeSrgb(value) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function applyBlur(image, options, scratch) {
  const radius = Math.min(100, Math.max(0, Number(options.radius) || 0));
  const passes = Math.min(3, Math.max(1, Math.round(Number(options.passes) || 3)));
  if (radius < 0.5) return image;

  const { width, height, data } = image;
  const pixelCount = width * height;
  const temp = ensureScratch(scratch, pixelCount * 4, "blurTemp");
  const output = ensureScratch(scratch, pixelCount * 4, "blurOutput");
  const boxRadius = Math.max(1, Math.round(radius / 2));

  temp.set(data);
  for (let pass = 0; pass < passes; pass++) {
    boxBlur(temp, output, width, height, boxRadius, true);
    boxBlur(output, temp, width, height, boxRadius, false);
  }
  copyFloatToBytes(temp, data, pixelCount);
  return image;
}

function boxBlur(source, target, width, height, radius, horizontal) {
  const windowSize = radius * 2 + 1;

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const sourceIndex = (row * width + column) * 4;
      const alpha = source[sourceIndex + 3];
      target[sourceIndex] = source[sourceIndex] * alpha;
      target[sourceIndex + 1] = source[sourceIndex + 1] * alpha;
      target[sourceIndex + 2] = source[sourceIndex + 2] * alpha;
      target[sourceIndex + 3] = alpha;
    }
  }

  if (horizontal) {
    for (let row = 0; row < height; row++) {
      slideRow(target, source, row * width, width, radius, windowSize);
    }
  } else {
    for (let column = 0; column < width; column++) {
      slideColumn(target, source, column, width, height, radius, windowSize);
    }
  }
}

function slideRow(input, output, start, width, radius, windowSize) {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;

  for (let offset = -radius; offset <= radius; offset++) {
    const index = (start + Math.min(width - 1, Math.max(0, offset))) * 4;
    sumR += input[index];
    sumG += input[index + 1];
    sumB += input[index + 2];
    sumA += input[index + 3];
  }

  for (let column = 0; column < width; column++) {
    const outIndex = (start + column) * 4;
    writeWeighted(output, outIndex, sumR, sumG, sumB, sumA, windowSize);

    const removeColumn = Math.max(0, column - radius);
    const addColumn = Math.min(width - 1, column + radius + 1);
    const removeIndex = (start + removeColumn) * 4;
    const addIndex = (start + addColumn) * 4;
    sumR += input[addIndex] - input[removeIndex];
    sumG += input[addIndex + 1] - input[removeIndex + 1];
    sumB += input[addIndex + 2] - input[removeIndex + 2];
    sumA += input[addIndex + 3] - input[removeIndex + 3];
  }
}

function slideColumn(input, output, column, width, height, radius, windowSize) {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;

  for (let offset = -radius; offset <= radius; offset++) {
    const index = (Math.min(height - 1, Math.max(0, offset)) * width + column) * 4;
    sumR += input[index];
    sumG += input[index + 1];
    sumB += input[index + 2];
    sumA += input[index + 3];
  }

  for (let row = 0; row < height; row++) {
    const outIndex = (row * width + column) * 4;
    writeWeighted(output, outIndex, sumR, sumG, sumB, sumA, windowSize);

    const removeRow = Math.max(0, row - radius);
    const addRow = Math.min(height - 1, row + radius + 1);
    const removeIndex = (removeRow * width + column) * 4;
    const addIndex = (addRow * width + column) * 4;
    sumR += input[addIndex] - input[removeIndex];
    sumG += input[addIndex + 1] - input[removeIndex + 1];
    sumB += input[addIndex + 2] - input[removeIndex + 2];
    sumA += input[addIndex + 3] - input[removeIndex + 3];
  }
}

function writeWeighted(target, index, sumR, sumG, sumB, sumA, windowSize) {
  const averageAlpha = sumA / windowSize;
  target[index] = averageAlpha > 0 ? sumR / sumA : 0;
  target[index + 1] = averageAlpha > 0 ? sumG / sumA : 0;
  target[index + 2] = averageAlpha > 0 ? sumB / sumA : 0;
  target[index + 3] = clamp255(averageAlpha);
}

function copyFloatToBytes(source, target, pixelCount) {
  const length = pixelCount * 4;
  for (let index = 0; index < length; index += 4) {
    target[index] = clamp255(Math.round(source[index]));
    target[index + 1] = clamp255(Math.round(source[index + 1]));
    target[index + 2] = clamp255(Math.round(source[index + 2]));
    target[index + 3] = clamp255(Math.round(source[index + 3]));
  }
}

function applySharpen(image, percent, scratch) {
  const amount = Math.min(200, Math.max(0, percent)) / 100;
  if (amount === 0) return image;
  const center = 1 + 4 * amount;
  const side = -amount;
  return convolve(image, [0, side, 0, side, center, side, 0, side, 0], scratch);
}

function applyEdges(image, percent, scratch) {
  const amount = Math.min(100, Math.max(0, percent)) / 100;
  if (amount === 0) return image;

  const { width, height, data } = image;
  const pixelCount = width * height;
  const gray = ensureScratch(scratch, pixelCount, "edgeGray");
  const output = ensureScratch(scratch, pixelCount * 4, "edgeOutput");

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const index = pixel * 4;
    gray[pixel] = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) * (data[index + 3] / 255);
  }

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const pixel = row * width + column;
      const gx =
        at(gray, width, height, row - 1, column + 1) -
        at(gray, width, height, row - 1, column - 1) +
        2 * (at(gray, width, height, row, column + 1) - at(gray, width, height, row, column - 1)) +
        at(gray, width, height, row + 1, column + 1) -
        at(gray, width, height, row + 1, column - 1);
      const gy =
        at(gray, width, height, row + 1, column - 1) -
        at(gray, width, height, row - 1, column - 1) +
        2 * (at(gray, width, height, row + 1, column) - at(gray, width, height, row - 1, column)) +
        at(gray, width, height, row + 1, column + 1) -
        at(gray, width, height, row - 1, column + 1);
      const edge = Math.min(255, Math.sqrt(gx * gx + gy * gy));
      const index = pixel * 4;
      const value = clamp255(Math.round(data[index] + (edge - data[index]) * amount));
      output[index] = value;
      output[index + 1] = value;
      output[index + 2] = value;
      output[index + 3] = data[index + 3];
    }
  }

  copyFloatToBytes(output, data, pixelCount);
  return image;
}

function at(values, width, height, row, column) {
  const boundedRow = Math.min(height - 1, Math.max(0, row));
  const boundedColumn = Math.min(width - 1, Math.max(0, column));
  return values[boundedRow * width + boundedColumn];
}

function convolve(image, kernel, scratch) {
  const { width, height, data } = image;
  const pixelCount = width * height;
  const output = ensureScratch(scratch, pixelCount * 4, "convolveOutput");

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const index = (row * width + column) * 4;
      const alpha = data[index + 3] / 255;
      let red = alpha > 0 ? 0 : data[index];
      let green = alpha > 0 ? 0 : data[index + 1];
      let blue = alpha > 0 ? 0 : data[index + 2];

      for (let kernelRow = -1; kernelRow <= 1; kernelRow++) {
        for (let kernelColumn = -1; kernelColumn <= 1; kernelColumn++) {
          const weight = kernel[(kernelRow + 1) * 3 + kernelColumn + 1];
          const sampleRow = Math.min(height - 1, Math.max(0, row + kernelRow));
          const sampleColumn = Math.min(width - 1, Math.max(0, column + kernelColumn));
          const sampleIndex = (sampleRow * width + sampleColumn) * 4;
          const sampleAlpha = data[sampleIndex + 3] / 255;
          if (sampleAlpha === 0) continue;
          red += data[sampleIndex] * weight;
          green += data[sampleIndex + 1] * weight;
          blue += data[sampleIndex + 2] * weight;
        }
      }

      if (alpha > 0) {
        red += (1 - alpha) * data[index] * kernel[4];
        green += (1 - alpha) * data[index + 1] * kernel[4];
        blue += (1 - alpha) * data[index + 2] * kernel[4];
      }

      output[index] = clamp255(red);
      output[index + 1] = clamp255(green);
      output[index + 2] = clamp255(blue);
      output[index + 3] = data[index + 3];
    }
  }

  copyFloatToBytes(output, data, pixelCount);
  return image;
}
