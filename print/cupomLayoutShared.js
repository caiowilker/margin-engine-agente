/**
 * Layout compartilhado cupom — paridade ACBr tags ↔ ESC/POS nativo.
 * Uma fonte para corte, QR, rodapé e banners (todos os clientes / portas).
 */
const { suggestQrModuleSize } = require("./thermalCols");

const FOOTER = {
  obrigado: "Obrigado pela preferencia!",
  volte: "Volte sempre!",
  pdv: "PDV Margin Engine",
};

const BANNER = {
  offline: "*** MODO OFFLINE ***",
  cancelada: "*** VENDA CANCELADA ***",
  segundaVia: "*** SEGUNDA VIA ***",
};

/** Corte canônico — default partial (ACBr </corte_parcial>). */
function resolveCutMode(tipo) {
  const cut = String(tipo || process.env.PRINTER_CUT || "partial").toLowerCase();
  if (cut === "total" || cut === "full" || cut === "none" || cut === "0") return cut;
  return "partial";
}

function isPartialCut(tipo) {
  const m = resolveCutMode(tipo);
  return m !== "total" && m !== "full" && m !== "none" && m !== "0";
}

/** Aplica corte ESC/POS alinhado a tagCorte(). */
function applyEscposCut(printer, tipo) {
  const mode = resolveCutMode(tipo);
  if (mode === "none" || mode === "0") {
    printer.feed(3);
    return printer;
  }
  const partial = mode !== "total" && mode !== "full";
  return printer.cut(partial);
}

/**
 * Defaults QR — mesmos em ACBr <qrcode> e GS ( k nativo.
 * ErrorLevel M = melhor leitura no salão; módulo por largura térmica.
 */
function resolveQrPrintOpts(opts = {}) {
  let moduleSize = opts.moduleSize;
  if (moduleSize == null || moduleSize === "") {
    moduleSize = process.env.PRINTER_QR_MODULE;
  }
  if (moduleSize == null || moduleSize === "") {
    moduleSize = suggestQrModuleSize();
  }
  moduleSize = Math.min(16, Math.max(1, parseInt(String(moduleSize), 10) || suggestQrModuleSize()));

  const errorLevel = String(
    opts.errorLevel || process.env.PRINTER_QR_ERROR_LEVEL || "M",
  )
    .toUpperCase()
    .slice(0, 1);
  const nivel = ["L", "M", "Q", "H"].includes(errorLevel) ? errorLevel : "M";

  const margem =
    opts.margem != null
      ? Number(opts.margem)
      : parseInt(process.env.PRINTER_QR_MARGEM || "4", 10) || 4;

  const tipo = String(opts.tipo || process.env.PRINTER_QR_TIPO || "2");

  return { moduleSize, errorLevel: nivel, margem, tipo };
}

/** Série padrão impressa (ACBr e native). */
function seriePadraoCupom() {
  return String(process.env.PRINTER_SERIE_PADRAO || "001");
}

/**
 * Banners de status no topo do cupom (paridade ACBr).
 * @returns {string[]}
 */
function bannersStatusCupom(payload) {
  const out = [];
  if (payload?.vendaCancelada) out.push(BANNER.cancelada);
  const origem = payload?.origem;
  if (origem === "offline" || origem === "local") out.push(BANNER.offline);
  return out;
}

/**
 * Specs de barcode a partir do payload (sem tags) — native e testes.
 * @returns {Array<{ tipo: string, code: string }>}
 */
function barcodeSpecsFromPayload(payload) {
  const out = [];
  if (!payload || typeof payload !== "object") return out;
  if (payload.ean13) {
    out.push({ tipo: "EAN13", code: String(payload.ean13).replace(/\D/g, "") });
  }
  if (payload.ean8) {
    out.push({ tipo: "EAN8", code: String(payload.ean8).replace(/\D/g, "") });
  }
  if (payload.code128) {
    out.push({ tipo: "CODE128", code: String(payload.code128) });
  }
  if (Array.isArray(payload.barcodes)) {
    for (const spec of payload.barcodes) {
      if (!spec) continue;
      if (typeof spec === "string") out.push({ tipo: "CODE128", code: spec });
      else {
        const code = String(spec.code || spec.conteudo || "").trim();
        if (code) out.push({ tipo: String(spec.tipo || "CODE128").toUpperCase(), code });
      }
    }
  }
  return out.filter((b) => b.code);
}

/**
 * Epson GS k 73 (CODE128): payload com seletor `{A`/`{B`/`{C`.
 * ACBr PosPrinter NÃO usa este prefixo (codifica sozinho).
 */
