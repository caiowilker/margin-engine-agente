/**
 * Configuração fiscal local do agente (ACBrLib + .env).
 * Permite alternar homolog/produção, certificado A1, CSC etc. sem editar INI manualmente.
 */
const fs = require("fs");
const path = require("path");
const log = require("./logger").child({ modulo: "fiscal_local_config" });
const { PATHS } = require("./marginPaths");
const fiscalSecrets = require("./fiscalSecrets");
const { desescaparValorEnv } = require("./envFileUtils");

const AGENT_ROOT = path.resolve(__dirname);

const SECOES_AMBIENTE = ["ACBrNFe", "NFe"];
const SECOES_CERT = ["Certificado"];
const SECOES_NFCE = ["NFCe"];
const SECOES_UF = ["DFe", "NFe", "ACBrNFe"];

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveAgentEnvPath() {
  if (process.env.FISCAL_LOCAL_ENV_OVERRIDE) {
    return process.env.FISCAL_LOCAL_ENV_OVERRIDE;
  }
  return path.join(AGENT_ROOT, ".env");
}

function resolveLibIniPath() {
  const explicit = process.env.ACBR_LIB_INI;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    path.join(AGENT_ROOT, "data", "acbrlib.ini"),
    path.join(AGENT_ROOT, "acbrlib", "data", "config", "acbrlib.ini"),
    path.join(PATHS.root, "data", "acbrlib.ini"),
    path.join(PATHS.acbr, "config", "acbrlib.ini"),
    path.join(PATHS.acbr, "acbrlib.ini"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || explicit || null;
}

function resolveLibPath() {
  const explicit = process.env.ACBR_LIB_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const libName = process.platform === "win32" ? "ACBrNFe64.dll" : "libacbrnfe64.so";
  const candidates = [
    path.join(AGENT_ROOT, "acbrlib", "lib", libName),
    path.join(AGENT_ROOT, "lib", libName),
    path.join(PATHS.root, "lib", libName),
  ];
  return candidates.find((p) => fs.existsSync(p)) || explicit || null;
}

function ambienteToTpAmb(amb) {
  const s = String(amb || "").toLowerCase();
  if (s === "producao" || s === "1") return "1";
  return "2";
}

/** ACBrLib [NFe]/[ACBrNFe] Ambiente: 0=produção · 1=homologação (≠ tpAmb SEFAZ). */
function ambienteToAmbienteLib(amb) {
  const s = String(amb || "").toLowerCase();
  if (s === "producao" || s === "1" || s === "0") return "0";
  return "1";
}

function normalizarAmbienteSefaz(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "producao" || s === "produção" || s === "1") return "producao";
  if (s === "homologacao" || s === "homologação" || s === "2") return "homologacao";
  return null;
}

/**
 * Converte valor legado do INI `Ambiente` (tpAmb 1/2 ou enum Lib 0/1) → sefaz.
 * Preferir sempre AMBIENTE_SEFAZ / AmbienteSefaz — este fallback só cobre installs antigos.
 */
function tpAmbToAmbiente(tp) {
  const a = String(tp || "").trim();
  if (a === "0") return "producao"; // enum Lib produção
  if (a === "1") return "producao"; // legado SEFAZ produção (antes de AmbienteSefaz)
  if (a === "2") return "homologacao"; // legado SEFAZ homolog
  return "homologacao";
}

function lerEnvMap() {
  const envPath = resolveAgentEnvPath();
  if (!fs.existsSync(envPath)) return { path: envPath, map: {} };
  const map = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  return { path: envPath, map };
}

function patchEnvContent(content, key, value) {
  const re = new RegExp(`^${escapeReg(key)}=.*$`, "m");
  const line = `${key}=${value ?? ""}`;
  if (re.test(content)) return content.replace(re, line);
  return `${content.replace(/\s*$/, "")}\n${line}\n`;
}

function patchEnv(keys) {
  const { path: envPath, map } = lerEnvMap();
  const driverAnterior = String(
    process.env.ACBR_DRIVER || map.ACBR_DRIVER || "lib",
  ).toLowerCase();
  let content = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  for (const [key, value] of Object.entries(keys)) {
    if (value === undefined) continue;
    content = patchEnvContent(content, key, value);
    process.env[key] = String(value);
    map[key] = String(value);
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content, "utf8");
  if (keys.ACBR_DRIVER != null) {
    const driverNovo = String(keys.ACBR_DRIVER).toLowerCase();
    if (driverNovo !== driverAnterior) {
      try {
        require("./fiscal/factory").resetFiscalDriver();
        log.info(
          { de: driverAnterior, para: driverNovo },
          "[FiscalLocalConfig] Driver fiscal alterado — cache invalidado (reinicie o agente para efetivar)",
        );
      } catch (_) {
        /* testes isolados */
      }
    }
  }
  return map;
}

