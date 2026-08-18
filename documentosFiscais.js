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
  if (!filePath) return null;
  const roots = [PATHS.xml, PATHS.pdf, PATHS.backup, PATHS.saida, PATHS.cancelamentos];
  const resolved = path.resolve(filePath);
  const ok = roots.some((root) => {
    if (!root) return false;
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
  if (!ok) {
    log.warn({ filePath }, "Leitura fiscal bloqueada — path fora das pastas permitidas");
    return null;
  }
  if (!fs.existsSync(resolved)) return null;
  return fs.readFileSync(resolved);
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

function pdfValidoParaModelo(filePath, modeloDocumento, formatoPdf = "termico") {
  if (!isPdfValid(filePath)) return false;
  const modelo = String(modeloDocumento || "65");
  if (modelo === "55") return pareceDanfeA4(filePath);
  const formato = String(formatoPdf || "termico").toLowerCase();
  if (formato === "a4") return pareceDanfeA4(filePath);
  return !pareceDanfeA4(filePath);
}

function chaveNfe44(chave) {
  return String(chave || "").replace(/\D/g, "");
}

/**
 * Extrai chaves NFC-e/NF-e (44 dígitos, modelo 55/65) do binário do PDF.
 * Cobre dígitos contínuos, com espaços e UTF-16LE.
 */
function extrairChavesNfeDoPdf(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const buf = fs.readFileSync(filePath);
  const found = new Set();
  const coletar = (text) => {
    const digits = String(text || "").replace(/\D/g, "");
    for (let i = 0; i + 44 <= digits.length; i++) {
      const k = digits.slice(i, i + 44);
      const mod = k.slice(20, 22);
      if (mod === "55" || mod === "65") found.add(k);
    }
  };
  coletar(buf.toString("latin1"));
  coletar(buf.toString("utf16le"));
  return [...found];
}

/**
 * false = o PDF pertence a outra nota.
 * true  = a chave bate, ou o PDF não tem chave extraível (inconclusivo).
 */
function pdfChaveCompativel(filePath, chave) {
  const k = chaveNfe44(chave);
  if (k.length !== 44 || !isPdfValid(filePath)) return false;
  const keys = extrairChavesNfeDoPdf(filePath);
  if (keys.length === 0) return true;
  return keys.includes(k);
}

function pdfValidoParaChave(filePath, chave, modeloDocumento, formatoPdf = "termico") {
  return (
    pdfValidoParaModelo(filePath, modeloDocumento, formatoPdf) &&
    pdfChaveCompativel(filePath, chave)
  );
}

function listarPdfsEmDirs(dirs, maxDepth = 2) {
  const out = [];
  const seen = new Set();
  function walk(dir, depth) {
    if (!dir || depth > maxDepth || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".pdf")) continue;
      const abs = path.resolve(full);
      if (seen.has(abs)) continue;
      seen.add(abs);
      try {
        const st = fs.statSync(abs);
        out.push({ path: abs, mtimeMs: st.mtimeMs, size: st.size });
      } catch (_) {
        /* ignore */
      }
    }
  }
  for (const d of dirs || []) walk(d, 0);
  return out;
}

function snapshotPdfs(dirs) {
  const map = new Map();
  for (const f of listarPdfsEmDirs(dirs)) {
    map.set(f.path, `${f.mtimeMs}:${f.size}`);
  }
  return map;
}

function pdfsAlteradosDesde(snapshot, dirs) {
  const prev = snapshot instanceof Map ? snapshot : new Map();
  return listarPdfsEmDirs(dirs).filter(
    (f) => prev.get(f.path) !== `${f.mtimeMs}:${f.size}`,
  );
}

/** Remove o canônico antes de regenerar — senão o download reaproveita o PDF velho. */
function aposentarPdfCanonico(destino) {
  if (!destino || !fs.existsSync(destino)) return false;
  const bak = `${destino}.stale-${Date.now()}`;
  try {
    fs.renameSync(destino, bak);
    try {
      fs.unlinkSync(bak);
    } catch (_) {
      /* ignore */
    }
    return true;
  } catch (_) {
    try {
      fs.unlinkSync(destino);
      return true;
    } catch (_) {
      return false;
    }
  }
}

