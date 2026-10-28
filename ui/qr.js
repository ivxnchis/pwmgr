// QR decoding for images, pasted screenshots and tab captures, using the bundled jsQR
// (loaded by a classic <script> tag as window.jsQR).

function scan(source, scale) {
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return window.jsQR(data, w, h, { inversionAttempts: 'attemptBoth' })?.data || null;
}

export async function decodeQr(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const big = Math.max(bitmap.width, bitmap.height);
    // Large photos/screenshots decode faster and often better when scaled down.
    const scales = big > 1600 ? [1600 / big, 1, 800 / big] : [1, 0.5];
    for (const s of scales) {
      const text = scan(bitmap, s);
      if (text) return text;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

export function imageFromClipboard(ev) {
  for (const item of ev.clipboardData?.items || []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

// Formats "123456" as "123 456" for readability.
export function prettyCode(code) {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}
