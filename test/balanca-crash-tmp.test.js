#!/usr/bin/env node
"use strict";

/**
 * Simula crash no meio da escrita: tmp fica órfão; limpeza remove só tmp próprio.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "me-balanca-crash-"));
process.env.MARGIN_ENGINE_ROOT = tmpRoot;
process.env.LOG_SILENT = "true";
require("../runtime/directoryManager").resetDirectoryManager();

const pasta = require("../src/balanca/pasta");
const { TMP_PREFIX } = require("../src/balanca/allowlist");

test("crash mid-write: só remove .me-balanca-*.tmp, preserva ITENSMGV do MGV", () => {
  const dir = path.join(tmpRoot, "mgv");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ITENSMGV.TXT"), "do-mgv");
  fs.writeFileSync(path.join(dir, `${TMP_PREFIX}ITENSMGV.TXT.999.tmp`), "parcial");
  const n = pasta.limparTemporariosOrfaos(dir);
  assert.ok(n >= 1);
  assert.equal(fs.readFileSync(path.join(dir, "ITENSMGV.TXT"), "utf8"), "do-mgv");
  assert.equal(fs.existsSync(path.join(dir, `${TMP_PREFIX}ITENSMGV.TXT.999.tmp`)), false);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
