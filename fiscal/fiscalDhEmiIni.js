/**
 * Datas dhEmi/dhSaiEnt/dhCont no INI ACBr — formato oficial: DD/MM/YYYY HH:mm:ss
 * (https://acbr.sourceforge.io/ACBrLib/ModeloNFeINI.html)
 *
 * O backend MFCS pode enviar ISO (2026-06-30T23:48:44-03:00); a Lib rejeita com -10.
 */

const CAMPOS_DH = new Set(["dhemi", "dhsaient", "dhcont"]);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatarDhEmiAcbrIni(data = new Date()) {
  const d = data instanceof Date ? data : parseDhEmiValor(data);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function parseDhEmiValor(valor) {
  const s = String(valor ?? "").trim();
  if (!s || s === "0") return new Date();

  const iso = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/,
  );
  if (iso) {
    return new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4]),
      Number(iso[5]),
      Number(iso[6]),
    );
  }

  const hibrido = s.match(
    /^(\d{4})\/(\d{2})\/(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  );
  if (hibrido) {
    return new Date(
      Number(hibrido[1]),
      Number(hibrido[2]) - 1,
      Number(hibrido[3]),
      Number(hibrido[4]),
      Number(hibrido[5]),
      Number(hibrido[6]),
    );
  }

  const br = s.match(
    /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/,
  );
  if (br) {
    return new Date(
      Number(br[3]),
      Number(br[2]) - 1,
      Number(br[1]),
      Number(br[4]),
      Number(br[5]),
      Number(br[6]),
    );
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizarCampoDhIni(linha, valorForcado) {
  const m = String(linha).match(/^(dhEmi|dhSaiEnt|dhCont)=(.*)$/i);
  if (!m) return linha;
  const campo = m[1];
  const raw = valorForcado != null ? valorForcado : m[2];
  const v = String(raw).trim();
  if (!v || v === "0") return `${campo}=`;
  return `${campo}=${formatarDhEmiAcbrIni(parseDhEmiValor(v))}`;
}

/**
 * Converte dhEmi/dhSaiEnt/dhCont para formato ACBr INI.
 * @param {string} ini
 * @param {{ atualizarParaAgora?: boolean }} [opts]
 */
function normalizarDatasIni(ini, opts = {}) {
  if (!ini) return ini;
  const agora = opts.atualizarParaAgora ? formatarDhEmiAcbrIni(new Date()) : null;
  return String(ini)
    .split(/\r?\n/)
    .map((line) => {
      const key = line.split("=")[0]?.trim().toLowerCase();
      if (!CAMPOS_DH.has(key)) return line;
      if (agora) {
        const campo = line.match(/^(dhEmi|dhSaiEnt|dhCont)=/i)?.[1] || "dhEmi";
        return `${campo}=${agora}`;
      }
      return normalizarCampoDhIni(line);
    })
    .join("\n");
}

function prepararIniParaEmissao(ini, opts = {}) {
  return normalizarDatasIni(ini, { atualizarParaAgora: true, ...opts });
}

module.exports = {
  formatarDhEmiAcbrIni,
  parseDhEmiValor,
  normalizarDatasIni,
  prepararIniParaEmissao,
};
