#!/usr/bin/env node
/**
 * Homologação ACBrLib PRODUÇÃO — driver real (acbrLibDriver.js).
 *
 * Pipeline de produção: montarIniLib → emitirViaNativeLib → enrichParse → PDF → consulta chave.
 *
 * Requer DLL Windows + certificado homologação. NÃO usa ACBR_LIB_ALLOW_PARITY.
 *
 * Uso (WSL):
 *   cd agente-local && bash scripts/run-homolog-acbrlib-producao.sh
 *
 * Uso (Windows CMD na pasta agente-local):
 *   node scripts/homolog-acbrlib-producao.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const AGENT_ROOT = path.resolve(__dirname, "..");
const PROD_ROOT = path.join(AGENT_ROOT, "acbrlib");
const RESULTADO_PATH = path.join(AGENT_ROOT, "RESULTADO-HOMOLOG-PRODUCAO.md");
const HOMOLOG_ENV = path.join(AGENT_ROOT, "homolog-acbrlib", ".env");

if (fs.existsSync(HOMOLOG_ENV)) {
  require("dotenv").config({ path: HOMOLOG_ENV, override: false });
}

process.env.ACBR_DRIVER = "lib";
process.env.HOMOLOG_ACBRLIB = "true";
delete process.env.ACBR_LIB_ALLOW_PARITY;
process.env.EMISSAO_FISCAL = "true";

if (process.platform === "win32") {
  const localApp =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const homologRoot = path.join(localApp, "MarginEngine-homolog");
  if (!process.env.MARGIN_ENGINE_ROOT || /wsl\.localhost|wsl\$|^\\\\/i.test(AGENT_ROOT)) {
    process.env.MARGIN_ENGINE_ROOT = homologRoot;
  }
  fs.mkdirSync(process.env.MARGIN_ENGINE_ROOT, { recursive: true });
  // node_modules instalado no WSL não carrega better-sqlite3 no Node Windows (erro 193)
  process.env.FISCAL_NUMERACAO_DISABLED = "true";
} else if (!process.env.MARGIN_ENGINE_ROOT) {
  process.env.MARGIN_ENGINE_ROOT = path.join(AGENT_ROOT, "homolog-data");
}

const acbr = require("../acbr");
acbr.setRuntimeEmissaoFiscal(true);

const factory = require("../fiscal/factory");
factory.resetFiscalDriver();

function defaultLibName() {
  return os.platform() === "win32" ? "ACBrNFe64.dll" : "libacbrnfe64.so";
}

function resolveAgentPath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(AGENT_ROOT, p);
}

function resolveLibPath() {
  if (process.env.ACBR_LIB_PATH) {
    const resolved = resolveAgentPath(process.env.ACBR_LIB_PATH);
    if (resolved && fs.existsSync(resolved)) return resolved;
  }
  const roots = [PROD_ROOT, AGENT_ROOT];
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, "lib", defaultLibName()));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolveIniConfig() {
  if (process.env.ACBR_LIB_INI) {
    const resolved = resolveAgentPath(process.env.ACBR_LIB_INI);
    if (resolved && fs.existsSync(resolved)) return resolved;
  }
  const roots = [PROD_ROOT, AGENT_ROOT];
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, "data", "config", "acbrlib.ini"));
  }
  candidates.push(path.join(AGENT_ROOT, "data", "acbrlib.ini"));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function empresaRealHomolog() {
  return {
    cnpj: process.env.NFE_CNPJ || "12343055000183",
    inscricaoEstadual: process.env.NFE_IE || "0016413070030",
    razaoSocial: process.env.NFE_RAZAO || "conta test",
    nomeFantasia: process.env.NFE_FANTASIA || "conta test",
    logradouro: process.env.NFE_LOGRADOURO || "Arnaldo Cunha, 2646 — São Lucas",
    numero: "SN",
    bairro: "CENTRO",
    cidade: "Sao Francisco",
    uf: "MG",
    cep: "39300000",
    codigoMunicipio: "3161106",
    regimeTributario: "1",
    telefone: "38998056637",
  };
}

function proximoNumeroNfe() {
  const stateFile = path.join(AGENT_ROOT, "homolog-acbrlib", ".last-numero");
  let last = 0;
  if (fs.existsSync(stateFile)) {
    last = parseInt(String(fs.readFileSync(stateFile, "utf8")).trim(), 10) || 0;
  }
  const envNum = process.env.NFE_NUMERO
    ? parseInt(String(process.env.NFE_NUMERO).replace(/\D/g, ""), 10)
    : NaN;

  let n = last + 1;
  if (!Number.isNaN(envNum) && envNum > n) {
    n = envNum;
  }

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, String(n), "utf8");
  return n;
}

function writeResultado(report) {
  const ts = new Date().toISOString();
  let md = `# Resultado — ACBrLib produção (driver agente)\n\n`;
  md += `Gerado em: ${ts}\n\n`;
  md += `| Campo | Valor |\n|-------|-------|\n`;
  md += `| Status geral | ${report.ok ? "**OK**" : "**FALHA**"} |\n`;
  md += `| Modo driver | \`${report.mode || "—"}\` |\n`;
  md += `| Biblioteca | \`${report.libPath || "—"}\` |\n`;
  md += `| Config INI | \`${report.iniConfig || "—"}\` |\n`;
  md += `| MARGIN_ENGINE_ROOT | \`${process.env.MARGIN_ENGINE_ROOT || "—"}\` |\n\n`;

  if (report.etapas?.length) {
    md += `## Etapas\n\n`;
    md += `| Etapa | Status | Detalhe |\n|-------|--------|--------|\n`;
    for (const e of report.etapas) {
      md += `| ${e.nome} | ${e.ok ? "OK" : "FALHA"} | ${e.detalhe || "—"} |\n`;
    }
    md += `\n`;
  }

  if (report.emissao) {
    md += `## Emissão SEFAZ\n\n`;
    md += `| Campo | Valor |\n|-------|-------|\n`;
    md += `| cStat | \`${report.emissao.cStat || "—"}\` |\n`;
    md += `| Chave | \`${report.emissao.chave || "—"}\` |\n`;
    md += `| Protocolo | \`${report.emissao.protocolo || "—"}\` |\n`;
    md += `| xMotivo | ${report.emissao.xMotivo || "—"} |\n`;
    md += `| Native | \`${report.emissao.native ?? "—"}\` |\n\n`;
  }

  if (report.pdf) {
    md += `## PDF\n\n`;
    md += `| Campo | Valor |\n|-------|-------|\n`;
    md += `| Caminho | \`${report.pdf.path || "—"}\` |\n`;
    md += `| Válido | ${report.pdf.valido ? "sim" : "não"} |\n\n`;
  }

  if (report.consulta) {
    md += `## Consulta chave\n\n`;
    md += `| Campo | Valor |\n|-------|-------|\n`;
    md += `| cStat | \`${report.consulta.cStat || "—"}\` |\n`;
    md += `| xMotivo | ${report.consulta.xMotivo || "—"} |\n\n`;
  }

  if (report.erro) {
    md += `## Erro\n\n\`\`\`\n${report.erro}\n\`\`\`\n`;
  }

  fs.writeFileSync(RESULTADO_PATH, md);
  console.log(`\nResultado gravado em ${RESULTADO_PATH}`);
}

function fail(msg, report = {}) {
  console.error(`\n✗ ${msg}`);
  writeResultado({ ok: false, erro: msg, ...report });
  process.exit(1);
}

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Homolog ACBrLib PRODUÇÃO — driver acbrLibDriver.js");
  console.log("═══════════════════════════════════════════════════════\n");

  const libPath = resolveLibPath();
  const iniConfig = resolveIniConfig();

  if (!fs.existsSync(libPath)) {
    fail(`Biblioteca não encontrada: ${libPath}`);
  }
  if (!fs.existsSync(iniConfig)) {
    fail(`acbrlib.ini não encontrado: ${iniConfig}`);
  }

  process.env.ACBR_LIB_PATH = libPath;
  process.env.ACBR_LIB_INI = iniConfig;

  factory.resetFiscalDriver();
  const driver = factory.createDriver("lib");
  const info = driver.getDriverInfo();

  console.log("Driver info:", JSON.stringify(info, null, 2));

  const report = {
    ok: false,
    mode: info.mode,
    libPath: info.libPath,
    iniConfig: info.libIni,
    etapas: [],
  };

  if (info.mode !== "native") {
    fail(
      `Modo '${info.mode}' — exige native (Windows + ${defaultLibName()}). ` +
        "Execute com Node Windows, não Node Linux/WSL.",
      report,
    );
  }

  const numeroNfe = proximoNumeroNfe();
  const serieNfe = process.env.NFE_SERIE || "1";
  console.log(`Numeração: série=${serieNfe} nNF=${numeroNfe}\n`);

  const payload = {
    numeroVenda: `PROD-HOMOLOG-${numeroNfe}`,
    total: 3,
    desconto: 0,
    formaPagamento: "dinheiro",
    empresa: empresaRealHomolog(),
    serieNfe,
    numeroNfe: String(numeroNfe),
    itens: [
      {
        codigo: "001",
        nome: "PAO FRANCES",
        quantidade: 2,
        precoUnitario: 1.5,
        total: 3,
        ncm: "19059090",
        cfop: "5102",
      },
    ],
  };

  try {
    console.log("→ testarLibDetalhe...");
    const diag = await driver.testarLibDetalhe();
    report.etapas.push({
      nome: "testarLibDetalhe",
      ok: diag.ok === true,
      detalhe: diag.ok ? `cStat=${diag.cStat || "107"}` : diag.erro || diag.motivo || "falhou",
    });
    console.log("  ", diag);

    console.log("\n→ statusServico...");
    const status = await driver.statusServico();
    report.etapas.push({
      nome: "statusServico",
      ok: !!status.operacional,
      detalhe: `cStat=${status.cStat} ${status.xMotivo || ""}`.trim(),
    });
    console.log("  ", status);

    console.log("\n→ emitirNfce (montarIniLib — sem documentIni)...\n");
    const emissao = await driver.emitirNfce(payload);
    report.emissao = {
      cStat: emissao.cStat,
      chave: emissao.chave,
      protocolo: emissao.protocolo,
      xMotivo: emissao.xMotivo,
      native: emissao.native,
      xmlPath: emissao.xmlPath,
      pdfPath: emissao.pdfPath,
    };

    const autorizado = emissao.cStat === "100" || emissao.cStat === "150";
    report.etapas.push({
      nome: "emitirNfce",
      ok: autorizado && !!emissao.chave,
      detalhe: `cStat=${emissao.cStat} chave=${emissao.chave ? "44d" : "—"}`,
    });

    console.log("\n── Emissão ──");
    console.log("  cStat    :", emissao.cStat);
    console.log("  chave    :", emissao.chave);
    console.log("  protocolo:", emissao.protocolo);
    console.log("  native   :", emissao.native);
    if (emissao.xmlPath) console.log("  xmlPath  :", emissao.xmlPath);
    if (emissao.pdfPath) console.log("  pdfPath  :", emissao.pdfPath);

    if (!autorizado || !emissao.chave) {
      report.erro = emissao.xMotivo || `cStat ${emissao.cStat} — emissão não autorizada`;
      writeResultado(report);
      if (emissao.cStat === "539") {
        console.warn("\n  Dica: duplicidade — incremente NFE_NUMERO ou apague homolog-acbrlib/.last-numero");
      }
      process.exit(1);
    }

    const docs = require("../documentosFiscais");
    const xmlPath = emissao.xmlPath || docs.localizarXmlPorChave?.(emissao.chave)?.path;

    console.log("\n→ gerarPdfDanfce...");
    let pdfPath = emissao.pdfPath || null;
    try {
      if (!pdfPath || !docs.isPdfValid(pdfPath)) {
        pdfPath = await driver.gerarPdfDanfce(emissao.chave, xmlPath);
      }
      const valido = docs.isPdfValid(pdfPath);
      report.pdf = { path: pdfPath, valido };
      report.etapas.push({
        nome: "gerarPdfDanfce",
        ok: valido,
        detalhe: pdfPath || "sem caminho",
      });
      console.log("  PDF:", pdfPath, valido ? "(válido)" : "(inválido/ausente)");
    } catch (pdfErr) {
      report.etapas.push({ nome: "gerarPdfDanfce", ok: false, detalhe: pdfErr.message });
      console.warn("  PDF falhou:", pdfErr.message);
    }

    console.log("\n→ consultarChave...");
    const consulta = await driver.consultarChave(emissao.chave);
    report.consulta = { cStat: consulta.cStat, xMotivo: consulta.xMotivo };
    report.etapas.push({
      nome: "consultarChave",
      ok: consulta.cStat === "100" || String(consulta.situacao || "").includes("AUTORIZ"),
      detalhe: `cStat=${consulta.cStat}`,
    });
    console.log("  ", consulta);

    report.ok = report.etapas.every((e) => e.ok);
    writeResultado(report);

    if (!report.ok) {
      console.warn("\n⚠ Homologação concluída com falhas em etapas secundárias — ver RESULTADO");
      process.exit(1);
    }

    console.log("\n✓ Homologação ACBrLib produção OK — emissão, PDF e consulta via driver nativo");
    process.exit(0);
  } catch (err) {
    let ultimo = "";
    try {
      if (err.inst && typeof err.inst.ultimoRetorno === "function") {
        ultimo = err.inst.ultimoRetorno();
      }
    } catch (_) {
      /* ignore */
    }
    report.erro = ultimo ? `${err.message}\nultimoRetorno: ${ultimo}` : err.message;
    report.etapas.push({ nome: "exceção", ok: false, detalhe: err.message });
    fail(err.message, report);
  }
}

main().catch((e) => fail(e.message));
