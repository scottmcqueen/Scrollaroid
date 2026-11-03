// Building blocks for evidence exports: hashing, PNG metadata, a visible
// provenance footer, a ZIP writer and a small PDF writer. All local, no libraries.

/* ------------------------------ hashing ------------------------------ */

export async function sha256Hex(data) {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* --------------------------- PNG metadata ---------------------------- */

// Insert iTXt (UTF-8 text) chunks right after the PNG header chunk. Pixels are untouched.
export function addPngText(png, entries) {
  const IHDR_END = 8 + 25; // signature + IHDR chunk
  const chunks = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value == null || value === '') continue;
    const data = concat([utf8(key), new Uint8Array([0, 0, 0, 0, 0]), utf8(String(value))]);
    const type = utf8('iTXt');
    const chunk = new Uint8Array(12 + data.length);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    chunk.set(type, 4);
    chunk.set(data, 8);
    dv.setUint32(8 + data.length, crc32(concat([type, data])));
    chunks.push(chunk);
  }
  return concat([png.subarray(0, IHDR_END), ...chunks, png.subarray(IHDR_END)]);
}

/* ------------------------- provenance footer ------------------------- */

// Returns a new canvas: the image with a band of provenance text underneath.
export function withFooter(src, lines) {
  const size = Math.max(13, Math.round(src.width / 95));
  const pad = Math.round(size * 0.9);
  const lineH = Math.round(size * 1.45);
  const h = pad * 2 + lineH * lines.length;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height + h;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  ctx.fillStyle = '#f4f4f2';
  ctx.fillRect(0, src.height, out.width, h);
  ctx.fillStyle = '#c9c9c4';
  ctx.fillRect(0, src.height, out.width, Math.max(1, Math.round(size / 10)));
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.font = `${i === 0 ? '600 ' : ''}${size}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.fillStyle = i === 0 ? '#111' : '#333';
    ctx.fillText(fit(ctx, line, out.width - pad * 2), pad, src.height + pad + i * lineH);
  });
  return out;
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

/* -------------------------------- ZIP -------------------------------- */

// Stored (uncompressed) ZIP: PNG and PDF data is already compressed.
export function makeZip(files, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = utf8(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);

    parts.push(local, f.data);
    central.push(cen);
    offset += local.length + f.data.length;
  }

  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/* -------------------------------- PDF -------------------------------- */

const PAGE_W = 595; // A4 in points
const PAGE_H = 842;
const MARGIN = 44;
const FONTS = { regular: 'F1', bold: 'F2', mono: 'F3' };
const CSS_FONTS = { regular: 'Helvetica, Arial, sans-serif', bold: 'bold Helvetica, Arial, sans-serif', mono: 'Courier, "Courier New", monospace' };

// PDF standard fonts only cover Latin-1; swap out anything else.
function latin1(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/×/g, 'x')
    .replace(/[^ -~ -ÿ]/g, '?');
}

const pdfString = (s) => `(${latin1(s).replace(/[\\()]/g, (c) => `\\${c}`)})`;

const measureCtx = document.createElement('canvas').getContext('2d');
function textWidth(text, font, size) {
  measureCtx.font = `${font === 'bold' ? 'bold ' : ''}${size}px ${CSS_FONTS[font].replace(/^bold /, '')}`;
  return measureCtx.measureText(latin1(text)).width;
}

function wrap(text, font, size, max) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (textWidth(next, font, size) <= max || !line) {
        line = next;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
      // Break very long unbroken strings (URLs, hashes).
      while (textWidth(line, font, size) > max) {
        let cut = line.length;
        while (cut > 1 && textWidth(line.slice(0, cut), font, size) > max) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export class PdfReport {
  constructor() {
    this.pages = []; // {ops: string[], image?: {bytes, w, h}}
    this.newPage();
  }

  newPage() {
    this.page = { ops: [] };
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  ensure(h) {
    if (this.y - h < MARGIN + 20) this.newPage();
  }

  text(str, { font = 'regular', size = 10, gap = 4, color = 0, indent = 0 } = {}) {
    const lines = wrap(str, font, size, PAGE_W - MARGIN * 2 - indent);
    for (const line of lines) {
      this.ensure(size + gap);
      this.y -= size;
      this.page.ops.push(`BT ${color} g /${FONTS[font]} ${size} Tf ${MARGIN + indent} ${this.y.toFixed(2)} Td ${pdfString(line)} Tj ET`);
      this.y -= gap;
    }
  }

  space(h) {
    this.y -= h;
  }

  rule() {
    this.ensure(10);
    this.y -= 4;
    this.page.ops.push(`0.8 G 0.5 w ${MARGIN} ${this.y} m ${PAGE_W - MARGIN} ${this.y} l S`);
    this.y -= 8;
  }

  field(label, value) {
    const labelW = 120;
    const lines = wrap(value || '-', 'regular', 9.5, PAGE_W - MARGIN * 2 - labelW);
    this.ensure(13 * Math.min(lines.length, 3));
    const top = this.y;
    this.y -= 9.5;
    this.page.ops.push(`BT 0.35 g /F2 9 Tf ${MARGIN} ${this.y.toFixed(2)} Td ${pdfString(label)} Tj ET`);
    this.y = top;
    for (const line of lines) {
      this.ensure(13);
      this.y -= 9.5;
      this.page.ops.push(`BT 0 g /F1 9.5 Tf ${MARGIN + labelW} ${this.y.toFixed(2)} Td ${pdfString(line)} Tj ET`);
      this.y -= 3.5;
    }
    this.y -= 2;
  }

  // A full page holding one JPEG, with a caption line at the top.
  imagePage(bytes, w, h, caption) {
    this.newPage();
    this.text(caption, { size: 8.5, color: 0.4 });
    const maxW = PAGE_W - MARGIN * 2;
    const maxH = this.y - MARGIN;
    const s = Math.min(maxW / w, maxH / h);
    const dw = w * s, dh = h * s;
    const x = MARGIN + (maxW - dw) / 2;
    const y = this.y - dh;
    this.page.image = { bytes, w, h };
    this.page.ops.push(`q 0.75 G 0.5 w ${x - 0.5} ${y - 0.5} ${dw + 1} ${dh + 1} re S Q`);
    this.page.ops.push(`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im1 Do Q`);
    this.y = y - 6;
  }

  // Usable height (pt) for an image page, so callers can slice tall images.
  static imageArea() {
    return { w: PAGE_W - MARGIN * 2, h: PAGE_H - MARGIN * 2 - 16 };
  }

  build(footerText) {
    const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    const objects = []; // index = object id - 1
    const add = (parts) => {
      objects.push(parts);
      return objects.length;
    };

    const catalogId = add(null);
    const pagesId = add(null);
    const f1 = add([enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')]);
    const f2 = add([enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')]);
    const f3 = add([enc('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>')]);
    const fonts = `/Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >>`;

    const pageIds = [];
    this.pages.forEach((p, i) => {
      const ops = [...p.ops];
      ops.push(`BT 0.5 g /F1 7.5 Tf ${MARGIN} 24 Td ${pdfString(`${footerText}  |  Page ${i + 1} of ${this.pages.length}`)} Tj ET`);
      const content = enc(ops.join('\n'));
      const contentId = add([enc(`<< /Length ${content.length} >>\nstream\n`), content, enc('\nendstream')]);
      let res = `<< ${fonts}`;
      if (p.image) {
        const imgId = add([
          enc(`<< /Type /XObject /Subtype /Image /Width ${p.image.w} /Height ${p.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.image.bytes.length} >>\nstream\n`),
          p.image.bytes,
          enc('\nendstream'),
        ]);
        res += ` /XObject << /Im1 ${imgId} 0 R >>`;
      }
      res += ' >>';
      pageIds.push(add([enc(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${res} /Contents ${contentId} 0 R >>`)]));
    });
    objects[catalogId - 1] = [enc(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)];
    objects[pagesId - 1] = [enc(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)];

    const out = [enc('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
    let offset = out[0].length;
    const offsets = [];
    objects.forEach((parts, i) => {
      offsets.push(offset);
      const chunk = [enc(`${i + 1} 0 obj\n`), ...parts, enc('\nendobj\n')];
      for (const c of chunk) {
        out.push(c);
        offset += c.length;
      }
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    out.push(enc(xref), enc(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
    return concat(out);
  }
}