/**
 * Captura o PDF que a ACBr acabou de gravar e copia para o path canônico da chave.
 * Nunca devolve arquivo de outra nota, mesmo que seja o "mais recente" da pasta.
 */
function capturarPdfRecemGerado(chave, modeloDocumento, formatoPdf, destino, opts = {}) {
  const k = chaveNfe44(chave);
  if (k.length !== 44 || !destino) return null;
  const modelo = String(modeloDocumento || "65");
  const formato = String(formatoPdf || "termico").toLowerCase();
  const dirs = [
    ...new Set(
      [path.dirname(destino), PATHS.pdf, PATHS.saida, ...(opts.dirs || [])].filter(Boolean),
    ),
  ];
  const ok = (p) => pdfValidoParaChave(p, k, modelo, formato);

  let candidatos = opts.snapshot
    ? pdfsAlteradosDesde(opts.snapshot, dirs)
    : listarPdfsEmDirs(dirs);
  candidatos = candidatos.filter((f) => ok(f.path));
  candidatos.sort((a, b) => {
    const aKey = path.basename(a.path).includes(k) ? 1 : 0;
    const bKey = path.basename(b.path).includes(k) ? 1 : 0;
    if (bKey !== aKey) return bKey - aKey;
    return b.mtimeMs - a.mtimeMs;
  });

  let src = candidatos[0]?.path || null;
  if (!src && !opts.somenteNovos) {
    const loc = localizarPdfPorChave(k, modelo, formato);
    if (loc && ok(loc)) src = loc;
  }
  if (!src || !ok(src)) return null;

  fs.mkdirSync(path.dirname(destino), { recursive: true });
  if (path.resolve(src) !== path.resolve(destino)) {
    fs.copyFileSync(src, destino);
  }
  if (!ok(destino)) return null;
  return destino;
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
      if (!file || !fs.existsSync(file)) {
        log.warn({ file }, "Backup pendente ignorado — arquivo fonte ausente");
        continue;
      }
      const base = path.basename(file);
      const dest = path.join(PATHS.backup, `${Date.now()}-${base}`);
      fs.copyFileSync(file, dest);
    } catch (err) {
      remaining.push(line);
      log.warn({ err: err.message }, "Falha ao reprocessar backup pendente");
    }
  }
  if (remaining.length === 0) {
    fs.unlinkSync(q);
  } else {
    fs.writeFileSync(q, `${remaining.join("\n")}\n`, "utf8");
  }
}

const BACKUP_RETRY_MS = parseInt(process.env.BACKUP_RETRY_MS || "300000", 10);
let backupRetryTimer = null;

function iniciarBackupRetryScheduler() {
  if (backupRetryTimer) return;
  backupRetryTimer = setInterval(() => {
    try {
      processPendingBackups();
    } catch (err) {
      log.warn({ err: err.message }, "Scheduler backup pendente falhou");
    }
  }, BACKUP_RETRY_MS);
  if (typeof backupRetryTimer.unref === "function") backupRetryTimer.unref();
}

function pararBackupRetryScheduler() {
  if (backupRetryTimer) {
    clearInterval(backupRetryTimer);
    backupRetryTimer = null;
  }
}

function backup(sourceFile) {
  try {
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
    enqueueBackupRetry(sourceFile);
    return null;
  }
}

