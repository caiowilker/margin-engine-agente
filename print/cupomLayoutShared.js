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
  contingencia: "*** EMITIDA EM CONTINGENCIA ***",
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
  const sf = String(payload?.statusFiscal || "").toUpperCase();
  if (
    origem === "contingencia" ||
    payload?.contingenciaOffline === true ||
    sf.includes("CONTINGENCIA")
  ) {
    out.push(BANNER.contingencia);
  }
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

/**
 * Linhas de rodapé compacto (não usar no PADRAO — PADRAO fica no código legado).
 * Compacto: obrigado+volte + PDV. Ultra: uma linha.
 */
function footerTextLinesCompact(profile) {
  const mode = profile?.compactFooter;
  if (mode === "single_line") {
    return [`${FOOTER.obrigado} ${FOOTER.volte}`];
  }
  return [`${FOOTER.obrigado} ${FOOTER.volte}`, FOOTER.pdv];
}

/**
 * Tags ACBr do rodapé COMPACTO/ULTRA (sem </linha_simples> prévia).
 * @param {*} profile
 * @param {{ ceCorpo: (s: string) => string }} tags
 */
function footerAcbrTagsCompact(profile, tags) {
  return footerTextLinesCompact(profile).map((t) => tags.ceCorpo(t));
}

/**
 * Rodapé ESC/POS COMPACTO/ULTRA — sem sepEq prévio nem feeds vazios.
 */
function applyFooterEscposCompact(printer, profile) {
  const texts = footerTextLinesCompact(profile);
  printer.align("ct");
  texts.forEach((t, i) => {
    if (i === 0) printer.style("b").text(t).style("normal");
    else printer.text(t);
  });
  return printer;
}

/**
 * Linhas de identificação do documento (nNF/série ± protocolo).
 * Compacto/Ultra: junta protocolo na mesma linha se couber — mesmo texto.
 * @returns {string[]}
 */
function linhasIdDocumentoFiscal(opts = {}) {
  const {
    linhaNumeroSerie,
    protocolo,
    cols = 48,
    compact = false,
  } = opts;
  const base = String(linhaNumeroSerie || "").trim();
  const protRaw = protocolo != null ? String(protocolo).trim() : "";
  const prot = protRaw ? `Protocolo: ${protRaw.slice(0, 30)}` : "";
  if (!compact || !prot) {
    return [base, prot].filter(Boolean);
  }
  const joined = `${base}  ${prot}`;
  if (joined.length <= cols) return [joined];
  return [base, prot];
}

/**
 * Bloco qr_mensagens compacto — remove divisores/labels redundantes.
 * Mantém portal + QR (conteúdo/tamanho). Não altera URL do QR.
 *
 * @param {*} profile
 * @param {{ portalLine?: string, qrContent: string }} ctx
 * @returns {{ portalLine: string|null, qrLabelBefore: null, qrLabelAfter: null, omitSeps: boolean }}
 */
function resolveQrMensagensCompact(profile, ctx = {}) {
  const mode = profile?.compactQrMensagens;
  const portalLine = ctx.portalLine || null;
  if (!mode) {
    return {
      portalLine,
      qrLabelBefore: "Consulta via QR Code",
      qrLabelAfter: "Consulte pela chave ou QR Code",
      omitSeps: false,
    };
  }
  // tight: sem labels redundantes; portal permanece (consulta SEFAZ).
  return {
    portalLine,
    qrLabelBefore: null,
    qrLabelAfter: null,
    omitSeps: true,
  };
}

/**
 * Extrai campos fiscais obrigatórios do dump de tags (ordem estável).
 * Cobre MET DANFE III/IV/V/VI/VII: consulta+URL, chave, protocolo,
 * qtde itens (Volumes), total, pagamentos, pago/troco, consumidor.
 */
function extrairCamposFiscaisObrigatorios(tags) {
  const text = String(tags || "");
  const digits = (text.match(/\b(\d{44})\b/) || [])[1]
    || (text.replace(/\D/g, "").match(/\d{44}/) || [])[0]
    || "";
  // chave pode estar quebrada em grupos de 4
  let chaveGrouped = "";
  const chaveBlock = text.match(
    /Chave de acesso[\s\S]*?(?=Consulte em|Consulta via|\{\{ME_QR_BMP\}\}|<\/corte|$)/i,
  );
  if (chaveBlock) {
    chaveGrouped = (chaveBlock[0].match(/\d{4}(?:\s+\d{4})*/g) || []).join(" ");
  }
  const chaveDigits = (chaveGrouped.replace(/\D/g, "") || digits).slice(0, 44);
  const protocolo = (text.match(/Protocolo:\s*([0-9A-Za-z]+)/i) || [])[1] || "";
  const nfe = (text.match(/NFC-e:\s*(\d+)/i) || [])[1] || "";
  const serie = (text.match(/Serie:\s*(\d+)/i) || [])[1] || "";
  const consultaLine =
    (text.match(/Consulte em\s+[^\n<]+/i) || [])[0]?.replace(/<\/?[^>]+>/g, "").trim() ||
    "";
  const portalRaw = (text.match(/Consulte em\s+([^\s<]+)/i) || [])[1] || "";
  const portal = portalRaw.replace(/<\/?[^>]+>/g, "").trim();
  const qrPlaceholder = /\{\{ME_QR_BMP\}\}/.test(text);
  const qrTag = (text.match(/<qrcode[^>]*>([^<]*)<\/qrcode>/i) || [])[1] || "";
  const titulo = /CUPOM FISCAL NFC-e|DOCUMENTO FISCAL NFC-e/i.test(text);
  const total =
    (text.match(/TOTAL:\s*R?\$?\s*([0-9.,]+)/i) || [])[1] || "";
  const volumes =
    (text.match(/Volumes:\s*([0-9]+)\s*item/i) || [])[1] || "";
  const troco =
    (text.match(/TROCO:\s*R?\$?\s*([0-9.,]+)/i) || [])[1] || "";
  const recebido =
    (text.match(/Recebido:\s*R?\$?\s*([0-9.,]+)/i) || [])[1] || "";
  const pagamentos = [];
  const pgRe = /Pagamento:\s*([^\n<]+)/gi;
  let m;
  while ((m = pgRe.exec(text)) !== null) {
    pagamentos.push(m[1].replace(/<\/?[^>]+>/g, "").trim());
  }
  const cliente =
    (text.match(/Cliente:\s*([^\n<]+)/i) || [])[1]?.replace(/<\/?[^>]+>/g, "").trim() ||
    "";
  const cpf =
    (text.match(/CPF:\s*([^\n<]+)/i) || [])[1]?.replace(/<\/?[^>]+>/g, "").trim() ||
    "";
  return {
    chaveDigits,
    protocolo,
    numeroNfe: nfe,
    serieNfe: serie,
    consultaLine,
    portal,
    qrPlaceholder,
    qrTag,
    temTitulosFiscais: titulo,
    total,
    volumes,
    troco,
    recebido,
    pagamentos,
    cliente,
    cpf,
  };
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
  footerTextLinesCompact,
  footerAcbrTagsCompact,
  applyFooterEscposCompact,
  linhasIdDocumentoFiscal,
  resolveQrMensagensCompact,
  extrairCamposFiscaisObrigatorios,
};
