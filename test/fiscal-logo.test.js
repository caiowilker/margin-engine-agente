#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fiscal-logo-"));
process.env.MARGIN_ENGINE_ROOT = ROOT;

const { resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();

delete require.cache[require.resolve("../marginPaths")];
delete require.cache[require.resolve("../fiscal/fiscalLogo")];

const fiscalLogo = require("../fiscal/fiscalLogo");
const { applyDanfeLogoAcbrLib } = require("../fiscalPdfFormato");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

console.log("fiscal-logo.test.js\n");

test("salvar PNG grava em assets/logo e retorna preview", () => {
  const saved = fiscalLogo.salvar({
    buffer: PNG_1X1,
    ativo: true,
    origem: "local",
  });
  assert.strictEqual(saved.existe, true);
  assert.strictEqual(saved.ativo, true);
  assert.strictEqual(saved.extensao, "png");
  assert.ok(saved.sha256 && saved.sha256.length === 64);
  assert.ok(saved.previewBase64 && saved.previewBase64.startsWith("data:image/png"));
  assert.ok(fs.existsSync(path.join(ROOT, "assets", "logo", "logo.png")));
});

test("ler reflete meta após salvar", () => {
  const info = fiscalLogo.ler();
  assert.strictEqual(info.ativo, true);
  assert.ok(info.caminhoAbsoluto);
});

test("precisaSincronizar quando arquivo local ausente", () => {
  fiscalLogo.salvar({ buffer: PNG_1X1, ativo: true, origem: "backend", sha256Remoto: "abc" });
  const info = fiscalLogo.ler();
  fs.unlinkSync(info.caminhoAbsoluto);
  assert.strictEqual(fiscalLogo.precisaSincronizar("abc"), true);
});

test("precisaSincronizar quando SHA remoto difere", () => {
  fiscalLogo.salvar({ buffer: PNG_1X1, ativo: true, origem: "backend" });
  const info = fiscalLogo.ler();
  assert.strictEqual(fiscalLogo.precisaSincronizar(info.sha256), false);
  assert.strictEqual(fiscalLogo.precisaSincronizar("outro-sha"), true);
});

test("remover desativa logo e apaga arquivos", () => {
  const removed = fiscalLogo.remover();
  assert.strictEqual(removed.ativo, false);
  assert.strictEqual(removed.existe, false);
  assert.strictEqual(fs.existsSync(path.join(ROOT, "assets", "logo", "logo.png")), false);
});

test("rejeita formato inválido", () => {
  assert.throws(
    () => fiscalLogo.salvar({ buffer: Buffer.from("not-an-image"), ativo: true }),
    /PNG ou JPG/,
  );
});

test("applyDanfeLogoAcbrLib sem logo não chama configGravarValor", () => {
  const calls = [];
  const inst = {
    configGravarValor: (...args) => calls.push(args),
  };
  applyDanfeLogoAcbrLib(inst, { root: ROOT });
  assert.strictEqual(calls.length, 0);
});

test("applyDanfeLogoAcbrLib com logo usa caixa oficial do emitente (sem expandir)", () => {
  fiscalLogo.salvar({ buffer: PNG_1X1, ativo: true, origem: "local" });
  const calls = [];
  const inst = {
    configGravarValor: (...args) => calls.push(args),
  };
  applyDanfeLogoAcbrLib(inst, { root: ROOT }, { modelo: "55", formatoPdf: "a4" });
  assert.ok(calls.length >= 1);
  const pathLogo = calls.find((c) => c[0] === "DANFE" && c[1] === "PathLogo");
  assert.ok(pathLogo, "PathLogo deve ser configurado");
  assert.ok(pathLogo[2]);
  assert.ok(path.isAbsolute(pathLogo[2]) || pathLogo[2].includes("logo"), "PathLogo deve apontar para o arquivo");
  const expandir = calls.find((c) => c[0] === "DANFE" && c[1] === "ExpandeLogoMarca");
  assert.ok(expandir, "ExpandeLogoMarca deve ser configurado");
  assert.strictEqual(expandir[2], "0", "ExpandeLogoMarca=0: caixa oficial do emitente");
  const esticar = calls.find((c) => c[0] === "DANFE" && c[1] === "ExpandeLogoMarca.Esticar");
  assert.ok(esticar && esticar[2] === "0", "Esticar=0 preserva proporção");
  const dim = calls.find((c) => c[0] === "DANFE" && c[1] === "ExpandeLogoMarca.Dimensionar");
  assert.ok(dim && dim[2] === "1");
  const topo = calls.find((c) => c[0] === "DANFENFe" && c[1] === "LogoemCima");
  assert.ok(topo && topo[2] === "0", "LogoemCima=0: logo à esquerda, não empilhada");
  assert.ok(
    !calls.some((c) => String(c[1]).includes("Largura") && c[2] === "0"),
    "não gravar Largura=0 (ACBr usa pixels da imagem e estoura o cabeçalho)",
  );
  assert.ok(
    !calls.some((c) => String(c[1]).includes("TamanhoLogo") && c[2] === "0"),
    "não gravar TamanhoLogo=0 (colapsa o picture no FastReport)",
  );
});

test("danfeLogoMonitorComandos usa leiaute oficial", () => {
  const { danfeLogoMonitorComandos } = require("../fiscalPdfFormato");
  const cmds = danfeLogoMonitorComandos("C:/logo.png");
  assert.ok(cmds.some((c) => c.includes("ExpandeLogoMarca") && c.includes('"0"')));
  assert.ok(cmds.some((c) => c.includes("ExpandeLogoMarca.Esticar") && c.includes('"0"')));
  assert.ok(cmds.some((c) => c.includes("LogoemCima") && c.includes('"0"')));
  assert.ok(!cmds.some((c) => c.includes("ExpandeLogoMarca\",\"1\"")));
  assert.ok(!cmds.some((c) => c.includes("Largura") && c.includes('"0"')));
});

test("applyDanfeLogoAcbrLib ignora NFC-e térmico", () => {
  fiscalLogo.salvar({ buffer: PNG_1X1, ativo: true, origem: "local" });
  const calls = [];
  const inst = {
    configGravarValor: (...args) => calls.push(args),
  };
  applyDanfeLogoAcbrLib(inst, { root: ROOT }, { modelo: "65", formatoPdf: "termico" });
  assert.strictEqual(calls.length, 0);
});

fiscalLogo.remover();

console.log(`\n${passed}/${passed + failed} testes passaram`);
process.exit(failed > 0 ? 1 : 0);
