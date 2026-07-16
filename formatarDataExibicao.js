/**
 * Exibição de datas pt-BR no agente (painel diagnóstico / strings enterprise).
 * Espelho da regra do front: SQLite com espaço = UTC; LocalDateTime com T = local.
 */

const RE_SQLITE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const RE_ISO_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i;
const RE_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_BR =
  /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const RE_EMBEDDED =
  /(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{2}\/\d{2}\/\d{4}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)/g;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseDataExibicao(raw) {
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
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (RE_ISO_OFFSET.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const dateOnly = s.match(RE_DATE_ONLY);
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(d.getTime()) ? null : d;
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
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatarDataHoraExibicao(raw, opts = {}) {
  const fallback = opts.fallback != null ? opts.fallback : "—";
  const date = raw instanceof Date
    ? (Number.isNaN(raw.getTime()) ? null : raw)
    : parseDataExibicao(raw);
  if (!date) {
    if (raw == null || raw === "") return fallback;
    if (typeof raw === "string" && raw.trim() && raw !== "—") return raw.trim();
    return fallback;
  }
  if (opts.soData) {
    return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
  }
  const base = `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (opts.comSegundos) {
    return `${base}:${pad2(date.getSeconds())}`;
  }
  return base;
}

function formatarDatasEmTexto(texto, opts = {}) {
  if (texto == null || texto === "") return opts.fallback != null ? opts.fallback : "—";
  return String(texto).replace(RE_EMBEDDED, (match) =>
    formatarDataHoraExibicao(match, { ...opts, fallback: match }),
  );
}

module.exports = {
  parseDataExibicao,
  formatarDataHoraExibicao,
  formatarDatasEmTexto,
};
