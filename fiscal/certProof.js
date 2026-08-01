/**
 * Prova de identidade do certificado A1 (PFX) — hash + metadados públicos.
 * Nunca retorna senha. Metadados NotAfter/thumbprint são best-effort.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

/** Remove BOM, aspas e espaços — senhas coladas do painel/Windows. */
function normalizeCertPassword(senha) {
  let s = String(senha ?? "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/^\uFEFF/, "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function sha256File(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch (_) {
    return null;
  }
}

function senhaFingerprint(senha) {
  const s = String(senha || "");
  if (!s) return "0";
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function parsePemMeta(pem) {
  try {
    const { X509Certificate } = crypto;
    if (typeof X509Certificate !== "function") return null;
    const cert = new X509Certificate(pem);
    const notAfter = cert.validTo ? new Date(cert.validTo) : null;
    const notBefore = cert.validFrom ? new Date(cert.validFrom) : null;
    const thumb =
      (cert.fingerprint256 && String(cert.fingerprint256).replace(/:/g, "").toUpperCase()) ||
      (cert.fingerprint && String(cert.fingerprint).replace(/:/g, "").toUpperCase()) ||
      null;
    return {
      subject: cert.subject || null,
      thumbprint: thumb,
      notBefore: notBefore && !Number.isNaN(notBefore.getTime()) ? notBefore.toISOString() : null,
      notAfter: notAfter && !Number.isNaN(notAfter.getTime()) ? notAfter.toISOString() : null,
      expired: notAfter && !Number.isNaN(notAfter.getTime()) ? notAfter.getTime() < Date.now() : null,
    };
  } catch (_) {
    return null;
  }
}

function inspectViaOpenssl(pfxPath, password) {
  try {
    const out = execFileSync(
      "openssl",
      ["pkcs12", "-in", pfxPath, "-nokeys", "-clcerts", "-passin", `pass:${password}`],
      { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const pem = out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    if (!pem) return null;
    const meta = parsePemMeta(pem[0]);
    if (!meta) return null;
    return { ...meta, source: "openssl" };
  } catch (_) {
    return null;
  }
}

function inspectViaPowershell(pfxPath, password) {
  if (process.platform !== "win32") return null;
  try {
    // Uma única expressão — evita quebra de hash literal ao juntar com ";"
    const script = [
      "$ErrorActionPreference='Stop'",
      `$plain='${String(password).replace(/'/g, "''")}'`,
      "$sec=ConvertTo-SecureString $plain -AsPlainText -Force",
      `$d=Get-PfxData -FilePath '${String(pfxPath).replace(/'/g, "''")}' -Password $sec`,
      "$c=$d.EndEntityCertificates | Select-Object -First 1",
      "if(-not $c){throw 'no end entity'}",
      "[ordered]@{Subject=$c.Subject;Thumbprint=$c.Thumbprint;NotBefore=$c.NotBefore.ToString('o');NotAfter=$c.NotAfter.ToString('o')} | ConvertTo-Json -Compress",
    ].join("; ");
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
    const json = JSON.parse(String(out || "").trim());
    const notAfter = json.NotAfter ? new Date(json.NotAfter) : null;
    return {
      subject: json.Subject || null,
      thumbprint: json.Thumbprint ? String(json.Thumbprint).toUpperCase() : null,
      notBefore: json.NotBefore || null,
      notAfter: notAfter && !Number.isNaN(notAfter.getTime()) ? notAfter.toISOString() : null,
      expired: notAfter && !Number.isNaN(notAfter.getTime()) ? notAfter.getTime() < Date.now() : null,
      source: "powershell",
    };
  } catch (_) {
    return null;
  }
}

/**
 * Metadados públicos do PFX (requer senha para OpenSSL/PowerShell).
 */
function inspectPfxMeta(pfxPath, password) {
  const empty = {
    subject: null,
    thumbprint: null,
    notBefore: null,
    notAfter: null,
    expired: null,
    source: null,
  };
  const pwd = normalizeCertPassword(password);
  if (!pfxPath || !fs.existsSync(pfxPath) || !pwd) return empty;
  return (
    inspectViaOpenssl(pfxPath, pwd) ||
    inspectViaPowershell(pfxPath, pwd) ||
    empty
  );
}

/**
 * Valida se a senha do cofre abre o PFX (independente do ACBrLib).
 * @returns {{ ok: boolean, reason: string, meta?: object }}
 */
function validatePfxPassword(pfxPath, password) {
  const pwd = normalizeCertPassword(password);
  if (!pfxPath || !fs.existsSync(pfxPath)) {
    return { ok: false, reason: "arquivo_ausente" };
  }
  if (!pwd) {
    return { ok: false, reason: "senha_ausente" };
  }
  const meta = inspectPfxMeta(pfxPath, pwd);
  if (meta.thumbprint || meta.notAfter || meta.subject) {
    return {
      ok: true,
      reason: "ok",
      meta: {
        thumbprint: meta.thumbprint,
        notAfter: meta.notAfter,
        expired: meta.expired,
        source: meta.source,
      },
    };
  }
  // Tentativa explícita falhou (OpenSSL/PowerShell rejeitaram a senha).
  return { ok: false, reason: "senha_incorreta" };
}

/**
 * Prova completa origem × staged — sem senha.
 */
function buildCertProof({ sourcePath, stagedPath, password, synced = false } = {}) {
  const sourceSha256 = sha256File(sourcePath);
  const stagedSha256 = sha256File(stagedPath);
  const meta = inspectPfxMeta(stagedPath || sourcePath, password);
  const match =
    sourceSha256 && stagedSha256 ? sourceSha256 === stagedSha256 : sourceSha256 == null && stagedSha256 == null;
  return {
    sourcePath: sourcePath || null,
    stagedPath: stagedPath || null,
    sourceSha256,
    stagedSha256,
    hashMatch: match,
    synced: !!synced,
    senhaPresente: !!password,
    subject: meta.subject,
    thumbprint: meta.thumbprint,
    notBefore: meta.notBefore,
    notAfter: meta.notAfter,
    expired: meta.expired,
    metaSource: meta.source,
    basename: stagedPath || sourcePath ? path.basename(stagedPath || sourcePath) : null,
  };
}

/** Campos seguros para log/status (sem paths sensíveis longos se preferir — mantém paths). */
function certProofForLog(proof) {
  if (!proof) return null;
  return {
    basename: proof.basename,
    sourceSha256: proof.sourceSha256,
    stagedSha256: proof.stagedSha256,
    hashMatch: proof.hashMatch,
    synced: proof.synced,
    senhaPresente: proof.senhaPresente,
    thumbprint: proof.thumbprint,
    notBefore: proof.notBefore,
    notAfter: proof.notAfter,
    expired: proof.expired,
    metaSource: proof.metaSource,
    subject: proof.subject,
  };
}

module.exports = {
  normalizeCertPassword,
  sha256File,
  senhaFingerprint,
  inspectPfxMeta,
  validatePfxPassword,
  buildCertProof,
  certProofForLog,
};
