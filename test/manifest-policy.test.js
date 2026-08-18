#!/usr/bin/env node
/**
 * Política do update.zip + comparação de versão (anti-downgrade).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  listarArquivosUpdate,
  validarCoberturaObrigatoria,
  deveIncluirArquivo,
  INCLUDE_DIRS,
} = require("../scripts/manifestPolicy");
const {
  compararVersao,
  isUpgrade,
  isSameVersion,
  isDowngrade,
} = require("../updaterVersion");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

console.log("\nmanifest-policy + updaterVersion\n");

test("compararVersao — ordem semver (paridade Inno)", () => {
  assert.strictEqual(compararVersao("1.0.0", "1.0.0"), 0);
  assert.strictEqual(compararVersao("v1.0.1", "1.0.0"), 1);
  assert.strictEqual(compararVersao("1.0.0", "1.0.1"), -1);
  assert.strictEqual(compararVersao("1.10.0", "1.9.9"), 1);
  assert.strictEqual(isUpgrade("1.0.2", "1.0.1"), true);
  assert.strictEqual(isSameVersion("1.0.1", "v1.0.1"), true);
  assert.strictEqual(isDowngrade("1.0.0", "1.0.1"), true);
});

test("deveIncluirArquivo — bloqueia nativos e testes", () => {
  assert.strictEqual(deveIncluirArquivo("print/qrCodeAcbrBmp.js"), true);
  assert.strictEqual(deveIncluirArquivo("acbrlib/ACBrNFe64.dll"), false);
  assert.strictEqual(deveIncluirArquivo("better-sqlite3.node"), false);
  assert.strictEqual(deveIncluirArquivo("foo.test.js"), false);
  assert.strictEqual(deveIncluirArquivo("frontend-dist/assets/app.js.br"), false);
  assert.strictEqual(deveIncluirArquivo("frontend-dist/assets/app.js.gz"), false);
});

test("listarArquivosUpdate — cobre print/fiscal/runtime/package.json", () => {
  const root = path.join(__dirname, "..");
  const lista = listarArquivosUpdate(root);
  const cob = validarCoberturaObrigatoria(lista);
  assert.strictEqual(cob.ok, true, `faltando: ${cob.faltando.join(", ")}`);
  assert.ok(lista.includes("package.json"));
  assert.ok(lista.includes("print/qrCodeAcbrBmp.js"));
  assert.ok(lista.includes("thermalText.js"));
  assert.ok(lista.includes("mesaFila.js"));
  assert.ok(lista.includes("updaterVersion.js"));
  // frontend-dist/assets NÃO deve ser bloqueado pelo exclude da pasta assets/ da raiz
  const hasFront = fs.existsSync(path.join(root, "frontend-dist", "assets"));
  if (hasFront) {
    assert.ok(
      lista.some((a) => a.startsWith("frontend-dist/assets/")),
      "frontend-dist/assets deve entrar no update",
    );
  } else {
    console.log("  · frontend-dist ausente — skip cobertura SPA (copie o build do front)");
  }
  assert.ok(!lista.some((a) => a.startsWith("node_modules/")));
  assert.ok(!lista.some((a) => a.startsWith("test/")));
  assert.ok(!lista.some((a) => a.startsWith("scripts/")));
  assert.ok(!lista.some((a) => a.endsWith(".br") || a.endsWith(".gz")));
  assert.ok(!lista.includes("manifest.json"));
  assert.ok(!lista.some((a) => a === "assets/margin-engine.ico" || a.startsWith("assets/")));
  for (const dir of INCLUDE_DIRS.filter((d) => d !== "frontend-dist")) {
    assert.ok(
      lista.some((a) => a.startsWith(`${dir}/`)),
      `sem arquivos em ${dir}/`,
    );
  }
});

test("listarArquivosUpdate — exclui DLL em árvore fictícia", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "me-mp-"));
  fs.mkdirSync(path.join(tmp, "print"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), '{"version":"1.0.0"}');
  fs.writeFileSync(path.join(tmp, "index.js"), "//");
  fs.writeFileSync(path.join(tmp, "print/ok.js"), "//");
  fs.writeFileSync(path.join(tmp, "print/evil.dll"), "bin");
  fs.mkdirSync(path.join(tmp, "print/node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "print/node_modules/x/a.js"), "//");
  const lista = listarArquivosUpdate(tmp);
  assert.ok(lista.includes("print/ok.js"));
  assert.ok(!lista.includes("print/evil.dll"));
  assert.ok(!lista.some((a) => a.includes("node_modules")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\nmanifest-policy: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
