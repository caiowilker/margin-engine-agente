/**
 * Preflight do INI ACBr antes de Assinar / contingência.
 * Fail-closed: INI inconsistente → erro permanente (não emitir errado).
 */
const TOLERANCIA_TOTAIS = 0.05;

function permanente(msg) {
  const err = new Error(msg);
  err.permanente = true;
  return err;
}

/**
 * Lê chave=valor de uma seção INI (primeira ocorrência).
 * Aceita aliases (ex.: mod|modelo).
 */
function lerCampoSecao(iniContent, secao, chaves) {
  const aliases = (Array.isArray(chaves) ? chaves : [chaves]).map((c) =>
    String(c).toLowerCase(),
  );
  const lines = String(iniContent || "").split(/\r?\n/);
  let inSec = false;
  const want = String(secao || "").toLowerCase();
  for (const line of lines) {
    const sect = line.match(/^\[([^\]]+)\]\s*$/);
    if (sect) {
      if (inSec) break;
      inSec = String(sect[1]).trim().toLowerCase() === want;
      continue;
    }
    if (!inSec) continue;
    const m = line.match(/^([^=]+)=(.*)$/);
    if (!m) continue;
    if (aliases.includes(m[1].trim().toLowerCase())) {
      return String(m[2] ?? "").trim();
    }
  }
  return "";
}

function lerMoneySecao(iniContent, secao, chave) {
  const raw = lerCampoSecao(iniContent, secao, chave);
  if (raw === "") return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function temSecaoProduto(iniContent) {
  return /\[Produto0*1\]/i.test(String(iniContent || ""));
}

function temSecaoTotal(iniContent) {
  return /\[Total(s)?\]/i.test(String(iniContent || ""));
}

/**
 * Totais: vNF ≈ vProd − vDesc − vICMSDeson + vST + vFCPST + vFrete + vSeg + vOutro + vII + vIPI
 * (paridade MOC / NfceDocumentBuilder; campos ausentes = 0).
 */
function calcularVnfEsperado(totais) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return (
    Math.round(
      (n(totais.vProd) -
        n(totais.vDesc) -
        n(totais.vICMSDeson) +
        n(totais.vST) +
        n(totais.vFCPST) +
        n(totais.vFrete) +
        n(totais.vSeg) +
        n(totais.vOutro) +
        n(totais.vII) +
        n(totais.vIPI) +
        n(totais.vIPIDevol)) *
        100,
    ) / 100
  );
}

function lerTotaisIni(iniContent) {
  const secao = temSecaoTotal(iniContent)
    ? /\[Totals\]/i.test(iniContent)
      ? "Totals"
      : "Total"
    : "Total";
  const money = (k) => lerMoneySecao(iniContent, secao, k);
  return {
    secao,
    vNF: money("vNF"),
    vProd: money("vProd"),
    vDesc: money("vDesc"),
    vST: money("vST"),
    vFCPST: money("vFCPST"),
    vICMSDeson: money("vICMSDeson"),
    vFrete: money("vFrete"),
    vSeg: money("vSeg"),
    vOutro: money("vOutro"),
    vII: money("vII"),
    vIPI: money("vIPI"),
    vIPIDevol: money("vIPIDevol"),
    vBC: money("vBC"),
    vICMS: money("vICMS"),
    vBCST: money("vBCST"),
  };
}

