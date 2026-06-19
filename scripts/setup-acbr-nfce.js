#!/usr/bin/env node
/** Diagnóstico NFC-e — rode: node scripts/setup-acbr-nfce.js */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const acbrNfceSetup = require("../acbrNfceSetup");

(async () => {
  console.log("EMISSAO_FISCAL:", process.env.EMISSAO_FISCAL);
  console.log("NFE_UF:", process.env.NFE_UF || "MG");
  console.log("AMBIENTE_SEFAZ:", process.env.AMBIENTE_SEFAZ || "homologacao");
  console.log("Diagnóstico somente leitura — agente não altera ACBrNFeServicos.ini");
  try {
    const r = await acbrNfceSetup.validarAsync();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.pronto ? 0 : 1);
  } catch (e) {
    console.error("FALHA:", e.message);
    console.error("\nStatus:", JSON.stringify(acbrNfceSetup.status(), null, 2));
    process.exit(1);
  }
})();