function parseIni(raw) {
  /** @type {Record<string, Record<string, string>>} */
  const sections = {};
  let current = "__global__";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) continue;
    const sec = trimmed.match(/^\[([^\]]+)\]$/);
    if (sec) {
      current = sec[1];
      if (!sections[current]) sections[current] = {};
      continue;
    }
    const kv = trimmed.match(/^([^=]+)=(.*)$/);
    if (kv) {
      if (!sections[current]) sections[current] = {};
      sections[current][kv[1].trim()] = kv[2];
    }
  }
  return sections;
}

function getIniValue(sections, keys) {
  for (const [sec, key] of keys) {
    const v = sections[sec]?.[key];
    if (v != null && v !== "") return v;
  }
  return "";
}

function upsertIniKey(raw, section, key, value) {
  const secRe = new RegExp(`(\\[${escapeReg(section)}\\][\\s\\S]*?)(?=\\n\\[|$)`);
  const match = raw.match(secRe);
  const line = `${key}=${value}`;
  if (match) {
    const block = match[1];
    const keyRe = new RegExp(`^${escapeReg(key)}=.*$`, "m");
    const nextBlock = keyRe.test(block)
      ? block.replace(keyRe, line)
      : `${block.replace(/\s*$/, "")}\n${line}\n`;
    return raw.replace(secRe, nextBlock);
  }
  const suffix = raw.endsWith("\n") ? "" : "\n";
  return `${raw}${suffix}\n[${section}]\n${line}\n`;
}

function ensureIniFile(iniPath) {
  if (iniPath && fs.existsSync(iniPath)) return iniPath;
  const dest =
    iniPath ||
    path.join(AGENT_ROOT, "acbrlib", "data", "config", "acbrlib.ini");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const { gravarIni } = require("./runtime/acbrIniGenerator");
    const env = lerEnvMap().map;
    gravarIni(dest, {
      ambiente: env.AMBIENTE_SEFAZ || process.env.AMBIENTE_SEFAZ || "homologacao",
      uf: env.NFE_UF || process.env.NFE_UF || "MG",
      cscId: env.NFE_CSC_ID || process.env.NFE_CSC_ID || "000001",
    });
  } catch (err) {
    log.warn({ err: err.message }, "[FiscalLocalConfig] Fallback INI mínimo");
    fs.writeFileSync(
      dest,
      `[Sistema]\nAmbienteSefaz=homologacao\n\n[ACBrNFe]\nAmbiente=1\nAmbienteSefaz=homologacao\nModeloDF=65\n\n[NFe]\nAmbiente=1\nAmbienteSefaz=homologacao\n\n[Certificado]\nArquivo=\nSenha=\n\n[DFe]\nUF=MG\n\n[NFCe]\nIdCSC=\nCSC=\n`,
      "utf8",
    );
  }
  if (!process.env.ACBR_LIB_INI) {
    patchEnv({ ACBR_LIB_INI: dest.replace(/\\/g, "\\\\") });
  }
  return dest;
}

function resolverCaminhoAbsoluto(arquivo, baseDir) {
  if (!arquivo) return "";
  if (path.isAbsolute(arquivo)) return arquivo;
  return path.resolve(baseDir || AGENT_ROOT, arquivo);
}

function lerEmissaoFiscalDoEnv() {
  const { map } = lerEnvMap();
  return (
    String(map.EMISSAO_FISCAL || process.env.EMISSAO_FISCAL || "false").toLowerCase() ===
    "true"
  );
}

function aplicarEmissaoFiscalRuntime(valor) {
  const ativo = !!valor;
  try {
    require("./acbr").setRuntimeEmissaoFiscal(ativo);
  } catch (_) {
    /* testes isolados */
  }
  try {
    const fiscalDriver = require("./fiscalDriver");
    if (typeof fiscalDriver.setRuntimeEmissaoFiscal === "function") {
      fiscalDriver.setRuntimeEmissaoFiscal(ativo);
    }
  } catch (_) {
    /* testes isolados */
  }
  process.env.EMISSAO_FISCAL = ativo ? "true" : "false";
}

