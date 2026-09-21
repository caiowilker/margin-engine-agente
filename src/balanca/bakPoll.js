"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Polling até arquivos listados virarem .BAK (MGV).
 * fs.watch não é confiável em UNC — usa setInterval.
 */
function aguardarBak(pasta, nomes, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 1000;
  const agora = () => Date.now();
  const t0 = agora();
  const pendentes = new Set(nomes.filter((n) => n && !/^ARQSOK/i.test(n)));
  // ARQSOK também vira BAK conforme doc
  for (const n of nomes) {
    if (n) pendentes.add(n);
  }

  return new Promise((resolve) => {
    const evidencias = [];

    function checar() {
      const still = [];
      for (const nome of pendentes) {
        const original = path.join(pasta, nome);
        const bak1 = path.join(pasta, `${nome}.BAK`);
        const bak2 = path.join(pasta, nome.replace(/\.TXT$/i, ".BAK"));
        const bak3 = path.join(pasta, `${nome}.bak`);
        if (
          !fs.existsSync(original) &&
          (fs.existsSync(bak1) || fs.existsSync(bak2) || fs.existsSync(bak3))
        ) {
          evidencias.push({
            nome,
            bak: fs.existsSync(bak1) ? bak1 : fs.existsSync(bak2) ? bak2 : bak3,
            emMs: agora() - t0,
          });
          pendentes.delete(nome);
        } else {
          still.push(nome);
        }
      }
      if (pendentes.size === 0) {
        clearInterval(timer);
        resolve({ ok: true, evidencias, elapsedMs: agora() - t0 });
        return;
      }
      if (agora() - t0 >= timeoutMs) {
        clearInterval(timer);
        resolve({
          ok: false,
          evidencias,
          pendentes: still,
          elapsedMs: agora() - t0,
          mensagem:
            "MGV não importou os arquivos a tempo (não viraram .BAK).",
          causaProvavel:
            "MGV7 parado, Macro MT1/sinalização ARQSOK desligada, pasta DFS atrasada ou encoding/layout rejeitado.",
        });
      }
    }

    const timer = setInterval(checar, intervalMs);
    checar();
  });
}

module.exports = { aguardarBak };
