"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-chave-"));
process.env.MARGIN_ENGINE_ROOT = root;
process.env.MARGIN_DATA_DIR = root;

const { resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();

for (const id of [
  "../runtime/directoryManager",
  "../marginPaths",
  "../documentosFiscais",
]) {
  delete require.cache[require.resolve(id)];
}

const { PATHS } = require("../marginPaths");
const docs = require("../documentosFiscais");

fs.mkdirSync(PATHS.pdf, { recursive: true });
console.log("pdf-chave.test.js\n");

const CHAVE_A = "31260817331282000102650010000000461000000015";
const CHAVE_B = "31260817331282000102650010000000451000000018";

function pdfBuf(chave, { a4 = true, extra = "" } = {}) {
  const box = a4 ? "0 0 595 842" : "0 0 226 800";
  const body = chave
    ? `Chave ${chave.slice(0, 4)} ${chave.slice(4, 8)} ${chave.slice(8)}`
    : extra || "sem chave";
  const head = `%PDF-1.4\n1 0 obj<</Type/Page/MediaBox[${box}]>>endobj\n(${body})\n`;
  const pad = a4 ? 400 : 80;
  return Buffer.concat([Buffer.from(head), Buffer.alloc(pad, 32)]);
}

function writePdf(name, chave, opts) {
  const p = path.join(PATHS.pdf, name);
  fs.writeFileSync(p, pdfBuf(chave, opts));
  return p;
}

test("pdfChaveCompativel rejeita PDF de outra NFC-e", () => {
  const p = writePdf("outra.pdf", CHAVE_B, { a4: true });
  assert.equal(docs.pdfChaveCompativel(p, CHAVE_A), false);
  assert.equal(docs.pdfChaveCompativel(p, CHAVE_B), true);
});

test("pdfChaveCompativel aceita PDF sem chave extraível (inconclusivo)", () => {
  const p = writePdf("inconclusivo.pdf", null, { a4: true, extra: "xxxxx" });
  assert.equal(docs.pdfChaveCompativel(p, CHAVE_A), true);
});

test("pdfChaveCompativel reconhece chave com espaços", () => {
  const p = writePdf("espaços.pdf", CHAVE_A, { a4: true });
  assert.ok(docs.extrairChavesNfeDoPdf(p).includes(CHAVE_A));
  assert.equal(docs.pdfChaveCompativel(p, CHAVE_A), true);
});

test("capturarPdfRecemGerado ignora canônico velho e pega o PDF novo da chave", () => {
  const dest = path.join(PATHS.pdf, `${CHAVE_A}-danfce-a4.pdf`);
  fs.writeFileSync(dest, pdfBuf(CHAVE_B, { a4: true }));
  const snap = docs.snapshotPdfs([PATHS.pdf]);
  const gerado = writePdf("NFCe.pdf", CHAVE_A, { a4: true });
  const out = docs.capturarPdfRecemGerado(CHAVE_A, "65", "a4", dest, {
    snapshot: snap,
    dirs: [PATHS.pdf],
    somenteNovos: true,
  });
  assert.equal(path.resolve(out), path.resolve(dest));
  assert.ok(docs.pdfChaveCompativel(dest, CHAVE_A));
  assert.equal(docs.pdfChaveCompativel(dest, CHAVE_B), false);
  assert.ok(fs.existsSync(gerado));
});

test("capturarPdfRecemGerado não devolve PDF antigo quando skip/somenteNovos", () => {
  const dest = path.join(PATHS.pdf, `${CHAVE_B}-danfce-a4.pdf`);
  fs.writeFileSync(dest, pdfBuf(CHAVE_A, { a4: true }));
  const snap = docs.snapshotPdfs([PATHS.pdf]);
  const out = docs.capturarPdfRecemGerado(CHAVE_B, "65", "a4", dest, {
    snapshot: snap,
    dirs: [PATHS.pdf],
    somenteNovos: true,
  });
  assert.equal(out, null);
});

test("aposentarPdfCanonico remove o arquivo velho", () => {
  const dest = path.join(PATHS.pdf, `${CHAVE_A}-danfce.pdf`);
  fs.writeFileSync(dest, pdfBuf(CHAVE_B, { a4: false }));
  assert.equal(docs.aposentarPdfCanonico(dest), true);
  assert.equal(fs.existsSync(dest), false);
});

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}