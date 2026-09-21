/**
 * Cliente HTTP do Web Service MGV7 (chamado só pelo agente, na LAN da loja).
 * Trata erro no CORPO (ERetornoImp), não só HTTP.
 */
"use strict";

const log = require("../../logger").child({ modulo: "balanca_ws_client" });

const ERROS_COMUNS = {
  "-1": "Não havia uma importação iniciada para o numeroDaImportacao informado.",
  "-2": "Não havia dados para realizar a importação.",
  "-3": "Um erro não esperado impossibilitou a realização desta importação.",
  "-4": "Você não está autorizado a fazer comunicação.",
  "-5": "Loja não existe.",
};

/**
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
function criarClienteWs(opts) {
  const baseUrl = String(opts.baseUrl || "").replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl || global.fetch || require("node-fetch");
  const timeoutMs = opts.timeoutMs || 30_000;
  let token = null;

  async function request(method, path, body, headers = {}) {
    if (!baseUrl) {
      const err = new Error("wsBaseUrl não configurada no agente.");
      err.code = "BALANCA_WS_URL";
      throw err;
    }
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      const resp = await fetchImpl(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body == null ? undefined : JSON.stringify(body),
        ...(ctrl ? { signal: ctrl.signal } : {}),
        timeout: timeoutMs,
      });
      const text = await resp.text().catch(() => "");
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
      }
      if (!resp.ok) {
        const err = new Error(
          `WS MGV7 HTTP ${resp.status}: ${typeof json === "string" ? json.slice(0, 200) : JSON.stringify(json).slice(0, 200)}`,
        );
        err.code = "BALANCA_WS_HTTP";
        err.status = resp.status;
        err.body = json;
        if (resp.status === 503 || /conting[eê]ncia/i.test(text)) {
          err.code = "BALANCA_WS_CONTINGENCIA";
          err.message =
            "Serviços WS indisponíveis no servidor de Contingência do MGV7 (doc Toledo).";
        }
        throw err;
      }
      return json;
    } catch (e) {
      if (e.name === "AbortError" || e.type === "request-timeout") {
        const err = new Error("Timeout ao chamar o Web Service MGV7.");
        err.code = "BALANCA_WS_TIMEOUT";
        throw err;
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function interpretarListaRetorno(lista) {
    if (lista == null) return { ok: true, falhas: [] };
    if (!Array.isArray(lista)) {
      return interpretarUm(lista);
    }
    if (lista.length === 0) return { ok: true, falhas: [] };
    const falhas = lista.filter(
      (x) => x && (x.Importado === false || x.importado === false),
    );
    const alertas = lista.filter(
      (x) => x && (x.Importado === true || x.importado === true) && (x.Msg || x.msg),
    );
    return {
      ok: falhas.length === 0,
      falhas: falhas.map(normalizarRetorno),
      alertas: alertas.map(normalizarRetorno),
      todos: lista.map(normalizarRetorno),
    };
  }

  function interpretarUm(obj) {
    if (obj == null) return { ok: true, falhas: [] };
    const n = normalizarRetorno(obj);
    const codigo = String(n.Codigo || "");
    if (ERROS_COMUNS[codigo] || (codigo.startsWith("-") && codigo !== "")) {
      return {
        ok: false,
        falhas: [n],
        mensagem: ERROS_COMUNS[codigo] || n.Msg,
      };
    }
    if (n.Importado === false) {
      return { ok: false, falhas: [n], mensagem: n.Msg };
    }
    return { ok: true, falhas: [], valor: n };
  }

  function normalizarRetorno(x) {
    if (!x || typeof x !== "object") return { Codigo: "", Msg: String(x), Importado: false };
    return {
      Codigo: x.Codigo != null ? String(x.Codigo) : x.codigo != null ? String(x.codigo) : "",
      Msg: x.Msg || x.msg || "",
      Importado: x.Importado != null ? !!x.Importado : x.importado != null ? !!x.importado : undefined,
      CodigoDaLoja: x.CodigoDaLoja ?? x.codigoDaLoja,
    };
  }

  return {
    setToken(t) {
      token = t || null;
    },
    getToken() {
      return token;
    },
    async getToken(usuario, senha) {
      const r = await request("POST", "/GetToken", { usuario, senha });
      const sucesso = r && (r.Sucesso === true || r.sucesso === true);
      const tok = r && (r.Token || r.token);
      if (!sucesso || !tok) {
        const err = new Error("Token inválido ou autenticação WS rejeitada.");
        err.code = "BALANCA_WS_TOKEN";
        err.body = r;
        throw err;
      }
      token = tok;
      return { token: tok, expireAt: r.ExpireAt || r.expireAt || null };
    },
    async iniciaImportacao({ loja, palavraChave, quantidadeDeArquivos, tipoDeImportacao }) {
      const r = await request("POST", "/IniciaImportacao", {
        loja,
        palavraChave,
        quantidadeDeArquivos: quantidadeDeArquivos ?? 1,
        tipoDeImportacao: tipoDeImportacao ?? 1,
      });
      const n = normalizarRetorno(r);
      const codigo = String(n.Codigo || "");
      if (!codigo || /^-/.test(codigo)) {
        const err = new Error(
          n.Msg ||
            ERROS_COMUNS[codigo] ||
            "IniciaImportacao não retornou numeroDaImportacao.",
        );
        err.code = "BALANCA_WS_INICIA";
        err.body = r;
        throw err;
      }
      return { numeroDaImportacao: Number(codigo) || codigo, raw: n };
    },
    async importaItem(numeroDaImportacao, itens) {
      const r = await request("POST", "/ImportaItem", {
        numeroDaImportacao,
        itens,
      });
      return interpretarListaRetorno(r);
    },
    async importaPreco(numeroDaImportacao, lista) {
      const r = await request("POST", "/ImportaPreco", {
        numeroDaImportacao,
        lista,
      });
      return interpretarListaRetorno(r);
    },
    async solicitaCargaNaBalanca(numeroDaImportacao, solicitacaoCarga) {
      const r = await request("POST", "/SolicitaCargaNaBalanca", {
        numeroDaImportacao,
        solicitacaoCarga,
      });
      return interpretarUm(r);
    },
    async finalizaImportacao(numeroDaImportacao) {
      const r = await request("POST", "/FinalizaImportacao", { numeroDaImportacao });
      return interpretarUm(r);
    },
    async cancelaImportacao(numeroDaImportacao) {
      try {
        const r = await request("POST", "/CancelaImportacao", { numeroDaImportacao });
        return interpretarUm(r);
      } catch (e) {
        log.warn({ err: e.message }, "CancelaImportacao falhou (não desfaz o já importado)");
        return { ok: false, falhas: [], mensagem: e.message };
      }
    },
    async obtemVersao() {
      return request("GET", "/ObtemVersao");
    },
    async exportaComunicacoesPendentes(palavraChave, loja) {
      return request(
        "GET",
        `/ExportaComunicacoesPendentes?palavraChave=${encodeURIComponent(palavraChave)}&loja=${encodeURIComponent(loja)}`,
      );
    },
    async exportaStatusServicos(palavraChave, loja) {
      return request(
        "GET",
        `/ExportaStatusServicos?palavraChave=${encodeURIComponent(palavraChave)}&loja=${encodeURIComponent(loja)}`,
      );
    },
    async exportaDetalhesBalancas(palavraChave, loja) {
      return request(
        "GET",
        `/ExportaDetalhesBalancas?palavraChave=${encodeURIComponent(palavraChave)}&loja=${encodeURIComponent(loja)}`,
      );
    },
    interpretarListaRetorno,
    interpretarUm,
    ERROS_COMUNS,
  };
}

module.exports = { criarClienteWs, ERROS_COMUNS };
