/**
 * Fluxo WS MGV7: GetToken → Inicia → ImportaItem/Preco → SolicitaCarga → Finaliza.
 * CancelaImportacao em falha. Serial via wsQueue.
 */
"use strict";

const { criarClienteWs } = require("./wsClient");
const { enfileirarSerial } = require("./wsQueue");
const balancaSecrets = require("./balancaSecrets");
const log = require("../../logger").child({ modulo: "balanca_ws_runner" });

/**
 * @param {object} lote — claim do backend (modoEntrega, ws, ...)
 * @param {object} cfg — balanca-carga.json
 * @param {{ fetchImpl?: Function }} [deps]
 */
async function processarLoteWs(lote, cfg, deps = {}) {
  const baseUrl = String(cfg.wsBaseUrl || "").trim();
  if (!baseUrl) {
    return {
      status: "ERRO",
      detalhe:
        "modoEntrega=WS_MGV7 exige wsBaseUrl no balanca-carga.json (URL do MGV na rede da loja).",
      evidenciasBak: [],
    };
  }

  const secrets = balancaSecrets.lerSync();
  const loja = Number(cfg.wsLojaCodigo || lote.ws?.lojaCodigo || 1);
  const ws = lote.ws || {};
  const itens = Array.isArray(ws.itens) ? ws.itens : [];
  const precos = Array.isArray(ws.precos) ? ws.precos : [];

  if (cfg.modoSombra) {
    log.info(
      { loteId: lote.loteId, itens: itens.length, precos: precos.length },
      "WS SOMBRA — não chama MGV",
    );
    return {
      status: "ENTREGUE",
      detalhe: `SOMBRA WS: enviaria ${itens.length} itens e ${precos.length} preços para ${baseUrl}`,
      evidenciasBak: [],
    };
  }

  return enfileirarSerial(baseUrl, async () => {
    const client = criarClienteWs({
      baseUrl,
      fetchImpl: deps.fetchImpl,
      timeoutMs: (lote.timeoutImportacaoSeg || cfg.timeoutImportacaoSeg || 120) * 1000,
    });
    let numero = null;
    try {
      if (secrets.usuario && secrets.senha) {
        await client.getToken(secrets.usuario, secrets.senha);
      } else if (!secrets.palavraChave) {
        return {
          status: "ERRO",
          detalhe:
            "Credenciais WS ausentes no cofre do agente (.balanca-vault). Configure usuario/senha e/ou palavraChave.",
          evidenciasBak: [],
        };
      }

      const qtd =
        (itens.length > 0 ? 1 : 0) + (precos.length > 0 ? 1 : 0) || 1;
      const ini = await client.iniciaImportacao({
        loja,
        palavraChave: secrets.palavraChave || "",
        quantidadeDeArquivos: qtd,
        tipoDeImportacao: Number(cfg.wsTipoImportacao || 1),
      });
      numero = ini.numeroDaImportacao;

      const falhasItem = [];
      if (itens.length > 0) {
        const r = await client.importaItem(numero, itens);
        if (!r.ok) falhasItem.push(...(r.falhas || []));
      }
      if (precos.length > 0) {
        const r = await client.importaPreco(numero, precos);
        if (!r.ok) falhasItem.push(...(r.falhas || []));
      }

      const solicita = await client.solicitaCargaNaBalanca(numero, {
        Balancas: cfg.wsBalancas || undefined,
        OpcoesDeComunicacao: [
          {
            OpcoesComunicacaoInt: Number(cfg.wsOpcaoComunicacao ?? 2),
            Simultaneidade: false,
            TipoDeDadoInt: 3,
          },
        ],
      });
      if (!solicita.ok) {
        await client.cancelaImportacao(numero);
        return {
          status: "ERRO",
          detalhe: `SolicitaCargaNaBalanca falhou: ${solicita.mensagem || JSON.stringify(solicita.falhas)}`,
          evidenciasBak: [],
          itensComFalha: falhasItem,
        };
      }

      const fin = await client.finalizaImportacao(numero);
      if (!fin.ok) {
        return {
          status: "ERRO",
          detalhe: `FinalizaImportacao falhou: ${fin.mensagem || ""}`,
          evidenciasBak: [],
          itensComFalha: falhasItem,
        };
      }

      if (falhasItem.length > 0) {
        return {
          status: "IMPORTADO",
          detalhe: `Importação WS parcial: ${falhasItem.length} item(ns) com falha no corpo ERetornoImp.`,
          evidenciasBak: [`ws:${numero}`],
          itensComFalha: falhasItem,
        };
      }

      return {
        status: "IMPORTADO",
        detalhe: `Importação WS MGV7 confirmada (numeroDaImportacao=${numero}).`,
        evidenciasBak: [`ws:${numero}`],
      };
    } catch (err) {
      if (numero != null) {
        await client.cancelaImportacao(numero).catch(() => {});
      }
      const code = err.code || "BALANCA_WS";
      return {
        status: code === "BALANCA_WS_TIMEOUT" ? "TIMEOUT_IMPORTACAO" : "ERRO",
        detalhe: `${err.message} Causa provável: ${mensagemCausa(code)}`,
        evidenciasBak: [],
      };
    }
  });
}

function mensagemCausa(code) {
  switch (code) {
    case "BALANCA_WS_TOKEN":
      return "Usuário/senha inválidos ou sem permissão no WS.";
    case "BALANCA_WS_TIMEOUT":
      return "MGV7 não respondeu a tempo na rede local.";
    case "BALANCA_WS_CONTINGENCIA":
      return "WS não disponível em contingência (doc Toledo).";
    case "BALANCA_WS_HTTP":
      return "Falha HTTP ao falar com o MGV7.";
    default:
      return "Verifique URL do WS, palavra-chave e se o serviço Carga Remota está ativo.";
  }
}

async function diagnosticoWs(cfg, deps = {}) {
  const baseUrl = String(cfg.wsBaseUrl || "").trim();
  const secrets = balancaSecrets.lerSync();
  const out = {
    configurado: !!baseUrl,
    baseUrl: baseUrl || null,
    secrets: balancaSecrets.resumoSeguro(),
    versao: null,
    comunicacoesPendentes: null,
    statusServicos: null,
    detalhesBalancas: null,
    erro: null,
  };
  if (!baseUrl) {
    out.erro = "wsBaseUrl vazia";
    return out;
  }
  try {
    const client = criarClienteWs({
      baseUrl,
      fetchImpl: deps.fetchImpl,
      timeoutMs: 10_000,
    });
    if (secrets.usuario && secrets.senha) {
      await client.getToken(secrets.usuario, secrets.senha);
    }
    out.versao = await client.obtemVersao();
    const loja = Number(cfg.wsLojaCodigo || 1);
    const pk = secrets.palavraChave || "";
    if (pk) {
      out.comunicacoesPendentes = await client.exportaComunicacoesPendentes(pk, loja);
      out.statusServicos = await client.exportaStatusServicos(pk, loja);
      out.detalhesBalancas = await client.exportaDetalhesBalancas(pk, loja);
    }
  } catch (e) {
    out.erro = e.message;
  }
  return out;
}

module.exports = { processarLoteWs, diagnosticoWs, mensagemCausa };
