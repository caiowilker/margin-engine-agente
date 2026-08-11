/**
 * Dialetos ESC/POS de código de barras — sem depender do bug de `escpos.utils.codeLength`
 * (omite o byte `n` para payloads < 16 chars → Elgin i9 imprime "?").
 *
 * Referência Elgin i9 (manual programação):
 *   Função B CODE128: GS k m=73 n d1…dn  com d1=0x7B `{`, d2=A|B|C
 *   (sem NUL após os dados)
 *
 * Dialetos:
 *   epson   — Function B + {B (Epson / genéricas ESC/POS)
 *   elgin   — igual Epson + largura máx. 2 (i9 recusa barras largas demais)
 *   bematech — Function B + {B (MP-4200 aceita; fallback CODE39 se preferido)
 *   daruma  — Function B + {B
 *   code39  — só CODE39 (após confirmação visual negativa)
 */
const DIALECTS = Object.freeze({
  epson: {
    id: "epson",
    label: "Genérica / Epson",
    maxWidth: 3,
    code128Charset: "B",
    preferCode39: false,
    dualCode39: false,
  },
  elgin: {
    id: "elgin",
    label: "Elgin (i7/i9)",
    maxWidth: 2,
    code128Charset: "B",
    preferCode39: false,
    dualCode39: true, // CODE128 + CODE39 — i9 às vezes falha silencioso no 128
  },
  bematech: {
    id: "bematech",
    label: "Bematech",
    maxWidth: 2,
    code128Charset: "B",
    preferCode39: false,
    dualCode39: false,
  },
  daruma: {
    id: "daruma",
    label: "Daruma",
    maxWidth: 2,
    code128Charset: "B",
    preferCode39: false,
    dualCode39: false,
  },
  code39: {
    id: "code39",
    label: "Só CODE39 (fallback)",
    maxWidth: 2,
    code128Charset: "B",
    preferCode39: true,
    dualCode39: false,
  },
});

/** Mapa modelo ACBr → dialeto barcode nativo. */
const ACBR_MODELO_TO_DIALECT = Object.freeze({
  "1": "epson",
  "2": "bematech",
  "3": "daruma",
  "0": "epson",
  "5": "epson",
  "6": "epson",
  "8": "epson",
});

function normalizeDialectId(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (DIALECTS[s]) return s;
  if (s === "generic" || s === "generica" || s === "genérica" || s === "escpos") {
    return "epson";
  }
  if (/elgin|i9|i7/.test(s)) return "elgin";
  if (/bematech|mp-?4200/.test(s)) return "bematech";
  if (/daruma|dr800|dr700/.test(s)) return "daruma";
  if (/code.?39|fallback/.test(s)) return "code39";
  return null;
}

/**
 * Resolve dialeto efetivo: PRINTER_BARCODE_DIALECT > inferência por nome > modelo ACBr.
 */
function resolveBarcodeDialect(opts = {}) {
  const explicit =
    normalizeDialectId(opts.dialect) ||
    normalizeDialectId(process.env.PRINTER_BARCODE_DIALECT);
  if (explicit) return DIALECTS[explicit];

  const nome = `${opts.nomeImpressora || ""} ${process.env.PRINTER_NAME || ""}`;
  if (/elgin|i9|i7/i.test(nome)) return DIALECTS.elgin;
  if (/bematech|mp-?4200/i.test(nome)) return DIALECTS.bematech;
  if (/daruma|dr800|dr700/i.test(nome)) return DIALECTS.daruma;

  const modelo = String(
    opts.modeloAcbr != null ? opts.modeloAcbr : process.env.PRINTER_MODEL || "1",
  );
  const mapped = ACBR_MODELO_TO_DIALECT[modelo] || "epson";
  return DIALECTS[mapped] || DIALECTS.epson;
}

function encodeCode128Payload(code, charset = "B") {
  const raw = String(code || "");
  if (!raw) return "";
  if (/^\{[ABC]/.test(raw)) return raw;
  const cs = String(charset || "B").toUpperCase().slice(0, 1);
  const safe = ["A", "B", "C"].includes(cs) ? cs : "B";
  return `{${safe}${raw}`;
}

function sanitizeCode39(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^0-9A-Z\-.\s/$+%]/g, "");
}