function lerEmissaoFiscalRuntime() {
  reconciliarEmissaoComEnv();
  try {
    return require("./acbr").getRuntimeEmissaoFiscal();
  } catch (_) {
    /* testes isolados */
  }
  return lerEmissaoFiscalDoEnv();
}

/**
 * Self-heal de produção: reaplica autoridade/.env → runtime antes de recusar emissão.
 * Idempotente e silencioso quando já alinhado.
 * @returns {boolean}
 */
function garantirEmissaoFiscalAtiva() {
  try {
    reconciliarEmissaoComEnv();
  } catch (_) {
    /* best-effort */
  }
  try {
    return !!require("./acbr").getRuntimeEmissaoFiscal();
  } catch (_) {
    return lerEmissaoFiscalDoEnv();
  }
}

function ler() {
  const iniPath = resolveLibIniPath();
  const libPath = resolveLibPath();
  const env = lerEnvMap().map;
  const driver = String(env.ACBR_DRIVER || process.env.ACBR_DRIVER || "lib")
    .toLowerCase()
    .replace("acbr-lib", "lib");

  let sections = {};
  if (iniPath && fs.existsSync(iniPath)) {
    sections = parseIni(fs.readFileSync(iniPath, "utf8"));
  }

  const tpAmbIni = getIniValue(sections, [
    ["ACBrNFe", "Ambiente"],
    ["NFe", "Ambiente"],
  ]);
  const ambienteSefazIni = normalizarAmbienteSefaz(
    getIniValue(sections, [
      ["Sistema", "AmbienteSefaz"],
      ["ACBrNFe", "AmbienteSefaz"],
      ["NFe", "AmbienteSefaz"],
    ]),
  );
  const ambienteEnvNorm =
    normalizarAmbienteSefaz(process.env.AMBIENTE_SEFAZ) ||
    normalizarAmbienteSefaz(env.AMBIENTE_SEFAZ);
  const ambienteSefaz =
    ambienteEnvNorm ||
    ambienteSefazIni ||
    (tpAmbIni != null && tpAmbIni !== ""
      ? tpAmbToAmbiente(tpAmbIni)
      : "homologacao");

  const certRel = getIniValue(sections, [["Certificado", "Arquivo"]]);
  const certEnv = desescaparValorEnv(env.CERT_A1_PATH || process.env.CERT_A1_PATH || "");
  const certArquivo = certRel || certEnv;
  const iniDir = iniPath ? path.dirname(iniPath) : AGENT_ROOT;
  const certAbs = resolverCaminhoAbsoluto(certArquivo, iniDir);

  const senhaIni = getIniValue(sections, [["Certificado", "Senha"]]);
  const senhaEnv = env.CERT_A1_PASS || process.env.CERT_A1_PASS || "";
  const vault = fiscalSecrets.lerSync();
  const senhaVault = vault.certificadoSenha || "";
  const senha =
    senhaVault ||
    (senhaIni && senhaIni !== "__VAULT__" ? senhaIni : "") ||
    senhaEnv;

  const idCsc =
    getIniValue(sections, [["NFCe", "IdCSC"]]) ||
    env.NFE_CSC_ID ||
    process.env.NFE_CSC_ID ||
    "";
  const csc =
    vault.nfceCsc ||
    (getIniValue(sections, [["NFCe", "CSC"]]) &&
    getIniValue(sections, [["NFCe", "CSC"]]) !== "__VAULT__"
      ? getIniValue(sections, [["NFCe", "CSC"]])
      : "") ||
    env.NFE_CSC_TOKEN ||
    process.env.NFE_CSC_TOKEN ||
    "";

  const uf =
    getIniValue(sections, [
      ["DFe", "UF"],
      ["NFe", "UF"],
      ["ACBrNFe", "UF"],
    ]) ||
    env.NFE_UF ||
    process.env.NFE_UF ||
    "MG";

  const emissaoFiscal = lerEmissaoFiscalRuntime();
  const authority = (() => {
    try {
      return require("./fiscalConfigAuthority").obterStatus();
    } catch (_) {
      return { localAuthorityAt: null };
    }
  })();

  return {
    driver,
    ambienteSefaz,
    tpAmb: ambienteToTpAmb(ambienteSefaz),
    uf,
    emissaoFiscal,
    atualizadoEm: authority.localAuthorityAt || null,
    certificado: {
      arquivo: certArquivo,
      arquivoAbsoluto: certAbs,
      arquivoExiste: certAbs ? fs.existsSync(certAbs) : false,
      senhaConfigurada: Boolean(senha),
    },
    nfce: {
      idCsc: idCsc || "000001",
      cscConfigurado: Boolean(csc),
    },
    paths: {
      iniPath: iniPath || null,
      iniExiste: Boolean(iniPath && fs.existsSync(iniPath)),
      libPath: libPath || null,
      libExiste: Boolean(libPath && fs.existsSync(libPath)),
      envPath: resolveAgentEnvPath(),
    },
    fonteAmbiente:
      ambienteEnvNorm
        ? "env"
        : ambienteSefazIni
          ? "ini_label"
          : tpAmbIni
            ? "ini"
            : "padrao",
    ambienteLib: ambienteToAmbienteLib(ambienteSefaz),
    logo: (() => {
      try {
        const fiscalLogo = require("./fiscal/fiscalLogo");
        const l = fiscalLogo.ler();
        return {
          ativo: l.ativo,
          existe: l.existe,
          sha256: l.sha256,
          sha256Remoto: l.sha256Remoto,
          atualizadoEm: l.atualizadoEm,
          sincronizadoEm: l.sincronizadoEm,
          origem: l.origem,
          extensao: l.extensao,
        };
      } catch (_) {
        return { ativo: false, existe: false };
      }
    })(),
  };
}

