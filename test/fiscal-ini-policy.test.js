#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

delete process.env.FISCAL_ALLOW_LOCAL_INI;
delete process.env.HOMOLOG_ACBRLIB;
delete process.env.CONTINGENCIA_OFFLINE_AUTO;

const policy = require("../fiscal/fiscalIniPolicy");

assert.throws(
  () => policy.requireDocumentIniOrAllowLocal({}, "NFC-e"),
  /documentIni obrigatório/,
);

try {
  policy.requireDocumentIniOrAllowLocal({}, "NFC-e");
  assert.fail("deveria lançar");
} catch (err) {
  assert.equal(err.permanente, true, "falta de documentIni deve ser permanente (sem retry)");
}

// Flag sozinha SEM evidência de contingência → ainda bloqueia (anti-bypass MFCS)
assert.throws(
  () =>
    policy.requireDocumentIniOrAllowLocal(
      { permitirIniLocalContingencia: true },
      "NFC-e",
    ),
  /documentIni obrigatório/,
);

// Flag + evidência do PDV
policy.requireDocumentIniOrAllowLocal(
  {
    permitirIniLocalContingencia: true,
    contingenciaAtiva: true,
  },
  "NFC-e",
);

assert.throws(
  () =>
    policy.requireDocumentIniOrAllowLocal(
      { permitirIniLocalContingencia: true, contingenciaAtiva: true },
      "NF-e",
    ),
  /documentIni obrigatório/,
  "contingência não libera INI local para NF-e 55",
);

process.env.FISCAL_ALLOW_LOCAL_INI = "true";
policy.requireDocumentIniOrAllowLocal({}, "NFC-e");
delete process.env.FISCAL_ALLOW_LOCAL_INI;

policy.requireDocumentIniOrAllowLocal({ documentIni: "[NFe]\nnNF=1" }, "NFC-e");

// Contingência operacional ativa (arquivo) libera NFC-e sem flag
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ini-pol-"));
const agentDir = path.join(tmp, "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(
  path.join(agentDir, "contingencia.json"),
  JSON.stringify({ ativa: true }),
  "utf8",
);

const dm = require("../runtime/directoryManager");
const prev = dm.getDirectoryManager;
dm.getDirectoryManager = () => ({
  file: (_ns, name) => path.join(agentDir, name),
});
try {
  policy.requireDocumentIniOrAllowLocal({}, "NFC-e");
} finally {
  dm.getDirectoryManager = prev;
}

console.log("fiscal-ini-policy.test.js OK");
