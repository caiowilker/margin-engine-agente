#!/usr/bin/env node
const assert = require("assert");
const { API_CONTRACT_VERSION } = require("../apiContract");

assert.strictEqual(typeof API_CONTRACT_VERSION, "number");
assert.ok(API_CONTRACT_VERSION >= 1, "apiContractVersion deve ser positivo");

const payload = {
  ok: true,
  versao: "1.0.0",
  frontVersion: null,
  apiContractVersion: API_CONTRACT_VERSION,
  uptime: 1,
  manifestOk: true,
  fiscal: {},
  timestamp: new Date().toISOString(),
};

assert.strictEqual(payload.apiContractVersion, API_CONTRACT_VERSION);
assert.notStrictEqual(payload.apiContractVersion, payload.versao, "contrato ≠ versão do pacote");

console.log("api-contract.test.js OK");
