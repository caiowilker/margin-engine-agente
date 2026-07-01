// Persistência local de XML/PDF fiscal
const fs = require("fs");
const path = require("path");
const { PATHS } = require("./marginPaths");
const fiscalStorage = require("./fiscalStorage");
const auditLog = require("./auditLog");
const log = require("./logger").child({ modulo: "documentos_fiscais" });
const { coalescerRespostaAcbr } = require("./acbrResposta");
const { writeFileAtomicSync } = require("./runtime/atomicWrite");
const { getDirectoryManager } = require("./runtime/directoryManager");

function writeFiscalFile(filePath, data, encoding) {
  writeFileAtomicSync(filePath, data, {
    encoding,
    ensureDir: (dir) => getDirectoryManager().ensurePath(dir, "fiscal"),
  });
}

function salvarComVerificacaoDisco(tipo, dir, salvarFn) {
  const minMap = {
    xml: fiscalStorage.MIN_MB_XML,
    pdf: fiscalStorage.MIN_MB_PDF,
    backup: fiscalStorage.MIN_MB_BACKUP,
  };
  const minMB = minMap[tipo] || 50;
  const check = fiscalStorage.checkDiskSpace(dir, minMB);
  if (!check.ok) {
    auditLog.registrar("DISK_SPACE_INSUFICIENTE", {
      tipo,
      livresMB: check.livresMB,
      minimoMB: minMB,
      path: dir,
    });
    log.warn(
      { tipo, livresMB: check.livresMB, minimoMB: minMB },
      "Salvamento local ignorado — disco insuficiente (emissão continua)",
    );
    fiscalStorage.setModoDegradado(true);
    return null;
  }
  return salvarFn();
}

function salvarXmlAutorizado(chave, xmlContent) {
  return salvarComVerificacaoDisco("xml", PATHS.xml, () => {
    const k = String(chave || "").replace(/\D/g, "");
    const prot = extrairProtNFe(xmlContent);
    const autorizado = prot.cStat === "100" || prot.cStat === "150";
    const suffix = autorizado ? "-procNFe.xml" : "-nfe.xml";
    const file = path.join(PATHS.xml, `${k}${suffix}`);
    writeFiscalFile(file, xmlContent, "utf8");
    backup(file);
    return file;
  });
}

function salvarXmlCancelamento(chave, xmlContent) {
  return salvarComVerificacaoDisco("xml", PATHS.cancelamentos, () => {
    const file = path.join(PATHS.cancelamentos, `${chave}-canc.xml`);
    writeFiscalFile(file, xmlContent, "utf8");
    backup(file);
    return file;
  });
}

function salvarXmlInutilizacao(serie, ini, fim, xmlContent) {
  return salvarComVerificacaoDisco("xml", PATHS.xml, () => {
    const file = path.join(PATHS.xml, `inutilizacao-${serie}-${ini}-${fim}.xml`);
    writeFiscalFile(file, xmlContent, "utf8");
    backup(file);
    return file;
  });
}

function salvarXmlEvento(chave, xmlContent, tipoEvento) {
  return salvarComVerificacaoDisco("xml", PATHS.xml, () => {
    const k = String(chave || "").replace(/\D/g, "");
    const tag = String(tipoEvento || "evento")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 24);
    const file = path.join(PATHS.xml, `${k}-${tag}.xml`);
    writeFiscalFile(file, xmlContent, "utf8");
    backup(file);
    return file;
  });
}

function salvarPdfDanfce(chave, pdfBuffer) {
  return salvarComVerificacaoDisco("pdf", PATHS.pdf, () => {
    const file = path.join(PATHS.pdf, `${chave}-danfce.pdf`);
    writeFiscalFile(file, pdfBuffer);
    backup(file);
    return file;
  });
}

function salvarPdfPlaceholder(chave, texto) {
  return salvarComVerificacaoDisco("pdf", PATHS.pdf, () => {
    const file = path.join(PATHS.pdf, `${chave}-danfce.txt`);
    fs.writeFileSync(
      file,
      texto || `DANFC-e ${chave} — gerar via ACBr se PDF indisponível`,
      "utf8",
    );
    return file;
  });
}

