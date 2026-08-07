/**
 * Impressão raw de etiqueta térmica (ZPL / PPLA).
 * Sempre bypassa ACBr PosPrinter — bytes vão direto ao spooler/TCP :9100.
 */
const log = require("../logger").child({ modulo: "raw_label_print" });

const MAX_COPIES = 99;
const MAX_BYTES = 512 * 1024; // 512 KiB — etiqueta típica é < 4 KiB

/**
 * @param {object} payload
 * @returns {{ data: string, encoding: "utf8"|"latin1"|"base64", copies: number, porta: string|null, formato: string|null }}
 */
function normalizarPayloadRaw(payload = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Payload de etiqueta inválido.");
  }

  const formato = String(payload.formato || payload.format || "")
    .trim()
    .toLowerCase() || null;

  let encoding = String(payload.encoding || "").trim().toLowerCase();
  if (encoding !== "utf8" && encoding !== "latin1" && encoding !== "base64") {
    // PPLA usa STX (\u0002) — latin1 preserva byte a byte.
    encoding = formato === "ppla" ? "latin1" : formato === "zpl" ? "utf8" : "latin1";
  }

  const data =
    payload.data != null
      ? String(payload.data)
      : payload.conteudo != null
        ? String(payload.conteudo)
        : payload.zpl != null
          ? String(payload.zpl)
          : payload.ppla != null
            ? String(payload.ppla)
            : "";

  if (!data.trim() && !payload.base64) {
    throw new Error("Etiqueta sem dados (ZPL/PPLA vazio).");
  }

  let copies = parseInt(payload.copies ?? payload.quantidade ?? 1, 10);
  if (!Number.isFinite(copies) || copies < 1) copies = 1;
  if (copies > MAX_COPIES) copies = MAX_COPIES;

  const portaRaw = payload.porta != null ? String(payload.porta).trim() : "";
  const porta = portaRaw || null;
  if (porta && !/^(RAW:|TCP:)/i.test(porta)) {
    throw new Error(
      'Porta da etiqueta deve ser "RAW:NomeDaImpressora" ou "TCP:ip:9100".',
    );
  }

  return {
    data: payload.base64 ? String(payload.base64) : data,
    encoding: payload.base64 ? "base64" : encoding,
    copies,
    porta,
    formato,
  };
}

function bufferFromPayload(norm) {
  const enc = norm.encoding === "utf8" ? "utf8" : norm.encoding;
  const buf = Buffer.from(norm.data, enc);
  if (!buf.length) {
    throw new Error("Buffer da etiqueta vazio após encoding.");
  }
  if (buf.length > MAX_BYTES) {
    throw new Error(`Etiqueta grande demais (${buf.length} bytes; máx ${MAX_BYTES}).`);
  }
  return buf;
}

/**
 * ZPL: uma transmissão com ^PQ{n} (evita N WritePrinter e timeout na fila).
 */
function aplicarCopiasZpl(zpl, copies) {
  if (copies <= 1) return zpl;
  if (/\^PQ\d+/i.test(zpl)) {
    return zpl.replace(/\^PQ\d+/gi, `^PQ${copies}`);
  }
  if (/\^XZ/i.test(zpl)) {
    return zpl.replace(/\^XZ/i, `^PQ${copies}^XZ`);
  }
  return `${zpl}^PQ${copies}`;
}

/**
 * Validação leve de formato (aviso, não bloqueia se formato omitido).
 */
function validarFormatoLeve(buf, formato) {
  if (!formato) return;
  const head = buf.slice(0, Math.min(64, buf.length)).toString("latin1");
  if (formato === "zpl") {
    if (!/\^XA|~[A-Z]{2}/i.test(head) && !buf.includes(0x5e) /* ^ */) {
      throw new Error("Conteúdo não parece ZPL (^XA…). Confira a aba ZPL.");
    }
  }
  if (formato === "ppla") {
    const hasStx = buf[0] === 0x02 || head.includes("\u0002");
    if (!hasStx && !/^L/im.test(head.replace(/^\u0002/, ""))) {
      log.warn({ formato, head: head.slice(0, 20) }, "[RawLabel] PPLA sem STX — enviando mesmo assim");
    }
  }
}

function pareceImpressoraCupom(porta) {
  const n = String(porta || "").replace(/^RAW:/i, "");
  return /pos\s*80|pos80|cupom|nfce|receipt|tm-t|tm-m|i9|i7/i.test(n);
}

/**
 * Envia bytes raw à impressora de etiquetas.
 * ZPL: cópias via ^PQ (1 envio). PPLA: repete o buffer.
 * @param {object} payload
 */
async function imprimirRaw(payload) {
  const norm = normalizarPayloadRaw(payload);

  if (!norm.porta) {
    throw new Error(
      "Selecione a impressora de etiquetas (RAW:Nome ou TCP:ip:9100). " +
        "Não use a térmica de cupom como padrão.",
    );
  }
  if (pareceImpressoraCupom(norm.porta)) {
    throw new Error(
      "A porta escolhida parece impressora de cupom (POS80/NFC-e). " +
        "Selecione a Zebra/Elgin L42 de etiquetas.",
    );
  }

  let data = norm.data;
  let sendCopies = norm.copies;
  if (norm.formato === "zpl" && norm.encoding !== "base64") {
    data = aplicarCopiasZpl(data, norm.copies);
    sendCopies = 1;
  }

  const buf = bufferFromPayload({ ...norm, data });
  validarFormatoLeve(buf, norm.formato);

  const core = require("./escpos/impressoraCore");
  const routes = require("./printerStationRoutes");

  const run = async () => {
    let last = null;
    for (let i = 0; i < sendCopies; i++) {
      last = await core.enviarBuffer(buf);
    }
    return {
      ok: true,
      copies: norm.copies,
      envios: sendCopies,
      bytes: buf.length,
      formato: norm.formato,
      encoding: norm.encoding,
      ...(last && typeof last === "object" ? last : {}),
    };
  };

  log.info(
    {
      metric: "print.etiqueta_raw",
      copies: norm.copies,
      envios: sendCopies,
      bytes: buf.length,
      formato: norm.formato,
      encoding: norm.encoding,
      porta: norm.porta,
    },
    "[RawLabel] Enviando etiqueta raw",
  );

  return routes.withPortaOverride(norm.porta, run);
}

module.exports = {
  MAX_COPIES,
  MAX_BYTES,
  normalizarPayloadRaw,
  bufferFromPayload,
  aplicarCopiasZpl,
  validarFormatoLeve,
  pareceImpressoraCupom,
  imprimirRaw,
};