async function salvar(updates) {
  if (!updates || typeof updates !== "object") {
    throw new Error("Payload inválido");
  }

  let iniPath = ensureIniFile(resolveLibIniPath());
  let raw = fs.readFileSync(iniPath, "utf8");
  const envPatch = {};
  const vaultPatch = {};

  if (updates.ambienteSefaz != null) {
    const amb = normalizarAmbienteSefaz(updates.ambienteSefaz);
    if (!amb) {
      throw new Error("ambienteSefaz deve ser homologacao ou producao");
    }
    const ambLib = ambienteToAmbienteLib(amb);
    // ACBrLib lê Ambiente no inicializar como enum 0/1 — NÃO gravar tpAmb SEFAZ (1/2) aqui.
    for (const sec of SECOES_AMBIENTE) {
      raw = upsertIniKey(raw, sec, "Ambiente", ambLib);
      raw = upsertIniKey(raw, sec, "AmbienteSefaz", amb);
    }
    raw = upsertIniKey(raw, "Sistema", "AmbienteSefaz", amb);
    envPatch.AMBIENTE_SEFAZ = amb;
  }

  if (updates.uf != null) {
    const uf = String(updates.uf).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(uf)) throw new Error("UF inválida");
    for (const sec of SECOES_UF) {
      raw = upsertIniKey(raw, sec, "UF", uf);
    }
    envPatch.NFE_UF = uf;
  }

  if (updates.certificadoArquivo != null) {
    const arq = String(updates.certificadoArquivo).trim();
    for (const sec of SECOES_CERT) {
      raw = upsertIniKey(raw, sec, "Arquivo", arq);
    }
    envPatch.CERT_A1_PATH = arq.replace(/\\/g, "\\\\");
  }

  if (updates.certificadoSenha != null && updates.certificadoSenha !== "") {
    const { normalizeCertPassword } = require("./fiscal/certProof");
    vaultPatch.certificadoSenha = normalizeCertPassword(updates.certificadoSenha);
    for (const sec of SECOES_CERT) {
      raw = upsertIniKey(raw, sec, "Senha", "__VAULT__");
    }
    delete envPatch.CERT_A1_PASS;
  }

  if (updates.nfceIdCsc != null) {
    const id = String(updates.nfceIdCsc).trim();
    for (const sec of SECOES_NFCE) {
      raw = upsertIniKey(raw, sec, "IdCSC", id);
    }
    envPatch.NFE_CSC_ID = id;
  }

  if (updates.nfceCsc != null && updates.nfceCsc !== "") {
    vaultPatch.nfceCsc = String(updates.nfceCsc);
    for (const sec of SECOES_NFCE) {
      raw = upsertIniKey(raw, sec, "CSC", "__VAULT__");
    }
    delete envPatch.NFE_CSC_TOKEN;
  }

  if (typeof updates.emissaoFiscal === "boolean") {
    envPatch.EMISSAO_FISCAL = updates.emissaoFiscal ? "true" : "false";
    try {
      const fiscalConfigAuthority = require("./fiscalConfigAuthority");
      fiscalConfigAuthority.marcarAutoridadeLocal(updates.emissaoFiscal);
    } catch (_) {
      /* testes isolados */
    }
  }

  fs.writeFileSync(iniPath, raw, "utf8");

  if (Object.keys(vaultPatch).length > 0) {
    fiscalSecrets.salvarSync(vaultPatch);
  }

  if (Object.keys(envPatch).length > 0) {
    patchEnv(envPatch);
  }

  if (typeof updates.emissaoFiscal === "boolean") {
    aplicarEmissaoFiscalRuntime(updates.emissaoFiscal);
  }

  log.info(
    {
      ambiente: updates.ambienteSefaz,
      ambienteLib:
        updates.ambienteSefaz != null
          ? ambienteToAmbienteLib(updates.ambienteSefaz)
          : undefined,
      uf: updates.uf,
    },
    "[FiscalLocalConfig] Configuração salva",
  );

  try {
    const fiscalDriver = require("./fiscalDriver");
    if (typeof fiscalDriver.refreshLibRuntimeConfig === "function") {
      await fiscalDriver.refreshLibRuntimeConfig();
    }
  } catch (err) {
    log.warn({ err: err.message }, "[FiscalLocalConfig] Falha ao atualizar sessão Lib");
  }

  return ler();
}

