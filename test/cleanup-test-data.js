#!/usr/bin/env node
/**
 * Rede de segurança — remove artefatos test/data-* antes/depois da suite.
 * Uso: node test/cleanup-test-data.js
 */
const { cleanProjectTestDataDirs } = require("./helpers/testEnv");

const n = cleanProjectTestDataDirs();
if (process.argv.includes("--verbose") || process.env.TEST_CLEANUP_VERBOSE === "1") {
  console.log(`[test-cleanup] ${n} diretório(s) removido(s)`);
}
