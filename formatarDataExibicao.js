/**
 * Exibição de datas pt-BR no agente (comanda, mesa, diagnóstico).
 * Espelho do front: instante absoluto (Z/offset/SQLite UTC) → America/Sao_Paulo.
 * LocalDateTime com T sem fuso = relógio de parede (não converter).
 */

const FUSO_LOJA = "America/Sao_Paulo";

const RE_SQLITE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const RE_ISO_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i;
const RE_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_BR =
  /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T,]+(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const RE_EMBEDDED =
  /(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{2}\/\d{2}\/\d{4}(?:[ T,]\s*\d{2}:\d{2}(?::\d{2})?)?)/g;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseDataExibicaoDetalhada(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "—" || s === "-") return null;

  const br = s.match(RE_BR);
  if (br) {
    const d = new Date(
      Number(br[3]),
      Number(br[2]) - 1,
      Number(br[1]),
      br[4] != null ? Number(br[4]) : 0,
      br[5] != null ? Number(br[5]) : 0,
      br[6] != null ? Number(br[6]) : 0,
    );
    return Number.isNaN(d.getTime()) ? null : { date: d, absoluto: false };
  }

  if (RE_ISO_OFFSET.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : { date: d, absoluto: true };
  }

  const dateOnly = s.match(RE_DATE_ONLY);
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(d.getTime()) ? null : { date: d, absoluto: false };
  }

  const naive = s.match(RE_SQLITE);
  if (naive) {
    const y = Number(naive[1]);
    const mo = Number(naive[2]) - 1;
    const day = Number(naive[3]);
    const h = Number(naive[4]);
    const mi = Number(naive[5]);
    const se = Number(naive[6]);
    const asUtc = s.includes(" ");
    const d = asUtc
      ? new Date(Date.UTC(y, mo, day, h, mi, se))
      : new Date(y, mo, day, h, mi, se);
    return Number.isNaN(d.getTime()) ? null : { date: d, absoluto: asUtc };
  }

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const absoluto = /Z|[+-]\d{2}:?\d{2}$/i.test(s);
  return { date: d, absoluto };
}

function parseDataExibicao(raw) {
  return parseDataExibicaoDetalhada(raw)?.date ?? null;
}

function formatParts(parts, comSegundos, soData) {
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  const data = `${get("day")}/${get("month")}/${get("year")}`;
  if (soData) return data;
  const hora = `${get("hour")}:${get("minute")}${comSegundos ? `:${get("second")}` : ""}`;
  return `${data} ${hora}`;
}

function formatWallClock(date, opts) {
  if (opts.soData) {
    return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
  }
  const base = `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (opts.comSegundos) {
    return `${base}:${pad2(date.getSeconds())}`;
  }
  return base;
}

function formatAbsolutoLoja(date, opts) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO_LOJA,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(opts.soData
      ? {}
      : {
          hour: "2-digit",
          minute: "2-digit",
          ...(opts.comSegundos ? { second: "2-digit" } : {}),
          hour12: false,
        }),
  }).formatToParts(date);
  return formatParts(parts, Boolean(opts.comSegundos), Boolean(opts.soData));
}

function formatarDataHoraExibicao(raw, opts = {}) {
  const fallback = opts.fallback != null ? opts.fallback : "—";
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return fallback;
    return formatAbsolutoLoja(raw, opts);
  }
  const parsed = parseDataExibicaoDetalhada(raw);
  if (!parsed) {
    if (raw == null || raw === "") return fallback;
    if (typeof raw === "string" && raw.trim() && raw !== "—") return raw.trim();
    return fallback;
  }
  return parsed.absoluto
    ? formatAbsolutoLoja(parsed.date, opts)
    : formatWallClock(parsed.date, opts);
}

function formatarDatasEmTexto(texto, opts = {}) {
  if (texto == null || texto === "") return opts.fallback != null ? opts.fallback : "—";
  return String(texto).replace(RE_EMBEDDED, (match) =>
    formatarDataHoraExibicao(match, { ...opts, fallback: match }),
  );
}

module.exports = {
  FUSO_LOJA,
  parseDataExibicao,
  parseDataExibicaoDetalhada,
  formatarDataHoraExibicao,
  formatarDatasEmTexto,
};