function normalizarXmlNfe(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/^\uFEFF/, "").trim();
  if (!s) return s;

  const starts = [
    s.search(/<\?xml/i),
    s.search(/<nfeProc[\s>/]/i),
    s.search(/<(?:[a-zA-Z0-9_]+:)?NFe[\s>/]/i),
    s.search(/<procEventoNFe[\s>/]/i),
  ].filter((i) => i >= 0);
  if (starts.length) {
    s = s.slice(Math.min(...starts));
  }

  const closeRe = /<\/(?:nfeProc|NFe|procEventoNFe|enviNFe)\s*>/gi;
  let lastEnd = -1;
  let m;
  while ((m = closeRe.exec(s)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd > 0) s = s.slice(0, lastEnd);

  if (/\\"/.test(s) || /\\u003[cC]/.test(s) || /\\\//.test(s)) {
    s = s
      .replace(/\\u003[cC]/g, "<")
      .replace(/\\u003[eE]/g, ">")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\//g, "/")
      .replace(/\\\\/g, "\\");
    closeRe.lastIndex = 0;
    lastEnd = -1;
    while ((m = closeRe.exec(s)) !== null) {
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd > 0) s = s.slice(0, lastEnd);
  }

  // Aspas tipográficas
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");

  if (/^<\?xml\s/i.test(s)) {
    const endDecl = s.indexOf("?>");
    if (endDecl < 0) {
      const tag = s.indexOf("<", 1);
      s = tag >= 0 ? s.slice(tag) : s;
    } else {
      let declInner = s.slice(5, endDecl).trim();
      const rest = s.slice(endDecl + 2);
      declInner = declInner
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'");
      declInner = declInner.replace(
        /\b(version|encoding|standalone)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s?>]+))/gi,
        (_, name, dq, sq, bare) => `${name}="${dq ?? sq ?? bare}"`,
      );
      const rebuilt = `<?xml ${declInner}?>`;
      if (/version\s*=\s*"/i.test(rebuilt)) {
        s = rebuilt + rest;
      } else {
        s = rest.replace(/^\s+/, "");
      }
    }
  }
  return s.trim();
}

function extrairXmlDaResposta(resposta) {
  const txt = coalescerRespostaAcbr(resposta);
  if (!txt) return null;

  // Preferir campo XML já desescapado via JSON.parse
  try {
    const j = JSON.parse(String(txt).trim());
    if (j && typeof j === "object") {
      const libResp = require("./acbrLibResposta");
      const parsed = libResp.parseJsonAcbrLib
        ? libResp.parseJsonAcbrLib(txt)
        : null;
      const candidato =
        (parsed && parsed.xml) ||
        j?.Envio?.XML ||
        j?.Envio?.xml ||
        j?.DistribuicaoDFe?.XML ||
        j?.xml ||
        j?.XML ||
        null;
      if (candidato && /<(?:nfeProc|NFe)[\s>]/i.test(String(candidato))) {
        return normalizarXmlNfe(String(candidato));
      }
    }
  } catch (_) {
    /* não é JSON puro */
  }

  const idx = txt.search(/<\?xml/i);
  let chunk = null;
  if (idx >= 0) {
    chunk = txt.slice(idx);
  } else {
    const xmlMatch = txt.match(
      /<(?:nfeProc|NFe|procEventoNFe)[\s\S]*?<\/(?:nfeProc|NFe|procEventoNFe)\s*>/i,
    );
    chunk = xmlMatch ? xmlMatch[0] : null;
  }
  return chunk ? normalizarXmlNfe(chunk) : null;
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

/** Localiza XML da chave (índice SQLite → flat ou aninhado ACBr). */
function localizarXmlPorChave(chave) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) return null;

  try {
    const filaFiscal = require("./filaFiscal");
    const doc = filaFiscal.buscarDocumentoPorChave(k);
    if (doc?.xml_path && fs.existsSync(doc.xml_path)) {
      const loaded = carregarXmlComProt(doc.xml_path, k);
      if (loaded) return loaded;
    }
  } catch (_) {}

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
    dhRecbto: bloc.match(/<dhRecbto>([^<]*)<\/dhRecbto>/i)?.[1]?.trim() || null,
  };
}

/** XML com protocolo SEFAZ (infProt) — necessário para DANFE/DANFC-e válido. */
function xmlEstaAutorizado(xml) {
  if (!xml || typeof xml !== "string") return false;
  const prot = extrairProtNFe(xml);
  return prot.cStat === "100" || prot.cStat === "150";
}