function lerArquivo(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

function lerArquivoBase64(filePath) {
  const buf = lerArquivo(filePath);
  return buf ? buf.toString("base64") : null;
}

function isPdfValid(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  if (!filePath.toLowerCase().endsWith(".pdf")) return false;
  const buf = fs.readFileSync(filePath);
  return buf.length > 128 && buf.slice(0, 4).toString() === "%PDF";
}

/** NF-e 55 no painel exige DANFE A4 — cupom térmico (NFC-e) tem página estreita. */
function pareceDanfeA4(filePath) {
  if (!isPdfValid(filePath)) return false;
  const buf = fs.readFileSync(filePath);
  const head = buf.slice(0, 24576).toString("latin1");
  const media = head.match(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)/);
  if (media) return parseFloat(media[1]) > 400;
  const crop = head.match(/\/CropBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)/);
  if (crop) return parseFloat(crop[1]) > 400;
  return buf.length > 32000;
}

function pdfValidoParaModelo(filePath, modeloDocumento) {
  if (!isPdfValid(filePath)) return false;
  if (String(modeloDocumento || "65") === "55") return pareceDanfeA4(filePath);
  return true;
}

function backupQueuePath() {
  return getDirectoryManager().file("agent", "backup-pending.jsonl");
}

function enqueueBackupRetry(sourceFile) {
  try {
    const q = backupQueuePath();
    fs.mkdirSync(path.dirname(q), { recursive: true });
    fs.appendFileSync(q, `${JSON.stringify({ file: sourceFile, at: Date.now() })}\n`, "utf8");
  } catch (err) {
    log.warn({ err: err.message }, "Falha ao enfileirar backup pendente");
  }
}

function processPendingBackups() {
  const q = backupQueuePath();
  if (!fs.existsSync(q)) return;
  const check = fiscalStorage.checkDiskSpace(PATHS.backup, fiscalStorage.MIN_MB_BACKUP);
  if (!check.ok) return;
  const lines = fs.readFileSync(q, "utf8").split(/\r?\n/).filter(Boolean);
  const remaining = [];
  for (const line of lines) {
    try {
      const { file } = JSON.parse(line);
      if (!file || !fs.existsSync(file)) continue;
      const base = path.basename(file);
      const dest = path.join(PATHS.backup, `${Date.now()}-${base}`);
      fs.copyFileSync(file, dest);
    } catch (_) {
      remaining.push(line);
    }
  }
  if (remaining.length === 0) {
    fs.unlinkSync(q);
  } else {
    fs.writeFileSync(q, `${remaining.join("\n")}\n`, "utf8");
  }
}

function backup(sourceFile) {
  try {
    processPendingBackups();
    const check = fiscalStorage.checkDiskSpace(
      PATHS.backup,
      fiscalStorage.MIN_MB_BACKUP,
    );
    if (!check.ok) {
      auditLog.registrar("DISK_SPACE_INSUFICIENTE", {
        tipo: "backup",
        livresMB: check.livresMB,
        minimoMB: fiscalStorage.MIN_MB_BACKUP,
        path: PATHS.backup,
      });
      log.warn(
        { livresMB: check.livresMB },
        "Backup enfileirado — disco insuficiente (retry automático)",
      );
      enqueueBackupRetry(sourceFile);
      fiscalStorage.setModoDegradado(true);
      return null;
    }
    const base = path.basename(sourceFile);
    const dest = path.join(PATHS.backup, `${Date.now()}-${base}`);
    fs.copyFileSync(sourceFile, dest);
    return dest;
  } catch (_) {
    return null;
  }
}

function extrairXmlDaResposta(resposta) {
  const txt = coalescerRespostaAcbr(resposta);
  if (!txt) return null;
  const idx = txt.indexOf("<?xml");
  if (idx >= 0) return txt.slice(idx).trim();
  const xmlMatch = txt.match(
    /<(?:nfeProc|NFe|procEventoNFe)[\s\S]*<\/(?:nfeProc|NFe|procEventoNFe)>/i,
  );
  return xmlMatch ? xmlMatch[0] : null;
}

function extrairCnpjDaChave(chave) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) return null;
  return k.slice(6, 20);
}

function candidatosNomeXml(chave) {
  const k = String(chave || "").replace(/\D/g, "");
  return [`${k}-procNFe.xml`, `${k}-nfeProc.xml`, `${k}-nfe.xml`, `${k}.xml`];
}

function buscarArquivoXmlRecursivo(dir, chave, maxDepth = 5, depth = 0) {
  if (!dir || !fs.existsSync(dir) || depth > maxDepth) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const k = String(chave || "").replace(/\D/g, "");
  const proc = entries.find(
    (e) =>
      e.isFile() &&
      e.name.toLowerCase().endsWith(".xml") &&
      e.name.includes(k) &&
      /proc/i.test(e.name),
  );
  if (proc) return path.join(dir, proc.name);
  const qualquer = entries.find(
    (e) => e.isFile() && e.name.toLowerCase().endsWith(".xml") && e.name.includes(k),
  );
  if (qualquer) return path.join(dir, qualquer.name);
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const found = buscarArquivoXmlRecursivo(
      path.join(dir, ent.name),
      chave,
      maxDepth,
      depth + 1,
    );
    if (found) return found;
  }
  return null;
}