/** Sincroniza ambiente do painel operacional → acbrlib.ini + .env */
function aplicarAmbiente(ambienteSefaz) {
  return salvar({ ambienteSefaz });
}

/**
 * Se o .env foi editado manualmente após um save do painel, prioriza EMISSAO_FISCAL do .env.
 * Autoridade local (PUT /config/fiscal) é SSOT quando mais recente que o .env.
 */
function reconciliarEmissaoComEnv() {
  const { path: envPath } = lerEnvMap();
  if (!envPath || !fs.existsSync(envPath)) return null;

  const envEmissao = lerEmissaoFiscalDoEnv();

  const runtimeAtual = () => {
    try {
      return require("./acbr").getRuntimeEmissaoFiscal();
    } catch (_) {
      return envEmissao;
    }
  };

  const aplicarComLog = (valor, motivo, extra = {}) => {
    const alvo = !!valor;
    const antes = runtimeAtual();
    aplicarEmissaoFiscalRuntime(alvo);
    if (antes !== alvo) {
      log.info({ de: antes, para: alvo, motivo, ...extra }, "[FiscalLocalConfig] Emissão fiscal reconciliada");
    }
    return alvo;
  };

  try {
    const fiscalConfigAuthority = require("./fiscalConfigAuthority");
    const authority = fiscalConfigAuthority.obterStatus();
    if (!authority.ativo) {
      return aplicarComLog(envEmissao, "env_sem_autoridade");
    }

    if (authority.localEmissaoFiscal === envEmissao) {
      return aplicarComLog(envEmissao, "env_e_autoridade_iguais");
    }

    // Instalador ou edição manual no .env com EMISSAO_FISCAL=true prevalece sobre
    // autoridade local=false (ex.: operador salvou certificado com checkbox desmarcado).
    if (envEmissao && !authority.localEmissaoFiscal) {
      fiscalConfigAuthority.marcarAutoridadeLocal(true);
      return aplicarComLog(true, "env_true_realinha_autoridade", {
        authority: false,
      });
    }

    const envMtime = fs.statSync(envPath).mtimeMs;
    const authMtime = new Date(authority.localAuthorityAt).getTime();
    if (envMtime > authMtime) {
      fiscalConfigAuthority.marcarAutoridadeLocal(envEmissao);
      return aplicarComLog(envEmissao, "env_mais_recente", {
        authority: authority.localEmissaoFiscal,
      });
    }

    // Autoridade local mais recente (ou empate) — SSOT do painel; aplica só no runtime.
    return aplicarComLog(authority.localEmissaoFiscal, "autoridade_local_ssot", {
      envEmissao,
    });
  } catch (_) {
    return aplicarComLog(envEmissao, "fallback_env");
  }
}