/** NFC-e/NF-e em contingência (tpEmis 4 EPEC / 6 SVC-AN / 7 SVC-RS / 9 off-line). */
function xmlEmitidoEmContingencia(xml) {
  if (!xml || typeof xml !== "string") return false;
  const m = xml.match(/<tpEmis>\s*([0-9]+)\s*<\/tpEmis>/i);
  return m != null && ["4", "6", "7", "9"].includes(m[1]);
}

/** Cupom/QR: autorizado na SEFAZ ou emitido em contingência (ainda sem infProt). */
function xmlProntoParaCupom(xml) {
  return xmlEstaAutorizado(xml) || xmlEmitidoEmContingencia(xml);
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

/**
 * XML para cupom térmico: autorizado (procNFe) ou assinado em contingência (tpEmis 4/6/7/9).
 * Nunca exige infProt — SEFAZ fora não pode bloquear a DANFC-e.
 */
function resolverXmlParaCupom(chave, xmlPathHint) {
  const k = String(chave || "").replace(/\D/g, "");
  const autorizado = resolverXmlParaImpressao(k, xmlPathHint);
  if (autorizado) return autorizado;

  const aceitar = (filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
      const xml = fs.readFileSync(filePath, "utf8");
      return xmlProntoParaCupom(xml) ? filePath : null;
    } catch (_) {
      return null;
    }
  };

  const hint = aceitar(xmlPathHint);
  if (hint) return hint;

  const local = k.length === 44 ? localizarXmlPorChave(k) : null;
  if (local?.path && xmlProntoParaCupom(local.xml)) return local.path;

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

function suffixPdfModelo(modeloDocumento = "65", formatoPdf = "termico") {
  const { suffixPdfModelo: suffixFmt } = require("./fiscalPdfFormato");
  return suffixFmt(modeloDocumento, formatoPdf);
}

function pastaModeloAcbr(modeloDocumento = "65") {
  return String(modeloDocumento) === "55" ? "NFe" : "NFCe";
}

/** Localiza PDF da chave (índice SQLite → flat ou aninhado ACBr). */
function localizarPdfPorChave(chave, modeloDocumento = "65", formatoPdf = "termico") {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) return null;

  const modelo = String(modeloDocumento || inferirModeloDaChave(k) || "65");
  const formato = String(formatoPdf || "termico").toLowerCase();

  try {
    const filaFiscal = require("./filaFiscal");
    const doc = filaFiscal.buscarDocumentoPorChave(k);
    if (
      doc?.pdf_path &&
      pdfValidoParaChave(doc.pdf_path, k, modelo, formato)
    ) {
      return doc.pdf_path;
    }
  } catch (_) {}

  const suffix = suffixPdfModelo(modelo, formato);

  const flat = path.join(PATHS.pdf, `${k}-${suffix}.pdf`);
  if (pdfValidoParaChave(flat, k, modelo, formato)) return flat;

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
      `${k}-danfce-a4.pdf`,
    ];
    for (const nome of candidatos) {
      const full = path.join(dir, nome);
      if (pdfValidoParaChave(full, k, modelo, formato)) return full;
    }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const match = entries.find(
        (e) =>
          e.isFile() &&
          e.name.toLowerCase().endsWith(".pdf") &&
          e.name.includes(k),
      );
      if (match && pdfValidoParaChave(path.join(dir, match.name), k, modelo, formato)) {
        return path.join(dir, match.name);
      }
    } catch (_) {
      /* próximo dir */
    }
  }

  for (const raiz of [PATHS.pdf, PATHS.saida]) {
    const found = buscarArquivoPdfRecursivo(raiz, k);
    if (found && pdfValidoParaChave(found, k, modelo, formato)) return found;
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

/** Sigla exibida no cupom térmico — NFC-e (65) ou NF-e (55). */
function siglaModeloDocumento(chave) {
  return isNfeModelo55(chave) ? "NF-e" : "NFC-e";
}

function tituloCupomFiscal(chave) {
  return `CUPOM FISCAL ${siglaModeloDocumento(chave)}`;
}

function tituloBlocoDocumentoFiscal(chave) {
  return `DOCUMENTO FISCAL ${siglaModeloDocumento(chave)}`;
}

function linhaNumeroSerieDocumento(chave, numeroNfe, serieNfe, opts = {}) {
  const seriePadrao = opts.seriePadrao || (isNfeModelo55(chave) ? "1" : "001");
  return `${siglaModeloDocumento(chave)}: ${numeroNfe || ""}  Serie: ${serieNfe || seriePadrao}`;
}

/** Copia PDF encontrado para path canônico do agente. */
function copiarPdfParaCanonico(chave, srcPath, modeloDocumento = "65", formatoPdf = "termico") {
  const k = String(chave || "").replace(/\D/g, "");
  const dest = path.join(
    PATHS.pdf,
    `${k}-${suffixPdfModelo(modeloDocumento, formatoPdf)}.pdf`,
  );
  if (!srcPath || !pdfValidoParaChave(srcPath, k, modeloDocumento, formatoPdf)) return null;
  if (path.resolve(srcPath) !== path.resolve(dest)) {
    fs.copyFileSync(srcPath, dest);
  }
  return dest;
}

/**
 * Resolve documento fiscal local — SQLite, XML em disco (backup/flat) ou resultado de emissão.
 */
function resolverDocumentoFiscalLocal(chave, numeroVenda) {
  const k = chave ? String(chave).replace(/\D/g, "") : null;
  let filaFiscal = null;
  try {
    filaFiscal = require("./filaFiscal");
    filaFiscal.init?.();
  } catch (_) {}

  if (filaFiscal) {
    const doc =
      (k && filaFiscal.buscarDocumentoPorChave(k)) ||
      (numeroVenda && filaFiscal.buscarDocumentoPorVenda(numeroVenda));
    if (doc) return doc;
  }

  if (k) {
    const local = localizarXmlPorChave(k);
    if (local?.path) {
      const prot = local.prot || extrairProtNFe(local.xml || "");
      const contingencia = xmlEmitidoEmContingencia(local.xml || "");
      return {
        chave: k,
        xml_path: local.path,
        numero_venda: numeroVenda || null,
        c_stat: prot?.cStat || (contingencia ? null : "100"),
        protocolo: prot?.nProt || null,
        tipo: contingencia ? "CONTINGENCIA_OFFLINE" : "AUTORIZADA",
      };
    }
  }

  if (numeroVenda && filaFiscal) {
    const res = filaFiscal.obterResultadoPorVenda(numeroVenda);
    if (res?.resultado) {
      try {
        const parsed = JSON.parse(res.resultado);
        if (parsed?.chave && parsed.chave !== k) {
          return resolverDocumentoFiscalLocal(parsed.chave, numeroVenda);
        }
      } catch (_) {}
    }
  }

  return null;
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
  pdfChaveCompativel,
  pdfValidoParaChave,
  extrairChavesNfeDoPdf,
  snapshotPdfs,
  aposentarPdfCanonico,
  capturarPdfRecemGerado,
  extrairXmlDaResposta,
  normalizarXmlNfe,
  extrairQrCodeDoXml,
  portalConsultaNfce,
  portalConsultaDocumento,
  isNfceModelo65,
  isNfeModelo55,
  siglaModeloDocumento,
  tituloCupomFiscal,
  tituloBlocoDocumentoFiscal,
  linhaNumeroSerieDocumento,
  extrairProtNFe,
  extrairChaveDoXml,
  localizarXmlPorChave,
  localizarXmlPorSerieNumero,
  localizarPdfPorChave,
  copiarPdfParaCanonico,
  extrairCnpjDaChave,
  xmlEstaAutorizado,
  xmlEmitidoEmContingencia,
  xmlProntoParaCupom,
  resolverXmlParaImpressao,
  resolverXmlParaCupom,
  resolverDocumentoFiscalLocal,
  iniciarBackupRetryScheduler,
  pararBackupRetryScheduler,
  processPendingBackups,
};