function carregarXmlComProt(filePath, chave) {
  const k = String(chave || "").replace(/\D/g, "");
  let xml;
  try {
    xml = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return null;
  }
  let prot = extrairProtNFe(xml);
  if (prot.cStat === "100" || prot.cStat === "150") {
    return { path: filePath, xml, prot };
  }
  const base = filePath.replace(/\.xml$/i, "");
  const variantes = [
    filePath.replace(/-nfe\.xml$/i, "-procNFe.xml"),
    filePath.replace(/-nfe\.xml$/i, "-nfeProc.xml"),
    `${base}-procNFe.xml`,
    `${base}-nfeProc.xml`,
  ];
  for (const alt of variantes) {
    if (!alt || alt === filePath || !fs.existsSync(alt)) continue;
    try {
      const xmlProc = fs.readFileSync(alt, "utf8");
      const protAlt = extrairProtNFe(xmlProc);
      if (protAlt.cStat === "100" || protAlt.cStat === "150") {
        return { path: alt, xml: xmlProc, prot: protAlt, pathNfe: filePath };
      }
    } catch (_) {}
  }
  return { path: filePath, xml, prot };
}

/** Localiza XML da chave (flat ou aninhado ACBr: xml/CNPJ/NFe/AAAAMM/NFe/). */
function localizarXmlPorChave(chave) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) return null;

  const dirs = [];
  const cnpj = extrairCnpjDaChave(k);
  const aamm = k.slice(2, 6);
  if (cnpj) {
    dirs.push(path.join(PATHS.xml, cnpj, "NFe", `20${aamm}`, "NFe"));
    dirs.push(path.join(PATHS.xml, cnpj, "NFe", aamm, "NFe"));
    dirs.push(path.join(PATHS.xml, cnpj, "NFe", `20${aamm}`));
    dirs.push(path.join(PATHS.xml, cnpj));
  }
  dirs.push(PATHS.xml, PATHS.saida, PATHS.backup);

  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (!fs.existsSync(dir)) continue;
    for (const nome of candidatosNomeXml(k)) {
      const full = path.join(dir, nome);
      if (fs.existsSync(full)) {
        const loaded = carregarXmlComProt(full, k);
        if (loaded) return loaded;
      }
    }
  }

  for (const raiz of [PATHS.xml, PATHS.saida, PATHS.backup]) {
    const found = buscarArquivoXmlRecursivo(raiz, k);
    if (found) {
      const loaded = carregarXmlComProt(found, k);
      if (loaded) return loaded;
    }
  }
  return null;
}

/** Extrai chave de 44 dígitos do XML (infProt ou infNFe Id). */
function extrairChaveDoXml(xml) {
  if (!xml || typeof xml !== "string") return null;
  const prot = extrairProtNFe(xml);
  if (prot.chNFe) return prot.chNFe;
  const id = xml.match(/<infNFe[^>]*\s+Id="NFe(\d{44})"/i)?.[1];
  return id || null;
}

/** Localiza XML por série/número na pasta aninhada do ACBr Monitor. */
function localizarXmlPorSerieNumero(serie, numeroNfe, cnpj) {
  const n = String(numeroNfe ?? "").replace(/\D/g, "");
  const s = String(serie ?? "1").replace(/\D/g, "");
  if (!n) return null;

  const dirs = [];
  const cnpjLimpo = String(cnpj || "").replace(/\D/g, "");
  if (cnpjLimpo.length === 14) {
    const raiz = path.join(PATHS.xml, cnpjLimpo, "NFe");
    if (fs.existsSync(raiz)) {
      for (const ym of fs.readdirSync(raiz, { withFileTypes: true })) {
        if (!ym.isDirectory()) continue;
        const nest = path.join(raiz, ym.name, "NFe");
        if (fs.existsSync(nest)) dirs.push(nest);
        else dirs.push(path.join(raiz, ym.name));
      }
    }
  }
  dirs.push(PATHS.xml, PATHS.saida);

  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir) || !fs.existsSync(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith(".xml")) continue;
      const full = path.join(dir, ent.name);
      try {
        const xml = fs.readFileSync(full, "utf8");
        const nNF = xml.match(/<nNF>(\d+)<\/nNF>/i)?.[1];
        const serieXml = xml.match(/<serie>(\d+)<\/serie>/i)?.[1];
        if (!nNF || String(parseInt(nNF, 10)) !== String(parseInt(n, 10))) continue;
        if (s && serieXml && String(parseInt(serieXml, 10)) !== String(parseInt(s, 10))) {
          continue;
        }
        const chave = extrairChaveDoXml(xml);
        const loaded = carregarXmlComProt(full, chave);
        if (loaded) return { ...loaded, chave: chave || undefined };
      } catch (_) {
        /* próximo arquivo */
      }
    }
  }
  return null;
}