function encodeCode128ForEscPos(code) {
  return require("./barcodeDialect").encodeCode128Payload(code, "B");
}

/** CODE39: subset seguro (A–Z, 0–9 e alguns símbolos). */
function sanitizeCode39(code) {
  return require("./barcodeDialect").sanitizeCode39(code);
}

/**
 * Imprime barcodes ESC/POS com dialeto por fabricante.
 * NÃO usa escpos.barcode() para CODE128 — bug do length byte (Elgin "?").
 *
 * @returns {number} quantidade de simbologias enviadas
 */
function imprimirBarcodesEscpos(printer, payload, opts = {}) {
  const specs = barcodeSpecsFromPayload(payload);
  if (!specs.length) return 0;
  const altura =
    opts.altura != null
      ? Number(opts.altura)
      : parseInt(process.env.PRINTER_BARCODE_ALTURA || "50", 10) || 50;
  const largura =
    opts.largura != null
      ? Number(opts.largura)
      : parseInt(process.env.PRINTER_BARCODE_LARGURA || "2", 10) || 2;
  const exibe =
    opts.exibe != null ? !!opts.exibe : process.env.PRINTER_BARCODE_EXIBE !== "false";

  // Caminho legado (testes que injetam barcodeFn)
  if (typeof opts.barcodeFn === "function") {
    const barOpts = {
      width: Math.max(1, Math.min(5, largura || 2)),
      height: Math.max(20, Math.min(255, altura || 50)),
      position: exibe ? "BLW" : "OFF",
    };
    let n = 0;
    printer.align("ct");
    for (const { tipo, code } of specs) {
      if (tipo === "PDF417") continue;
      let ok = false;
      if (tipo === "CODE128") {
        try {
          if (opts.forceCode128Fail) throw new Error("forced CODE128 fail");
          opts.barcodeFn(encodeCode128ForEscPos(code), "CODE128", barOpts);
          printer.feed(1);
          ok = true;
        } catch (_) {
          /* CODE39 */
        }
        if (!ok) {
          const c39 = sanitizeCode39(code);
          if (c39) {
            try {
              opts.barcodeFn(c39, "CODE39", barOpts);
              printer.feed(1);
              ok = true;
            } catch (_) {
              /* ignore */
            }
          }
        }
      } else {
        try {
          opts.barcodeFn(code, tipo, barOpts);
          printer.feed(1);
          ok = true;
        } catch (_) {
          /* ignore */
        }
      }
      if (ok) n += 1;
    }
    printer.align("lt");
    return n;
  }

  const dialectMod = require("./barcodeDialect");
  let total = 0;
  const lastMeta = [];
  for (const { tipo, code } of specs) {
    if (tipo === "PDF417") continue;
    if (tipo === "CODE128" || !tipo) {
      const result = dialectMod.printBarcodesWithDialect(printer, code, {
        altura,
        largura,
        exibe,
        dialect: opts.dialect,
        forceCode128Fail: opts.forceCode128Fail === true,
        forceCode39: opts.forceCode39 === true,
        singleOnly: opts.singleOnly === true,
        modeloAcbr: opts.modeloAcbr,
        nomeImpressora: opts.nomeImpressora,
      });
      total += result.printed;
      lastMeta.push(result);
      try {
        const log = require("../logger").child({ modulo: "barcode_dialect" });
        log.info(
          {
            dialect: result.dialect,
            plan: result.plan,
            fullHex: result.fullHex,
            code: String(code).slice(0, 32),
          },
          "[Barcode] ESC/POS enviado (hex dump)",
        );
      } catch (_) {
        /* logger opcional */
      }
    } else {
      try {
        printer.align("ct");
        printer.barcode(code, tipo, {
          width: Math.max(1, Math.min(5, largura || 2)),
          height: Math.max(20, Math.min(255, altura || 50)),
          position: exibe ? "BLW" : "OFF",
        });
        printer.feed(1);
        printer.align("lt");
        total += 1;
      } catch (_) {
        /* firmware sem tipo */
      }
    }
  }
  if (opts.__collectMeta && lastMeta.length) {
    opts.__collectMeta.push(...lastMeta);
  }
  return total;
}

module.exports = {
  FOOTER,
  BANNER,
  resolveCutMode,
  isPartialCut,
  applyEscposCut,
  resolveQrPrintOpts,
  seriePadraoCupom,
  bannersStatusCupom,
  barcodeSpecsFromPayload,
  encodeCode128ForEscPos,
  sanitizeCode39,
  imprimirBarcodesEscpos,
};
