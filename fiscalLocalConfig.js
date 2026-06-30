/**
 * Configuração fiscal local do agente (ACBrLib + .env).
 * Permite alternar homolog/produção, certificado A1, CSC etc. sem editar INI manualmente.
 */
const fs = require("fs");
const path = require("path");
const log = require("./logger").child({ modulo: "fiscal_local_config" });
const { PATHS } = require("./marginPaths");
const fiscalSecrets = require("./fiscalSecrets");

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

function tpAmbToAmbiente(tp) {
  return String(tp) === "1" ? "producao" : "homologacao";
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
  const template = path.join(AGENT_ROOT, "templates", "acbrlib.ini.template");
  const dest =
    iniPath ||
    path.join(AGENT_ROOT, "acbrlib", "data", "config", "acbrlib.ini");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(template)) {
    fs.copyFileSync(template, dest);
  } else {
    fs.writeFileSync(
      dest,
      `[ACBrNFe]\nAmbiente=2\nModeloDF=65\n\n[Certificado]\nArquivo=\nSenha=\n\n[DFe]\nUF=MG\n\n[NFCe]\nIdCSC=\nCSC=\n`,
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
  const ambienteEnv = String(
    env.AMBIENTE_SEFAZ || process.env.AMBIENTE_SEFAZ || "",
  ).toLowerCase();
  const ambienteSefaz =
    ambienteEnv === "producao" || ambienteEnv === "1"
      ? "producao"
      : ambienteEnv === "homologacao" || ambienteEnv === "2"
        ? "homologacao"
        : tpAmbToAmbiente(tpAmbIni || "2");

  const certRel = getIniValue(sections, [["Certificado", "Arquivo"]]);
  const certEnv = env.CERT_A1_PATH || process.env.CERT_A1_PATH || "";
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

  const emissaoFiscal =
    String(env.EMISSAO_FISCAL || process.env.EMISSAO_FISCAL || "false")
      .toLowerCase() === "true";

  return {
    driver,
    ambienteSefaz,
    tpAmb: ambienteToTpAmb(ambienteSefaz),
    uf,
    emissaoFiscal,
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
      ambienteEnv && ambienteEnv !== ""
        ? "env"
        : tpAmbIni
          ? "ini"
          : "padrao",
  };
}

function salvar(updates) {
  if (!updates || typeof updates !== "object") {
    throw new Error("Payload inválido");
  }

  let iniPath = ensureIniFile(resolveLibIniPath());
  let raw = fs.readFileSync(iniPath, "utf8");
  const envPatch = {};
  const vaultPatch = {};

  if (updates.ambienteSefaz != null) {
    const amb = String(updates.ambienteSefaz).toLowerCase();
    if (!["homologacao", "producao"].includes(amb)) {
      throw new Error("ambienteSefaz deve ser homologacao ou producao");
    }
    const tpAmb = ambienteToTpAmb(amb);
    for (const sec of SECOES_AMBIENTE) {
      raw = upsertIniKey(raw, sec, "Ambiente", tpAmb);
    }
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
    vaultPatch.certificadoSenha = String(updates.certificadoSenha);
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
  }

  fs.writeFileSync(iniPath, raw, "utf8");

  if (Object.keys(vaultPatch).length > 0) {
    fiscalSecrets.salvarSync(vaultPatch);
  }

  if (Object.keys(envPatch).length > 0) {
    patchEnv(envPatch);
  }

  if (typeof updates.emissaoFiscal === "boolean") {
    try {
      const fiscalDriver = require("./fiscalDriver");
      if (typeof fiscalDriver.setRuntimeEmissaoFiscal === "function") {
        fiscalDriver.setRuntimeEmissaoFiscal(updates.emissaoFiscal);
      }
    } catch (_) {
      /* fiscalDriver pode não estar carregado em testes */
    }
  }

  log.info(
    { ambiente: updates.ambienteSefaz, uf: updates.uf },
    "[FiscalLocalConfig] Configuração salva",
  );

  try {
    const fiscalDriver = require("./fiscalDriver");
    if (typeof fiscalDriver.refreshLibRuntimeConfig === "function") {
      fiscalDriver.refreshLibRuntimeConfig();
    }
  } catch (_) {
    /* driver opcional em testes isolados */
  }

  return ler();
}

/** Sincroniza ambiente do painel operacional → acbrlib.ini + .env */
function aplicarAmbiente(ambienteSefaz) {
  return salvar({ ambienteSefaz });
}

module.exports = {
  ler,
  salvar,
  aplicarAmbiente,
  resolveLibIniPath,
  resolveLibPath,
  resolveAgentEnvPath,
  ambienteToTpAmb,
  tpAmbToAmbiente,
  ensureIniFile,
};