/** Status da nota no XML autorizado (infProt) — prevalece sobre cStat 104 do lote. */
function extrairProtNFe(xml) {
  if (!xml || typeof xml !== "string") return {};
  const bloc =
    xml.match(/<infProt[^>]*>[\s\S]*?<\/infProt>/i)?.[0] ||
    xml.match(/<protNFe[^>]*>[\s\S]*?<\/protNFe>/i)?.[0] ||
    "";
  if (!bloc) return {};
  return {
    cStat: bloc.match(/<cStat>(\d+)<\/cStat>/i)?.[1] || null,
    xMotivo: bloc.match(/<xMotivo>([^<]*)<\/xMotivo>/i)?.[1]?.trim() || null,
    nProt: bloc.match(/<nProt>(\d+)<\/nProt>/i)?.[1] || null,
    chNFe: bloc.match(/<chNFe>(\d{44})<\/chNFe>/i)?.[1] || null,
  };
}

/** XML com protocolo SEFAZ (infProt) — necessário para DANFE/DANFC-e válido. */
function xmlEstaAutorizado(xml) {
  if (!xml || typeof xml !== "string") return false;
  const prot = extrairProtNFe(xml);
  return prot.cStat === "100" || prot.cStat === "150";
}

/**
 * Resolve o melhor caminho de XML para impressão/PDF (prefere procNFe / nfeProc).
 * Ignora xmlPathHint sem protocolo quando existir variante autorizada no disco.
 */
function resolverXmlParaImpressao(chave, xmlPathHint) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) {
    return xmlPathHint && fs.existsSync(xmlPathHint) ? xmlPathHint : null;
  }

  const local = localizarXmlPorChave(k);
  if (local?.path && xmlEstaAutorizado(local.xml)) {
    return local.path;
  }

  if (xmlPathHint && fs.existsSync(xmlPathHint)) {
    const loaded = carregarXmlComProt(xmlPathHint, k);
    if (loaded?.path && xmlEstaAutorizado(loaded.xml)) {
      return loaded.path;
    }
  }

  if (local?.path) {
    const loaded = carregarXmlComProt(local.path, k);
    if (loaded?.path && xmlEstaAutorizado(loaded.xml)) {
      return loaded.path;
    }
  }

  return null;
}

function extrairQrCodeDoXml(xml) {
  if (!xml || typeof xml !== "string") return null;
  const cdata = xml.match(/<qrCode>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/qrCode>/i);
  if (cdata?.[1]) return cdata[1].trim();
  const simples = xml.match(/<qrCode>([^<]+)<\/qrCode>/i);
  return simples?.[1]?.trim() || null;
}

const PORTAL_CONSULTA_NFCE_PADRAO = "nfce.fazenda.gov.br";
const PORTAL_CONSULTA_NFE_PADRAO = "www.nfe.fazenda.gov.br";

/** Host do portal de consulta a partir da URL do QR (fallback nacional). */
function portalConsultaNfce(qrUrl) {
  const raw = typeof qrUrl === "string" ? qrUrl.trim() : "";
  if (!raw) return PORTAL_CONSULTA_NFCE_PADRAO;
  try {
    return new URL(raw).hostname || PORTAL_CONSULTA_NFCE_PADRAO;
  } catch {
    return PORTAL_CONSULTA_NFCE_PADRAO;
  }
}

function isNfceModelo65(chave) {
  const k = String(chave || "").replace(/\D/g, "");
  return k.length >= 22 && k.substring(20, 22) === "65";
}

function isNfeModelo55(chave) {
  const k = String(chave || "").replace(/\D/g, "");
  return k.length >= 22 && k.substring(20, 22) === "55";
}

function portalConsultaDocumento(chave, qrUrl) {
  if (qrUrl && String(qrUrl).trim()) return portalConsultaNfce(qrUrl);
  if (isNfeModelo55(chave)) return PORTAL_CONSULTA_NFE_PADRAO;
  return PORTAL_CONSULTA_NFCE_PADRAO;
}

