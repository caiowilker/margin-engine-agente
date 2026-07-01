/**
 * Gravação atômica com backup, checksum e retry.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { mapFsError } = require("./runtimeErrors");

const DEFAULT_RETRIES = 3;
const RETRY_MS = 40;

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* sync backoff */
  }
}

function sha256(bufferOrPath) {
  const hash = crypto.createHash("sha256");
  if (Buffer.isBuffer(bufferOrPath)) {
    hash.update(bufferOrPath);
  } else if (typeof bufferOrPath === "string" && fs.existsSync(bufferOrPath)) {
    hash.update(fs.readFileSync(bufferOrPath));
  }
  return hash.digest("hex");
}

function writeFileAtomicSync(targetPath, data, options = {}) {
  const encoding = options.encoding;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const withBackup = options.backup !== false;
  const ensureDir = options.ensureDir;

  const dir = path.dirname(targetPath);
  if (ensureDir) ensureDir(dir);
  else fs.mkdirSync(dir, { recursive: true });

  const payload = encoding ? String(data) : data;
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (encoding) fs.writeFileSync(tmp, payload, encoding);
      else fs.writeFileSync(tmp, payload);

      if (withBackup && fs.existsSync(targetPath)) {
        try {
          fs.copyFileSync(targetPath, `${targetPath}.bak`);
        } catch {
          /* backup best-effort */
        }
      }

      fs.renameSync(tmp, targetPath);
      return { path: targetPath, checksum: sha256(targetPath) };
    } catch (err) {
      lastErr = err;
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      if (attempt < retries) sleep(RETRY_MS * attempt);
    }
  }

  throw mapFsError(lastErr, {
    arquivo: targetPath,
    diretorio: dir,
    operacao: "gravar",
    tentativa: retries,
  });
}

function writeJsonAtomicSync(targetPath, obj, options = {}) {
  const json = JSON.stringify(obj, null, 2);
  return writeFileAtomicSync(targetPath, json, { ...options, encoding: "utf8" });
}

module.exports = {
  writeFileAtomicSync,
  writeJsonAtomicSync,
  sha256,
  sleep,
};
