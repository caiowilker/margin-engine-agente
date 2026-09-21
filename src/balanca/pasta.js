"use strict";

const fs = require("fs");
const path = require("path");
const { NOMES_OCUPACAO, TMP_PREFIX } = require("./allowlist");
const log = require("../../logger").child({ modulo: "balanca_pasta" });

const RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin curto — só em retries raros */
  }
}

function comRetry(fn, tentativas = 4) {
  let last;
  for (let i = 0; i < tentativas; i++) {
    try {
      return fn();
    } catch (err) {
      last = err;
      if (!RETRY_CODES.has(err.code) || i === tentativas - 1) {
        throw enriquecerErroRede(err);
      }
      sleepSync(50 * (i + 1));
    }
  }
  throw last;
}

function enriquecerErroRede(err) {
  const msg = String(err && err.message ? err.message : err);
  const code = err && err.code;
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    /access is denied|permission denied|network path|não foi possível|unc/i.test(msg)
  ) {
    const e = new Error(
      `${msg}. Se o agente roda como serviço Windows, use uma conta de serviço que enxergue a pasta (UNC/rede). Código: ${code || "EACESSO"}`,
    );
    e.code = code || "BALANCA_ACESSO";
    e.causaProvavel =
      "Serviço sem permissão ou sem acesso à rede/UNC da pasta de carga.";
    return e;
  }
  if (code === "ENOENT") {
    const e = new Error(
      `Pasta de carga inexistente ou inacessível: ${msg}. Verifique o caminho em balanca-carga.json.`,
    );
    e.code = "BALANCA_PASTA_AUSENTE";
    e.causaProvavel = "Caminho incorreto ou share offline.";
    return e;
  }
  if (code === "ENOSPC") {
    const e = new Error("Disco cheio na pasta de carga da balança.");
    e.code = "BALANCA_DISCO_CHEIO";
    e.causaProvavel = "Sem espaço livre no volume da pasta MGV.";
    return e;
  }
  return err;
}

function listarPresentes(pasta) {
  const presentes = [];
  for (const nome of NOMES_OCUPACAO) {
    const p = path.join(pasta, nome);
    try {
      if (fs.existsSync(p)) presentes.push(nome);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(presentes)];
}

/**
 * @returns {{ ok: boolean, ocupada?: boolean, presentes?: string[], erro?: string, codigo?: string, espacoLivreBytes?: number|null }}
 */
function diagnosticarPasta(pastaCarga) {
  const pasta = String(pastaCarga || "").trim();
  if (!pasta) {
    return { ok: false, erro: "pastaCarga vazia", codigo: "BALANCA_PASTA_VAZIA" };
  }
  try {
    if (!fs.existsSync(pasta)) {
      return {
        ok: false,
        erro: `Pasta não existe: ${pasta}`,
        codigo: "BALANCA_PASTA_AUSENTE",
        causaProvavel: "Caminho incorreto ou share offline.",
      };
    }
    const st = fs.statSync(pasta);
    if (!st.isDirectory()) {
      return { ok: false, erro: "Caminho não é diretório", codigo: "BALANCA_NAO_DIR" };
    }

    // Escrita real: ping + remoção
    const ping = path.join(pasta, `${TMP_PREFIX}ping-${process.pid}.tmp`);
    comRetry(() => {
      fs.writeFileSync(ping, Buffer.from("ping"), { flag: "w" });
      const fd = fs.openSync(ping, "r+");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.unlinkSync(ping);
    });

    let espacoLivreBytes = null;
    try {
      if (typeof fs.statfsSync === "function") {
        const sfs = fs.statfsSync(pasta);
        espacoLivreBytes = Number(sfs.bavail) * Number(sfs.bsize);
      }
    } catch {
      espacoLivreBytes = null;
    }

    const presentes = listarPresentes(pasta);
    if (presentes.length > 0) {
      return {
        ok: false,
        ocupada: true,
        presentes,
        espacoLivreBytes,
        erro: `Pasta ocupada: ${presentes.join(", ")}. Aguarde o MGV importar (.BAK) ou remova arquivos órfãos com cuidado.`,
        codigo: "PASTA_OCUPADA",
        causaProvavel: "Importação anterior ainda não concluída ou ARQSOK/ITENSMGV residual.",
      };
    }

    return { ok: true, ocupada: false, presentes: [], espacoLivreBytes };
  } catch (err) {
    const e = enriquecerErroRede(err);
    return {
      ok: false,
      erro: e.message,
      codigo: e.code || "BALANCA_ERRO_PASTA",
      causaProvavel: e.causaProvavel,
    };
  }
}

function limparTemporariosOrfaos(pasta) {
  if (!pasta || !fs.existsSync(pasta)) return 0;
  let n = 0;
  let names;
  try {
    names = fs.readdirSync(pasta);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX) && !name.startsWith(".me-balanca-")) continue;
    try {
      fs.unlinkSync(path.join(pasta, name));
      n += 1;
    } catch (err) {
      log.debug({ name, err: err.message }, "Não removeu tmp órfão");
    }
  }
  return n;
}

module.exports = {
  diagnosticarPasta,
  listarPresentes,
  limparTemporariosOrfaos,
  comRetry,
  enriquecerErroRede,
  RETRY_CODES,
};
