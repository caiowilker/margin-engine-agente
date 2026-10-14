"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { quarentenarResiduaisAposTimeout, diagnosticarPasta } = require("../src/balanca/pasta");

let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "balanca-orphan-"));
});

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("quarentena move ARQSOK/ITENSMGV e libera pasta", () => {
  fs.writeFileSync(path.join(tmp, "ARQSOK.TXT"), "");
  fs.writeFileSync(path.join(tmp, "ITENSMGV.TXT"), "x");
  const antes = diagnosticarPasta(tmp);
  assert.equal(antes.ocupada, true);

  const r = quarentenarResiduaisAposTimeout(tmp);
  assert.ok(r.movidos.includes("ARQSOK.TXT"));
  assert.ok(r.movidos.includes("ITENSMGV.TXT"));
  assert.ok(fs.existsSync(path.join(tmp, "_margin_orphan")));

  const depois = diagnosticarPasta(tmp);
  assert.equal(depois.ok, true);
  assert.equal(depois.ocupada, false);
});
