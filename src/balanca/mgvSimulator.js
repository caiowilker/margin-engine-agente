"use strict";

/**
 * Simulador de MGV7 para testes: renomeia arquivos de carga para .BAK após atraso.
 */
const fs = require("fs");
const path = require("path");

const ALVOS = [
  "ITENSMGV.TXT",
  "PRECOMGV.TXT",
  "EXCLITEM.TXT",
  "ARQSOK.TXT",
  "Itensmgv.txt",
  "Precomgv.txt",
  "Exclitem.txt",
  "Arqsok.txt",
];

/**
 * @param {string} pasta
 * @param {{ delayMs?: number, modo?: 'ok'|'nunca'|'parcial'|'trava', parcial?: string[] }} opts
 */
function iniciarSimuladorMgv(pasta, opts = {}) {
  const delayMs = opts.delayMs ?? 200;
  const modo = opts.modo || "ok";
  let timer = null;
  let stopped = false;

  function tick() {
    if (stopped) return;
    if (modo === "nunca") return;

    const presentes = ALVOS.filter((n) => fs.existsSync(path.join(pasta, n)));
    if (presentes.length === 0) {
      timer = setTimeout(tick, 50);
      return;
    }

    timer = setTimeout(() => {
      if (stopped) return;
      if (modo === "trava") {
        // Mantém arquivo aberto (não renomeia)
        return;
      }
      const renomear = modo === "parcial"
        ? presentes.filter((n) => (opts.parcial || ["ARQSOK.TXT"]).includes(n))
        : presentes;
      for (const nome of renomear) {
        const src = path.join(pasta, nome);
        const dest = path.join(pasta, `${nome}.BAK`);
        try {
          if (fs.existsSync(src)) fs.renameSync(src, dest);
        } catch {
          /* busy */
        }
      }
    }, delayMs);
  }

  tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { iniciarSimuladorMgv, ALVOS };
