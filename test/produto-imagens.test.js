/**
 * Testes leves — imagens de produto (sem loops massivos, cleanup garantido).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(os.tmpdir(), `me-img-test-${process.pid}`);
process.env.MARGIN_ENGINE_ROOT = ROOT;

const { getDirectoryManager, resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();
const pi = require("../storage/produtoImagens");

/** PNG 1x1 válido (~68 bytes) */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function cleanup() {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {}
}

async function run() {
  cleanup();
  getDirectoryManager(ROOT).ensureAll();

  assert.strictEqual(pi.sniffMime(PNG_1X1), "image/png");
  assert.throws(() => pi.validarBuffer(Buffer.from("BMxxxx", "utf8")));

  const sharp = require("sharp");
  if (!sharp) {
    console.log("sharp indisponível — pulando testes de processamento");
    cleanup();
    return;
  }

  const produtoId = "00000000-0000-4000-8000-000000000099";
  const meta = await pi.salvar({
    produtoId,
    buffer: PNG_1X1,
    tenantId: "tenant-test",
    usuario: "test",
  });

  assert.ok(meta.id);
  assert.strictEqual(meta.version, 1);
  assert.ok(meta.sha256);
  assert.ok(fs.existsSync(pi.pathsFor("tenant-test", produtoId).thumb));

  const hit = pi.obterArquivo(produtoId, "thumb", "tenant-test");
  assert.ok(hit && fs.existsSync(hit.file));

  const rem = pi.remover(produtoId, { tenantId: "tenant-test" });
  assert.ok(rem.ok);
  assert.strictEqual(pi.obterMeta(produtoId, "tenant-test"), null);

  cleanup();
  console.log("produto-imagens.test.js — OK");
}

run().catch((err) => {
  cleanup();
  console.error(err);
  process.exit(1);
});
