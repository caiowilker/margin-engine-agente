// Integridade SQLite, espaço em disco, purge de arquivos fiscais
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { PATHS } = require("./marginPaths");
const log = require("./logger").child({ modulo: "fiscal_storage" });

const MIN_DISK_MB = parseInt(process.env.FISCAL_MIN_DISK_MB || "500", 10);
const MIN_MB_XML = parseInt(process.env.DISK_MIN_MB_XML || "50", 10);
const MIN_MB_PDF = parseInt(process.env.DISK_MIN_MB_PDF || "50", 10);
const MIN_MB_BACKUP = parseInt(process.env.DISK_MIN_MB_BACKUP || "100", 10);
let modoDegradado = false;

function resolverDirAlvo(targetPath) {
  if (!targetPath) return PATHS.root;
  try {
    if (fs.existsSync(targetPath)) {
      return fs.statSync(targetPath).isDirectory()
        ? targetPath
        : path.dirname(targetPath);
    }
  } catch (_) {}
  return path.dirname(targetPath);
}

function obterEspacoLivreMb(dir) {
  const alvo = resolverDirAlvo(dir);
  if (!fs.existsSync(alvo)) {
    try {
      fs.mkdirSync(alvo, { recursive: true });
    } catch (_) {}
  }
  try {
    if (typeof fs.statfsSync === "function") {
      const st = fs.statfsSync(alvo);
      return Math.floor((st.bavail * st.bsize) / (1024 * 1024));
    }
  } catch (_) {}
  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const drive = path.parse(alvo).root.replace("\\", "");
      const out = execSync(
        `wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`,
        { encoding: "utf8", timeout: 5000 },
      );
      const m = out.match(/FreeSpace=(\d+)/);
      if (m) return Math.floor(parseInt(m[1], 10) / (1024 * 1024));
    } catch (_) {}
  }
  return null;
}

function checkDiskSpace(targetPath, minMB) {
  const livresMB = obterEspacoLivreMb(targetPath);
  if (livresMB === null) return { ok: true, livresMB: null, minimoMB: minMB };
  const ok = livresMB >= minMB;
  if (!ok) modoDegradado = true;
  return { ok, livresMB, minimoMB: minMB };
}

function classificarStatusDisco(livresMB, minMB) {
  if (livresMB === null) return "ok";
  if (livresMB >= minMB) return "ok";
  if (livresMB >= minMB * 0.5) return "baixo";
  return "critico";
}

function statusDiscoPorTipo() {
  const xml = checkDiskSpace(PATHS.xml, MIN_MB_XML);
  const pdf = checkDiskSpace(PATHS.pdf, MIN_MB_PDF);
  const backup = checkDiskSpace(PATHS.backup, MIN_MB_BACKUP);
  return {
    xml: {
      livresMB: xml.livresMB,
      status: classificarStatusDisco(xml.livresMB, MIN_MB_XML),
    },
    pdf: {
      livresMB: pdf.livresMB,
      status: classificarStatusDisco(pdf.livresMB, MIN_MB_PDF),
    },
    backup: {
      livresMB: backup.livresMB,
      status: classificarStatusDisco(backup.livresMB, MIN_MB_BACKUP),
    },
  };
}

function verificarEspacoDisco() {
  try {
    const dir = PATHS.root;
    const livresMB = obterEspacoLivreMb(dir);
    if (livresMB === null) return { ok: true, livreMb: null };
    const ok = livresMB >= MIN_DISK_MB;
    modoDegradado = !ok;
    return { ok, livreMb: livresMB, minimoMb: MIN_DISK_MB, degradado: modoDegradado };
  } catch (err) {
    log.warn({ err: err.message }, "Falha ao verificar espaço em disco");
    return { ok: true, livreMb: null, aviso: err.message };
  }
}

function integrityCheck(dbPath) {
  if (!fs.existsSync(dbPath)) return { ok: true, path: dbPath, skipped: true };
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.pragma("integrity_check");
    const ok = row[0]?.integrity_check === "ok";
    return { ok, path: dbPath, result: row[0]?.integrity_check };
  } finally {
    db.close();
  }
}

function integrityCheckBoot() {
  const base = path.join(__dirname, "data");
  const dbs = [
    path.join(base, "fila_fiscal.db"),
    path.join(base, "fila.db"),
    path.join(base, "fiscal_numeracao.db"),
    path.join(base, "fiscal_metrics.db"),
    path.join(base, "audit.db"),
  ];
  const resultados = dbs.map((p) => integrityCheck(p));
  const falhas = resultados.filter((r) => !r.ok && !r.skipped);
  if (falhas.length) {
    log.error({ falhas }, "integrity_check falhou");
    throw new Error(
      `SQLite integrity_check falhou: ${falhas.map((f) => f.path).join(", ")}`,
    );
  }
  return resultados;
}

function purgeArquivos(diasXml = 180, diasPdf = 180, diasBackup = 90) {
  const cortes = [
    { dir: PATHS.xml, dias: diasXml },
    { dir: PATHS.pdf, dias: diasPdf },
    { dir: PATHS.backup, dias: diasBackup },
  ];
  const agora = Date.now();
  let removidos = 0;
  for (const { dir, dias } of cortes) {
    if (!fs.existsSync(dir)) continue;
    const limite = agora - dias * 86400000;
    for (const nome of fs.readdirSync(dir)) {
      const fp = path.join(dir, nome);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < limite) {
          fs.unlinkSync(fp);
          removidos++;
        }
      } catch (_) {}
    }
  }
  return { removidos, diasXml, diasPdf, diasBackup };
}

function isModoDegradado() {
  return modoDegradado;
}

function setModoDegradado(valor) {
  modoDegradado = !!valor;
}

function exigirEspacoParaEscrita() {
  const d = verificarEspacoDisco();
  if (!d.ok) {
    throw new Error(
      `Espaço em disco insuficiente (${d.livreMb}MB livres, mínimo ${MIN_DISK_MB}MB)`,
    );
  }
}

module.exports = {
  checkDiskSpace,
  classificarStatusDisco,
  statusDiscoPorTipo,
  verificarEspacoDisco,
  integrityCheckBoot,
  purgeArquivos,
  isModoDegradado,
  setModoDegradado,
  exigirEspacoParaEscrita,
  MIN_MB_XML,
  MIN_MB_PDF,
  MIN_MB_BACKUP,
};
