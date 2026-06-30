#!/usr/bin/env node
/**
 * Aplica configuração fiscal gravada pelo instalador Inno Setup.
 * Uso: node scripts/installer-apply-fiscal-config.js <appDir> <configJsonPath>
 *
 * Margin 1.0: paths oficiais agente-local/acbrlib/ + cofre fiscalSecrets.
 */
const fs = require("fs");
const path = require("path");

const appDir = process.argv[2];
const configPath = process.argv[3];

if (!appDir || !configPath || !fs.existsSync(configPath)) {
  process.exit(0);
}

const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const marginRoot =
  process.env.PROGRAMDATA && process.platform === "win32"
    ? path.join(process.env.PROGRAMDATA, "MarginEngine")
    : path.join(appDir, "data", "margin-engine");

const acbrLibDir = path.join(appDir, "acbrlib");
const acbrLibDll = path.join(acbrLibDir, "lib", "ACBrNFe64.dll");
const acbrLibIniDefault = path.join(acbrLibDir, "data", "config", "acbrlib.ini");
const acbrLibIniData = path.join(appDir, "data", "acbrlib.ini");
const acbrSchemasRoot = path.join(acbrLibDir, "data", "Schemas");
const acbrSchemasBundled = path.join(acbrSchemasRoot, "NFe");
const acbrServicosBundled = path.join(acbrLibDir, "data", "config", "ACBrNFeServicos.ini");

const envPath = path.join(appDir, ".env");
const envExample = path.join(appDir, ".env.example");
if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envPath);
}

