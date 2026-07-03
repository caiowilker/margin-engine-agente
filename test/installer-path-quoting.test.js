/**
 * Testes de escaping/quoting de paths em comandos de shell.
 *
 * Regressão: quando o Inno Setup invoca o bootstrap sem aspas no --npm=:
 *
 *   node scripts/installer-bootstrap.js "C:\Program Files\ME" \
 *        --npm=C:\Program Files\nodejs\npm.cmd --service
 *
 * O shell divide o argumento em dois entries no process.argv:
 *   "--npm=C:\Program"    (1º entry)
 *   "Files\nodejs\npm.cmd" (2º entry)
 *
 * O código extraía apenas "C:\Program" como npm, construindo o comando:
 *   "C:\Program" ci --omit=dev   →   falha: command not found
 *
 * A correção usa resolveNpmFromArgs para reconstruir o path completo, e
 * execFileSync para invocar o npm sem passar por shell, eliminando o problema
 * de quoting do lado da construção de comandos.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { quoteShellArg, resolveNpmFromArgs } = require("../runtime/shellUtils");

// ---------------------------------------------------------------------------
// quoteShellArg
// ---------------------------------------------------------------------------

describe("quoteShellArg — envolvimento com aspas duplas (cmd.exe)", () => {
  it("path simples sem espaço", () => {
    assert.equal(quoteShellArg("npm"), '"npm"');
  });

  it("path com espaço é envolvido em aspas duplas", () => {
    assert.equal(
      quoteShellArg("C:\\Program Files\\nodejs\\npm.cmd"),
      '"C:\\Program Files\\nodejs\\npm.cmd"',
    );
  });

  it("aspas internas duplicadas — convenção cmd.exe", () => {
    assert.equal(quoteShellArg('say "hello"'), '"say ""hello"""');
  });

  it("arg vazio vira par de aspas", () => {
    assert.equal(quoteShellArg(""), '""');
  });

  it("path com múltiplos espaços", () => {
    assert.equal(
      quoteShellArg("C:\\My Custom Path\\npm.cmd"),
      '"C:\\My Custom Path\\npm.cmd"',
    );
  });
});

// ---------------------------------------------------------------------------
// resolveNpmFromArgs
// ---------------------------------------------------------------------------

describe("resolveNpmFromArgs — reconstrução de path com espaço dividido pelo shell", () => {
  /**
   * Simula existência de arquivos sem acessar o disco real.
   * @param {...string} knownPaths
   */
  function makeExists(...knownPaths) {
    return (p) => knownPaths.includes(p);
  }

  it("path sem espaço extraído diretamente do --npm=", () => {
    const exists = makeExists("C:\\nodejs\\npm.cmd");
    const result = resolveNpmFromArgs(
      ["--mode=install", "--npm=C:\\nodejs\\npm.cmd"],
      exists,
    );
    assert.equal(result, "C:\\nodejs\\npm.cmd");
  });

  it("path com espaço dividido em dois argv entries é reconstruído", () => {
    // Simula Inno Setup sem aspas: --npm=C:\Program + Files\nodejs\npm.cmd
    const exists = makeExists("C:\\Program Files\\nodejs\\npm.cmd");
    const result = resolveNpmFromArgs(
      ["--mode=install", "--npm=C:\\Program", "Files\\nodejs\\npm.cmd", "--service"],
      exists,
    );
    assert.equal(result, "C:\\Program Files\\nodejs\\npm.cmd");
  });

  it("para na reconstrução quando encontra outro flag (--) e não o inclui no path", () => {
    const exists = makeExists("C:\\Program Files\\nodejs\\npm.cmd");
    const result = resolveNpmFromArgs(
      ["--npm=C:\\Program", "Files\\nodejs\\npm.cmd", "--service", "--firewall"],
      exists,
    );
    assert.equal(result, "C:\\Program Files\\nodejs\\npm.cmd");
    assert.ok(!result.includes("--service"), "não deve incluir '--service' no path");
    assert.ok(!result.includes("--firewall"), "não deve incluir '--firewall' no path");
  });

  it("retorna null quando --npm= não está presente", () => {
    const result = resolveNpmFromArgs(["--mode=install", "--service"]);
    assert.equal(result, null);
  });

  it("retorna null em lista vazia", () => {
    assert.equal(resolveNpmFromArgs([]), null);
  });

  it("retorna a reconstrução completa quando nenhum prefixo existe no disco (erro explícito depois)", () => {
    const exists = makeExists(); // nada existe
    const result = resolveNpmFromArgs(
      ["--npm=C:\\Custom", "Tools\\npm.cmd"],
      exists,
    );
    assert.equal(result, "C:\\Custom Tools\\npm.cmd");
  });

  it("path já intacto (Inno quotou corretamente) chega como único argv e é retornado direto", () => {
    // cmd.exe preserva o espaço quando o arg é quotado pelo chamador
    const exists = makeExists("C:\\Program Files\\nodejs\\npm.cmd");
    const result = resolveNpmFromArgs(
      ["--npm=C:\\Program Files\\nodejs\\npm.cmd"],
      exists,
    );
    assert.equal(result, "C:\\Program Files\\nodejs\\npm.cmd");
  });

  it("path com espaço em três partes (espaços múltiplos no path)", () => {
    const exists = makeExists("C:\\My Custom Node Path\\npm.cmd");
    const result = resolveNpmFromArgs(
      ["--npm=C:\\My", "Custom", "Node Path\\npm.cmd", "--mode=update"],
      exists,
    );
    assert.equal(result, "C:\\My Custom Node Path\\npm.cmd");
  });

  it("não coleta args após --npm= que comecem com -- (mesmo sem existir no disco)", () => {
    // O arg "--service" deve ser tratado como flag, não como parte do path
    const exists = makeExists(); // nada existe
    const result = resolveNpmFromArgs(["--npm=npm", "--service"], exists);
    assert.equal(result, "npm");
    assert.ok(!result.includes("service"));
  });
});