function buscarArquivoPdfRecursivo(dir, chave, maxDepth = 6, depth = 0) {
  if (!dir || !fs.existsSync(dir) || depth > maxDepth) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const k = String(chave || "").replace(/\D/g, "");
  const direto = entries.find(
    (e) =>
      e.isFile() &&
      e.name.toLowerCase().endsWith(".pdf") &&
      e.name.includes(k),
  );
  if (direto) return path.join(dir, direto.name);
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const found = buscarArquivoPdfRecursivo(
      path.join(dir, ent.name),
      chave,
      maxDepth,
      depth + 1,
    );
    if (found) return found;
  }
  return null;
}

function suffixPdfModelo(modeloDocumento = "65") {
  return String(modeloDocumento) === "55" ? "danfe" : "danfce";
}

function pastaModeloAcbr(modeloDocumento = "65") {
  return String(modeloDocumento) === "55" ? "NFe" : "NFCe";
}

/** Localiza PDF da chave (flat ou aninhado ACBr: pdf/CNPJ/NFe|NFCe/AAAAMM/...). */
function localizarPdfPorChave(chave, modeloDocumento = "65") {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) return null;
  const modelo = String(modeloDocumento || inferirModeloDaChave(k) || "65");
  const suffix = suffixPdfModelo(modelo);

  const flat = path.join(PATHS.pdf, `${k}-${suffix}.pdf`);
  if (isPdfValid(flat)) return flat;

  const cnpj = extrairCnpjDaChave(k);
  const aamm = k.slice(2, 6);
  const pastaMod = pastaModeloAcbr(modelo);
  const dirs = [];
  if (cnpj) {
    dirs.push(path.join(PATHS.pdf, cnpj, pastaMod, `20${aamm}`, pastaMod));
    dirs.push(path.join(PATHS.pdf, cnpj, pastaMod, aamm, pastaMod));
    dirs.push(path.join(PATHS.pdf, cnpj, pastaMod, `20${aamm}`));
    dirs.push(path.join(PATHS.pdf, cnpj, pastaMod));
    dirs.push(path.join(PATHS.pdf, cnpj));
  }
  dirs.push(PATHS.pdf, PATHS.saida);

  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (!fs.existsSync(dir)) continue;
    const candidatos = [
      `${k}-${suffix}.pdf`,
      `${k}.pdf`,
      `${k}-danfe.pdf`,
      `${k}-danfce.pdf`,
    ];
    for (const nome of candidatos) {
      const full = path.join(dir, nome);
      if (isPdfValid(full)) return full;
    }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const match = entries.find(
        (e) =>
          e.isFile() &&
          e.name.toLowerCase().endsWith(".pdf") &&
          e.name.includes(k),
      );
      if (match && isPdfValid(path.join(dir, match.name))) {
        return path.join(dir, match.name);
      }
    } catch (_) {
      /* próximo dir */
    }
  }

  for (const raiz of [PATHS.pdf, PATHS.saida]) {
    const found = buscarArquivoPdfRecursivo(raiz, k);
    if (found && isPdfValid(found)) return found;
  }
  return null;
}

function inferirModeloDaChave(chave) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length >= 22) {
    const mod = k.substring(20, 22);
    if (mod === "55" || mod === "65") return mod;
  }
  return "65";
}

/** Copia PDF encontrado para path canônico do agente. */
function copiarPdfParaCanonico(chave, srcPath, modeloDocumento = "65") {
  const k = String(chave || "").replace(/\D/g, "");
  const dest = path.join(PATHS.pdf, `${k}-${suffixPdfModelo(modeloDocumento)}.pdf`);
  if (!srcPath || !isPdfValid(srcPath)) return null;
  if (path.resolve(srcPath) !== path.resolve(dest)) {
    fs.copyFileSync(srcPath, dest);
  }
  return dest;
}

module.exports = {
  salvarXmlAutorizado,
  salvarXmlCancelamento,
  salvarXmlInutilizacao,
  salvarXmlEvento,
  salvarPdfDanfce,
  salvarPdfPlaceholder,
  lerArquivo,
  lerArquivoBase64,
  isPdfValid,
  pareceDanfeA4,
  pdfValidoParaModelo,
  extrairXmlDaResposta,
  extrairQrCodeDoXml,
  portalConsultaNfce,
  portalConsultaDocumento,
  isNfceModelo65,
  isNfeModelo55,
  extrairProtNFe,
  extrairChaveDoXml,
  localizarXmlPorChave,
  localizarXmlPorSerieNumero,
  localizarPdfPorChave,
  copiarPdfParaCanonico,
  extrairCnpjDaChave,
  xmlEstaAutorizado,
  resolverXmlParaImpressao,
};
