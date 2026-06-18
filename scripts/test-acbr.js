#!/usr/bin/env node
// Teste rápido ACBr — rode na pasta do agente: node scripts/test-acbr.js
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const acbr = require("../acbr");

(async () => {
  console.log("EMISSAO_FISCAL:", acbr.EMISSAO_FISCAL);
  console.log("ACBR_HOST:", process.env.ACBR_HOST || "127.0.0.1");
  console.log("ACBR_PORT:", process.env.ACBR_PORT || "9200");
  try {
    const ok = await acbr.testar();
    console.log("testar():", ok);
    const sefaz = await acbr.statusServico();
    console.log("statusServico:", JSON.stringify(sefaz, null, 2));
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error("ERRO:", e.message);
    process.exit(1);
  }
})();
