const assert = require("assert");
const { test } = require("node:test");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "data-fiscal-secrets");

test("salvarSync sempre grava arquivo vault mesmo com keyring", () => {
  if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.MARGIN_ENGINE_ROOT = ROOT;
  process.env.LOG_SILENT = "true";

  const { resetDirectoryManager } = require("../runtime/directoryManager");
  resetDirectoryManager();
  delete require.cache[require.resolve("../fiscalSecrets")];
  const secrets = require("../fiscalSecrets");

  secrets.salvarSync({ certificadoSenha: "12345678", nfceCsc: "abc" });
  const vaultPath = secrets.fallbackVaultPath();
  assert.ok(fs.existsSync(vaultPath), "arquivo .fiscal-vault deve existir");

  // Simula serviço sem keyring útil: lerSync ainda acha a senha no arquivo.
  const lido = secrets.lerSync();
  assert.equal(lido.certificadoSenha, "12345678");

  secrets.limpar();
  fs.rmSync(ROOT, { recursive: true, force: true });
  delete process.env.MARGIN_ENGINE_ROOT;
});
