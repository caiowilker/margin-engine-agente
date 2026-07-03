/**
 * Utilitários para construção segura de comandos de shell no Windows.
 *
 * Problema histórico: paths com espaços em cmd.exe precisam de aspas duplas.
 * Quando o Inno Setup passa --npm=C:\Program Files\nodejs\npm.cmd sem aspas
 * ao bootstrap, o shell divide o argumento em espaços — process.argv recebe
 * "--npm=C:\Program" e "Files\nodejs\npm.cmd" como entradas separadas.
 * O bootstrap então construía "C:\Program" ci --omit=dev → falha imediata.
 */
"use strict";

/**
 * Envolve um argumento em aspas duplas para uso seguro em exec/execSync (cmd.exe).
 * Aspas internas são duplicadas conforme a convenção cmd.exe ("" em vez de \").
 *
 * @param {string} arg
 * @returns {string}
 */
function quoteShellArg(arg) {
  return '"' + String(arg).replace(/"/g, '""') + '"';
}

/**
 * Reconstrói o path do npm passado via --npm=, suportando caminhos com espaços
 * que o shell pode ter dividido em múltiplos argv entries.
 *
 * Exemplo de divisão pelo shell (Inno Setup sem aspas):
 *   "--npm=C:\Program"  +  "Files\nodejs\npm.cmd"
 *   → reconstruído como  "C:\Program Files\nodejs\npm.cmd"
 *
 * Estratégia: tenta prefixos crescentes até encontrar um arquivo que existe.
 * Para em outro flag (--xxx) para não consumir args não relacionados.
 * Retorna a reconstrução completa quando nenhum prefixo existe (para erro explícito depois).
 *
 * @param {string[]} argList  - lista de argumentos (ex: process.argv.slice(3))
 * @param {(p: string) => boolean} [existsFn] - verificador injetável para testes
 * @returns {string|null}
 */
function resolveNpmFromArgs(argList, existsFn) {
  const checkExists = existsFn || defaultExists;
  const idx = argList.findIndex((a) => a.startsWith("--npm="));
  if (idx === -1) return null;

  const parts = [argList[idx].slice("--npm=".length)];
  for (let i = idx + 1; i < argList.length && !argList[i].startsWith("--"); i++) {
    parts.push(argList[i]);
  }

  for (let len = 1; len <= parts.length; len++) {
    const candidate = parts.slice(0, len).join(" ");
    if (checkExists(candidate)) return candidate;
  }

  return parts.join(" ");
}

function defaultExists(p) {
  try {
    return require("fs").existsSync(p);
  } catch {
    return false;
  }
}

module.exports = { quoteShellArg, resolveNpmFromArgs };