/** Hex dump legível para diagnóstico (Elgin vs Epson). */
function bytesToHexDump(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return [...b]
    .map((n) => n.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/**
 * CODE128 Function B — Epson/Elgin: 1D 6B 49 n {B…  (SEM NUL)
 * Corrige o bug do escpos que omitia `n` para len < 16.
 */
function buildCode128FunctionB(code, opts = {}) {
  const charset = opts.charset || "B";
  const data = encodeCode128Payload(code, charset);
  if (!data) return null;
  const dataBuf = Buffer.from(data, "ascii");
  if (dataBuf.length < 2 || dataBuf.length > 255) return null;
  // Elgin: d1=123 `{`, d2=A|B|C
  if (dataBuf[0] !== 0x7b || dataBuf[1] < 0x41 || dataBuf[1] > 0x43) {
    return null;
  }
  return Buffer.concat([
    Buffer.from([0x1d, 0x6b, 0x49, dataBuf.length]),
    dataBuf,
  ]);
}

/**
 * CODE39 Function A (NUL-terminated): 1D 6B 04 d1…dk 00
 * Mais compatível em firmwares antigos / Elgin quando 128 falha.
 */
function buildCode39FunctionA(code) {
  const c39 = sanitizeCode39(code);
  if (!c39) return null;
  const dataBuf = Buffer.from(c39, "ascii");
  return Buffer.concat([
    Buffer.from([0x1d, 0x6b, 0x04]),
    dataBuf,
    Buffer.from([0x00]),
  ]);
}

/** CODE39 Function B: 1D 6B 45 n d1…dn */
function buildCode39FunctionB(code) {
  const c39 = sanitizeCode39(code);
  if (!c39) return null;
  const dataBuf = Buffer.from(c39, "ascii");
  if (dataBuf.length < 1 || dataBuf.length > 255) return null;
  return Buffer.concat([
    Buffer.from([0x1d, 0x6b, 0x45, dataBuf.length]),
    dataBuf,
  ]);
}

function buildBarcodeSetup(opts = {}) {
  const height = Math.max(20, Math.min(255, Number(opts.altura) || 64));
  let width = Math.max(1, Math.min(5, Number(opts.largura) || 2));
  if (opts.maxWidth != null) {
    width = Math.min(width, Number(opts.maxWidth) || width);
  }
  // GS w: escpos map 1→02 … 5→06; Elgin aceita 2–6 no módulo
  const widthCmd = 0x01 + width; // 1→2 … 5→6
  const hri =
    opts.exibe === false
      ? 0x00
      : 0x02; // abaixo
  return Buffer.from([
    0x1d, 0x77, widthCmd, // GS w n
    0x1d, 0x68, height, // GS h n
    0x1d, 0x66, 0x00, // GS f 0 — font A
    0x1d, 0x48, hri, // GS H n
  ]);
}

/**
 * Monta sequência completa (setup + barcodes) para um código, segundo o dialeto.
 * @returns {{ buffers: Buffer[], plan: object[], hexDumps: string[] }}
 */
function buildBarcodeSequence(code, opts = {}) {
  const dialect = resolveBarcodeDialect(opts);
  const setup = buildBarcodeSetup({
    altura: opts.altura,
    largura: opts.largura,
    exibe: opts.exibe,
    maxWidth: dialect.maxWidth,
  });
  const plan = [];
  const buffers = [setup];
  const hexDumps = [];

  const push = (tipo, buf, note) => {
    if (!buf) return;
    buffers.push(buf);
    const hex = bytesToHexDump(buf);
    hexDumps.push(hex);
    plan.push({ tipo, note, hex, byteLength: buf.length });
  };

  const forceFail = opts.forceCode128Fail === true;
  const singleOnly = opts.singleOnly === true;
  const want128 = !dialect.preferCode39 && !forceFail;
  let want39 = dialect.preferCode39 || dialect.dualCode39 || forceFail || opts.forceCode39 === true;
  // Cupom/etiqueta com uma só simbologia (ex.: vasilhame) — sem dual CODE128+CODE39.
  if (singleOnly) {
    want39 = dialect.preferCode39 || forceFail || opts.forceCode39 === true;
  }

  if (want128) {
    const b128 = buildCode128FunctionB(code, { charset: dialect.code128Charset });
    push("CODE128", b128, `${dialect.id} Function B + {${dialect.code128Charset}`);
  }
  if (want39 && (!singleOnly || !want128)) {
    // Elgin/Daruma: Function A (NUL) é o mais testado no campo BR
    const useFnB = dialect.id === "epson" && !dialect.dualCode39;
    const b39 = useFnB ? buildCode39FunctionB(code) : buildCode39FunctionA(code);
    push("CODE39", b39, useFnB ? "Function B" : "Function A + NUL");
  }

  return {
    dialect: dialect.id,
    buffers,
    plan,
    hexDumps,
    fullHex: bytesToHexDump(Buffer.concat(buffers)),
  };
}

/**
 * Envia barcodes via printer.raw (não usa escpos.barcode — bug do n).
 * @returns {{ printed: number, dialect: string, plan: object[], fullHex: string }}
 */
function printBarcodesWithDialect(printer, code, opts = {}) {
  const seq = buildBarcodeSequence(code, opts);
  if (typeof printer.align === "function") printer.align("ct");
  for (const buf of seq.buffers) {
    if (typeof printer.raw === "function") {
      printer.raw(buf);
    } else if (typeof printer.print === "function") {
      printer.print(buf);
    } else {
      throw new Error("printer sem raw/print para barcode");
    }
  }
  if (typeof printer.feed === "function") printer.feed(1);
  if (typeof printer.align === "function") printer.align("lt");
  return {
    printed: seq.plan.length,
    dialect: seq.dialect,
    plan: seq.plan,
    fullHex: seq.fullHex,
  };
}

/** Próximo dialeto após confirmação visual negativa. */
function nextDialectAfterVisualFail(currentId) {
  const order = ["epson", "elgin", "bematech", "daruma", "code39"];
  const cur = normalizeDialectId(currentId) || "epson";
  const idx = order.indexOf(cur);
  if (idx < 0 || idx >= order.length - 1) return "code39";
  return order[idx + 1];
}

module.exports = {
  DIALECTS,
  ACBR_MODELO_TO_DIALECT,
  normalizeDialectId,
  resolveBarcodeDialect,
  encodeCode128Payload,
  sanitizeCode39,
  bytesToHexDump,
  buildCode128FunctionB,
  buildCode39FunctionA,
  buildCode39FunctionB,
  buildBarcodeSetup,
  buildBarcodeSequence,
  printBarcodesWithDialect,
  nextDialectAfterVisualFail,
};