function patchEnv(lines, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value ?? ""}`;
  if (re.test(lines)) return lines.replace(re, line);
  return `${lines.replace(/\s*$/, "")}\n${line}\n`;
}

function tpAmbFromAmbiente(amb) {
  return String(amb || "").toLowerCase() === "producao" ? "1" : "2";
}

let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

envContent = patchEnv(envContent, "EMISSAO_FISCAL", cfg.emissaoFiscal ? "true" : "false");

if (cfg.driver === "lib") {
  envContent = patchEnv(envContent, "ACBR_DRIVER", "lib");
  envContent = envContent.replace(/^ACBR_LIB_ALLOW_PARITY=.*\n?/m, "");
  envContent = envContent.replace(/^FISCAL_ALLOW_LOCAL_INI=.*\n?/m, "");
} else {
  envContent = patchEnv(envContent, "ACBR_DRIVER", "monitor");
}

if (cfg.certPath) {
  envContent = patchEnv(envContent, "CERT_A1_PATH", cfg.certPath.replace(/\\/g, "\\\\"));
}
if (cfg.ambiente) {
  envContent = patchEnv(envContent, "AMBIENTE_SEFAZ", cfg.ambiente);
}
if (cfg.uf) {
  envContent = patchEnv(envContent, "NFE_UF", cfg.uf);
}
if (cfg.cscId) {
  envContent = patchEnv(envContent, "NFE_CSC_ID", cfg.cscId);
}

envContent = envContent.replace(/^CERT_A1_PASS=.*\n?/m, "");
envContent = envContent.replace(/^NFE_CSC_TOKEN=.*\n?/m, "");

if (cfg.driver === "lib") {
  const libPath = cfg.libPath || acbrLibDll;
  const iniPath = cfg.libIni || acbrLibIniDefault;
  envContent = patchEnv(envContent, "ACBR_LIB_PATH", libPath.replace(/\\/g, "\\\\"));
  envContent = patchEnv(envContent, "ACBR_LIB_INI", iniPath.replace(/\\/g, "\\\\"));
}

fs.writeFileSync(envPath, envContent, "utf8");

const vaultPatch = {};
if (cfg.certSenha) vaultPatch.certificadoSenha = cfg.certSenha;
if (cfg.cscToken) vaultPatch.nfceCsc = cfg.cscToken;
if (Object.keys(vaultPatch).length > 0) {
  try {
    const fiscalSecrets = require(path.join(appDir, "fiscalSecrets"));
    fiscalSecrets.salvarSync(vaultPatch);
  } catch (err) {
    console.warn("[installer] Cofre fiscal indisponível, segredos só no INI:", err.message);
  }
}

if (cfg.driver !== "lib" || !cfg.emissaoFiscal) {
  console.log("[installer] Config fiscal aplicada (.env)");
  process.exit(0);
}

const certDestDir = path.join(marginRoot, "cert");
const schemasDir = path.join(marginRoot, "acbr", "schemas", "NFe");
const configDir = path.join(marginRoot, "acbr", "config");
const xmlDir = path.join(marginRoot, "acbr", "xml");
const pdfDir = path.join(marginRoot, "acbr", "pdf");

for (const d of [
  certDestDir,
  schemasDir,
  configDir,
  xmlDir,
  pdfDir,
  path.join(acbrLibDir, "lib"),
  path.dirname(acbrLibIniDefault),
  path.dirname(acbrLibIniData),
]) {
  fs.mkdirSync(d, { recursive: true });
}

let certFile = cfg.certPath || "";
if (cfg.certPath && fs.existsSync(cfg.certPath)) {
  certFile = path.join(certDestDir, "cert.pfx");
  if (path.resolve(cfg.certPath) !== path.resolve(certFile)) {
    fs.copyFileSync(cfg.certPath, certFile);
  }
}

const servicosDest = path.join(configDir, "ACBrNFeServicos.ini");
if (fs.existsSync(acbrServicosBundled)) {
  fs.copyFileSync(acbrServicosBundled, servicosDest);
} else {
  const legacyServicos = path.join(acbrLibDir, "lib", "ACBrNFeServicos.ini");
  if (fs.existsSync(legacyServicos)) {
    fs.copyFileSync(legacyServicos, servicosDest);
  }
}

function copiarSchemas(origem, destino) {
  if (!fs.existsSync(origem)) return 0;
  fs.mkdirSync(destino, { recursive: true });
  let copiados = 0;
  for (const entry of fs.readdirSync(origem, { withFileTypes: true })) {
    const src = path.join(origem, entry.name);
    const dst = path.join(destino, entry.name);
    if (entry.isDirectory()) {
      copiarSchemas(src, dst);
    } else if (entry.isFile() && entry.name.endsWith(".xsd") && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      copiados += 1;
    }
  }
  return copiados;
}

function contarXsd(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) n += contarXsd(p);
    else if (entry.isFile() && entry.name.endsWith(".xsd")) n += 1;
  }
  return n;
}

const copiadosBundled = copiarSchemas(acbrSchemasBundled, schemasDir);
const copiadosRoot = copiarSchemas(acbrSchemasRoot, schemasDir);
const totalXsd = contarXsd(schemasDir);
if (totalXsd < 10) {
  console.error(
    "[installer] ERRO: schemas XSD insuficientes após cópia (" +
      totalXsd +
      "). Esperado em " +
      acbrSchemasRoot +
      " — reinstale com build que inclua acbrlib/data/Schemas.",
  );
  process.exit(1);
}
console.log(
  "[installer] schemas copiados:",
  totalXsd,
  "XSD(s); novos:",
  copiadosBundled + copiadosRoot,
);

const tpAmb = tpAmbFromAmbiente(cfg.ambiente);
const senhaIni = cfg.certSenha ? "__VAULT__" : "";
const cscIni = cfg.cscToken ? "__VAULT__" : "";
const iniContent = `[Principal]
TipoResposta=2
LogNivel=4

[Sistema]
Nome=MarginEngine-Agente
Versao=1.0.0

[ACBrNFe]
Ambiente=${tpAmb}
ModeloDF=65
VersaoDF=4.00
PathSchemas=${schemasDir}
PathSalvar=${xmlDir}
PathNFe=${xmlDir}
PathPDF=${pdfDir}
ArquivoServicos=${servicosDest}
SalvarGer=1
SalvarWS=1
ExibirErroSchema=1
FormaEmissao=0
Timeout=30000

[Certificado]
Arquivo=${certFile}
Senha=${senhaIni}

[DFe]
UF=${cfg.uf || "MG"}
SSLCryptLib=1
SSLHttpLib=3
SSLXmlSignLib=4

[NFCe]
IdCSC=${cfg.cscId || "000001"}
CSC=${cscIni}

[DANFE]
PathPDF=${pdfDir}
TipoDANFE=1
`;

const iniTargets = [cfg.libIni || acbrLibIniDefault, acbrLibIniData];
for (const iniPath of iniTargets) {
  if (!iniPath) continue;
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  fs.writeFileSync(iniPath, iniContent, "utf8");
  console.log("[installer] acbrlib.ini gravado:", iniPath);
}

console.log("[installer] Config fiscal ACBrLib 1.0 aplicada");