/**
 * Migra CERT_A1_PASS, NFE_CSC_TOKEN e caminhos do .env para cofre + acbrlib.ini no boot.
 * O instalador remove segredos do .env; valores adicionados manualmente precisam chegar ao motor fiscal.
 */
function sincronizarSegredosDoEnv() {
  const { map } = lerEnvMap();
  const vault = fiscalSecrets.lerSync();
  const vaultPatch = {};

  const certPass = desescaparValorEnv(map.CERT_A1_PASS || "");
  const cscToken = desescaparValorEnv(map.NFE_CSC_TOKEN || "");
  const certPath = desescaparValorEnv(map.CERT_A1_PATH || "");
  const cscId = String(map.NFE_CSC_ID || "").trim();

  let iniPath = resolveLibIniPath();
  if (!iniPath || !fs.existsSync(iniPath)) {
    iniPath = ensureIniFile(iniPath);
  }

  let raw = fs.readFileSync(iniPath, "utf8");
  let iniChanged = false;
  const sections = parseIni(raw);
  const senhaIni = getIniValue(sections, [["Certificado", "Senha"], ["DFe", "Senha"]]);
  // Migra senha plaintext do INI → cofre (serviço Windows não usa keyring do usuário).
  if (!vault.certificadoSenha && senhaIni && senhaIni !== "__VAULT__") {
    const { normalizeCertPassword } = require("./fiscal/certProof");
    const { stringToB64Crypt, b64CryptToString } = require("./fiscal/acbrLibCrypt");
    const plain = normalizeCertPassword(senhaIni);
    let jaEhB64Crypt = false;
    try {
      const dec = b64CryptToString(plain);
      jaEhB64Crypt = !!dec && stringToB64Crypt(dec) === plain;
    } catch (_) {}
    if (plain && !jaEhB64Crypt) {
      vaultPatch.certificadoSenha = plain;
    }
  }

  if (!vault.certificadoSenha && certPass) {
    vaultPatch.certificadoSenha = certPass;
  }
  if (!vault.nfceCsc && cscToken) {
    vaultPatch.nfceCsc = cscToken;
  }
  if (Object.keys(vaultPatch).length === 0 && !certPath && !cscId) {
    return { aplicado: false };
  }

  if (certPath) {
    const certIni = getIniValue(parseIni(raw), [["Certificado", "Arquivo"]]);
    if (!certIni) {
      for (const sec of SECOES_CERT) {
        raw = upsertIniKey(raw, sec, "Arquivo", certPath);
      }
      iniChanged = true;
    }
  }

  if (cscId) {
    const idIni = getIniValue(parseIni(raw), [["NFCe", "IdCSC"]]);
    if (!idIni) {
      for (const sec of SECOES_NFCE) {
        raw = upsertIniKey(raw, sec, "IdCSC", cscId);
      }
      iniChanged = true;
    }
  }

  if (Object.keys(vaultPatch).length > 0) {
    fiscalSecrets.salvarSync(vaultPatch);
    if (vaultPatch.certificadoSenha) {
      for (const sec of SECOES_CERT) {
        raw = upsertIniKey(raw, sec, "Senha", "__VAULT__");
      }
      iniChanged = true;
    }
    if (vaultPatch.nfceCsc) {
      for (const sec of SECOES_NFCE) {
        raw = upsertIniKey(raw, sec, "CSC", "__VAULT__");
      }
      iniChanged = true;
    }
    log.info("[FiscalLocalConfig] Segredos do .env migrados para o cofre fiscal");
  }

  if (iniChanged) {
    fs.writeFileSync(iniPath, raw, "utf8");
  }

  return { aplicado: Object.keys(vaultPatch).length > 0 || iniChanged };
}

module.exports = {
  ler,
  lerEmissaoFiscalDoEnv,
  lerEmissaoFiscalRuntime,
  aplicarEmissaoFiscalRuntime,
  garantirEmissaoFiscalAtiva,
  salvar,
  aplicarAmbiente,
  reconciliarEmissaoComEnv,
  sincronizarSegredosDoEnv,
  resolveLibIniPath,
  resolveLibPath,
  resolveAgentEnvPath,
  ambienteToTpAmb,
  ambienteToAmbienteLib,
  normalizarAmbienteSefaz,
  tpAmbToAmbiente,
  ensureIniFile,
};