function assertTotaisConsistentes(iniContent) {
  if (!temSecaoTotal(iniContent)) {
    throw permanente("[IniPreflight] seção [Total] ausente — INI inválido para emissão.");
  }
  const t = lerTotaisIni(iniContent);
  if (t.vProd == null) {
    throw permanente("[IniPreflight] [Total] vProd ausente — INI inválido.");
  }
  if (t.vNF == null) {
    throw permanente("[IniPreflight] [Total] vNF ausente — INI inválido.");
  }
  const esperado = calcularVnfEsperado(t);
  if (Math.abs(esperado - t.vNF) > TOLERANCIA_TOTAIS) {
    throw permanente(
      `[IniPreflight] totais inconsistentes: vNF=${t.vNF.toFixed(2)} ≠ ` +
        `calculado ${esperado.toFixed(2)} ` +
        `(vProd=${(t.vProd ?? 0).toFixed(2)} − vDesc=${(t.vDesc ?? 0).toFixed(2)}` +
        ` + vST=${(t.vST ?? 0).toFixed(2)} + vFCPST=${(t.vFCPST ?? 0).toFixed(2)}` +
        ` + vFrete=${(t.vFrete ?? 0).toFixed(2)} + vOutro=${(t.vOutro ?? 0).toFixed(2)}). Não emitir.`,
    );
  }
  return { ...t, esperado };
}

/**
 * Estrutura mínima NFC-e (mod 65) — online ou offline.
 * @param {string} iniContent
 * @param {{ offline?: boolean }} [opts]
 */
function assertIniNfceEstrutura(iniContent, opts = {}) {
  const ini = String(iniContent || "");
  if (!ini.trim()) {
    throw permanente("[IniPreflight] INI vazio.");
  }

  const mod =
    lerCampoSecao(ini, "Identificacao", ["mod", "modelo"]) ||
    lerCampoSecao(ini, "infNFe", ["mod", "modelo"]);
  if (mod === "55") {
    throw permanente(
      "[IniPreflight] INI modelo 55 (NF-e) — contingência/NFC-e exige mod=65.",
    );
  }
  if (mod && mod !== "65") {
    throw permanente(`[IniPreflight] mod=${mod} inválido para NFC-e (esperado 65).`);
  }

  const cnpj = String(
    lerCampoSecao(ini, "Emitente", ["CNPJCPF", "CNPJ"]) || "",
  ).replace(/\D/g, "");
  if (cnpj.length !== 14) {
    throw permanente(
      "[IniPreflight] Emitente CNPJ inválido (14 dígitos) — não emitir.",
    );
  }

  const nNF = lerCampoSecao(ini, "Identificacao", ["nNF", "Numero", "numero"]);
  const serie = lerCampoSecao(ini, "Identificacao", ["serie", "Serie"]);
  if (!nNF || !String(nNF).replace(/\D/g, "")) {
    throw permanente("[IniPreflight] nNF ausente em [Identificacao].");
  }
  if (!serie || !String(serie).trim()) {
    throw permanente("[IniPreflight] serie ausente em [Identificacao].");
  }

  if (!temSecaoProduto(ini)) {
    throw permanente("[IniPreflight] nenhum [Produto001] — INI sem itens.");
  }

  assertTotaisConsistentes(ini);

  if (opts.offline) {
    const tpEmis = lerCampoSecao(ini, "Identificacao", "tpEmis");
    const dhCont = lerCampoSecao(ini, "Identificacao", "dhCont");
    const xJust = lerCampoSecao(ini, "Identificacao", "xJust");
    if (tpEmis !== "9") {
      throw permanente(
        `[IniPreflight] offline exige tpEmis=9 (obtido ${tpEmis || "ausente"}).`,
      );
    }
    if (!dhCont || dhCont === "0") {
      throw permanente("[IniPreflight] offline exige dhCont válido (SEFAZ 557).");
    }
    if (!xJust || xJust.length < 15) {
      throw permanente("[IniPreflight] offline exige xJust ≥ 15 chars (SEFAZ 557).");
    }
  }

  return {
    mod: mod || "65",
    cnpj,
    nNF,
    serie,
  };
}

module.exports = {
  TOLERANCIA_TOTAIS,
  lerCampoSecao,
  lerMoneySecao,
  lerTotaisIni,
  calcularVnfEsperado,
  assertTotaisConsistentes,
  assertIniNfceEstrutura,
  temSecaoProduto,
  temSecaoTotal,
};
