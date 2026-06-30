#!/usr/bin/env node
const assert = require("assert");

delete process.env.FISCAL_ALLOW_LOCAL_INI;
delete process.env.HOMOLOG_ACBRLIB;

const policy = require("../fiscal/fiscalIniPolicy");

assert.throws(
  () => policy.requireDocumentIniOrAllowLocal({}, "NFC-e"),
  /documentIni obrigatório/,
);

process.env.FISCAL_ALLOW_LOCAL_INI = "true";
policy.requireDocumentIniOrAllowLocal({}, "NFC-e");

policy.requireDocumentIniOrAllowLocal({ documentIni: "[NFe]\nnNF=1" }, "NFC-e");

console.log("fiscal-ini-policy.test.js OK");
