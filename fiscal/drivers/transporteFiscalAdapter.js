"use strict";

const crypto = require("crypto");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const fiscalNumeracao = require("../../fiscalNumeracao");
const fiscalEmissionLock = require("../fiscalEmissionLock");
const { PATHS } = require("../../marginPaths");
const { verificarCapacidadeTransporte } = require("../transporteCapability");
const { createTransportNativeBinding } = require("./transporteNativeBinding");
const { persistirArtefatosTransporte } = require("../transportePersistence");

const ISSUE_STATUS = new Set(["100", "150"]);
const EVENT_STATUS = new Set(["132", "135", "136", "155"]);
const registeredQueues = new WeakSet();

function modelo(documento) {
  return documento === "cte" ? "57" : "58";
}

function transporteHabilitado(documento) {
  const key = documento === "cte" ? "TRANSPORT_CTE_ENABLED" : "TRANSPORT_MDFE_ENABLED";
  return String(process.env[key] || "false").toLowerCase() === "true";
}

function tipoFila(documento, operacao) {
  return `TRANSPORTE_${documento.toUpperCase()}_${operacao}`;
}

function normalizeResponse(response) {
  if (response && typeof response === "object") return response;
  const raw = String(response || "");
  const pick = (key) => raw.match(new RegExp(`(?:^|\\n)${key}\\s*[=:]\\s*([^\\r\\n]+)`, "i"))?.[1]?.trim();
  return {
    raw,
    cStat: pick("cStat"),
    chave: pick("chCTe") || pick("chMDFe") || pick("chave"),
    protocolo: pick("nProt") || pick("protocolo"),
    xml: raw.includes("<") ? raw : null,
  };
}

function assertOperationPayload(command) {
  const payload = command.payload || {};
  if (["EMITIR_CTE", "EMITIR_MDFE"].includes(command.operacao) && !String(payload.documentIni || "").trim()) {
    const error = new Error("documentIni é obrigatório para emissão de transporte.");
    error.permanente = true;
    throw error;
  }
  if (!payload.numeroDocumento && !payload.numeroVenda && !payload.chave) {
    const error = new Error("numeroDocumento, numeroVenda ou chave é obrigatório.");
    error.permanente = true;
    throw error;
  }
}

function executarNativo(binding, command) {
  const prefix = command.documento === "cte" ? "ACBrCTe" : "ACBrMDFe";
  const payload = command.payload;
  const cryptKey = process.env[command.documento === "cte" ? "ACBR_CTE_CRYPT_KEY" : "ACBR_MDFE_CRYPT_KEY"] || "";
  binding[`${prefix}_Inicializar`](command.capacidade.paths.config, cryptKey);
  try {
    if (command.operacao === "EMITIR_CTE" || command.operacao === "EMITIR_MDFE") {
      const iniPath = payload.documentIniPath || persistirIniTemporario(command, payload.documentIni);
      binding[`${prefix}_CarregarINI`](iniPath);
      binding[`${prefix}_Assinar`]();
      binding[`${prefix}_Validar`]();
      const result = normalizeResponse(binding[`${prefix}_Enviar`](1, false, true));
      if (!result.xml) result.xml = binding[`${prefix}_ObterXml`](0);
      try {
        binding[`${prefix}_ImprimirPDF`]();
        result.pdfPath = localizarPdfNativo(command.capacidade.paths.config, result.chave);
      } catch {
        // A autorização e o XML não são invalidados pela falha do PDF; o job
        // mantém a ausência do PDF explícita para recuperação operacional.
      }
      return result;
    }
    if (command.operacao === "CANCELAR_CTE") {
      return normalizeResponse(
        binding.ACBrCTe_Cancelar(payload.chave, payload.justificativa || payload.motivo, payload.cnpj || "", 1),
      );
    }
    if (command.operacao === "ENCERRAR_MDFE") {
      return normalizeResponse(
        binding.ACBrMDFe_Encerrar(
          payload.chave,
          payload.dataHoraEncerramento,
          payload.codigoMunicipioEncerramento,
          payload.cnpj || "",
          payload.protocolo || "",
        ),
      );
    }
    if (command.operacao === "INCLUIR_CONDUTOR_MDFE") {
      const error = new Error(
        "A ACBrLib não documenta export para incluir condutor após autorização; informe o condutor no documentIni antes da emissão.",
      );
      error.permanente = true;
      throw error;
    }
    throw new Error(`Operação de transporte não suportada: ${command.operacao}`);
  } finally {
    try {
      binding[`${prefix}_Finalizar`]();
    } catch {
      // A operação original é a fonte do erro; finalizar não pode mascará-la.
    }
  }
}

function persistirIniTemporario(command, documentIni) {
  fs.mkdirSync(PATHS.ini, { recursive: true });
  const file = `${command.documento}-${command.correlationId}-${Date.now()}.ini`
    .replace(/[^a-zA-Z0-9_.-]/g, "_");
  const iniPath = path.join(PATHS.ini, file);
  fs.writeFileSync(iniPath, String(documentIni), "utf8");
  return iniPath;
}

function localizarPdfNativo(configPath, chave) {
  if (!configPath || !fs.existsSync(configPath)) return null;
  const contents = fs.readFileSync(configPath, "utf8");
  const configured = contents.match(/^PathPDF\s*=\s*(.+)$/im)?.[1]?.trim();
  if (!configured || !fs.existsSync(configured)) return null;
  const candidates = fs
    .readdirSync(configured)
    .filter((name) => name.toLowerCase().endsWith(".pdf") && (!chave || name.includes(String(chave))))
    .map((name) => ({ path: path.join(configured, name), modified: fs.statSync(path.join(configured, name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  return candidates[0]?.path || null;
}

async function enviarCallbackTransporte(cfg, payload) {
  if (!cfg?.backendUrl) return { skipped: true };
  const endpoint = process.env.TRANSPORT_CALLBACK_PATH || "/pdv/transporte/fiscal";
  const response = await fetch(`${cfg.backendUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.backendToken || ""}`,
      "X-Correlation-Id": payload.correlationId,
    },
    body: JSON.stringify(payload),
    timeout: Number(process.env.BACKEND_TIMEOUT_MS || 5000),
  });
  if (!response.ok) throw new Error(`Callback transporte retornou HTTP ${response.status}`);
  return { ok: true };
}

function registerQueueHandlers(contexto, getBinding) {
  if (registeredQueues.has(contexto.filaFiscal)) return;
  registeredQueues.add(contexto.filaFiscal);
  for (const document of ["cte", "mdfe"]) {
    for (const operation of document === "cte"
      ? ["EMITIR_CTE", "CANCELAR_CTE"]
      : ["EMITIR_MDFE", "ENCERRAR_MDFE", "INCLUIR_CONDUTOR_MDFE"]) {
      contexto.filaFiscal.registrarHandler(tipoFila(document, operation), async (payload) => {
        const command = { ...payload, documento: document, operacao: operation };
        const result = await fiscalEmissionLock.withEmissionLock(
          () => executarNativo(getBinding(command), command),
          `transport-${document}-${operation}`,
        );
        const authorized = operation.startsWith("EMITIR") ? ISSUE_STATUS.has(String(result.cStat)) : EVENT_STATUS.has(String(result.cStat));
        if (!authorized) {
          const error = new Error(`ACBrLib ${document} recusou ${operation} (cStat ${result.cStat || "ausente"}).`);
          error.cStat = result.cStat;
          throw error;
        }
        if (operation.startsWith("EMITIR")) {
          const chave = result.chave || payload.chave;
          const artifacts = persistirArtefatosTransporte(document, chave, result);
          contexto.filaFiscal.salvarDocumento({
            chave,
            numeroVenda: payload.numeroDocumento,
            correlationId: payload.correlationId,
            serieNfe: payload.serie,
            numeroNfe: payload.numero,
            cStat: result.cStat,
            protocolo: result.protocolo,
            xmlPath: artifacts.xmlPath,
            pdfPath: artifacts.pdfPath,
            tipo: "AUTORIZADA",
            modeloDocumento: modelo(document),
          });
          contexto.filaFiscal.enfileirar(
            "TRANSPORTE_CALLBACK",
            { ...payload, ...result, ...artifacts, modeloDocumento: modelo(document) },
            payload.correlationId,
            payload.numeroDocumento,
          );
        }
      });
    }
  }
  contexto.filaFiscal.registrarHandler("TRANSPORTE_CALLBACK", async (payload) => {
    const cfg = await contexto.lerConfig();
    await enviarCallbackTransporte(cfg, payload);
  });
}

function createTransportFiscalAdapter(options = {}) {
  const detector = options.detector || verificarCapacidadeTransporte;
  const getBinding = options.getBinding || ((command) =>
    createTransportNativeBinding(command.documento, command.capacidade.paths.dll));

  return {
    async preflight(command) {
      if (!transporteHabilitado(command.documento)) {
        return { ok: false, erro: `${command.documento.toUpperCase()} desabilitado na configuração local.` };
      }
      if (command.operacao === "INCLUIR_CONDUTOR_MDFE") {
        return {
          ok: false,
          erro: "Inclusão de condutor requer documentIni antes da emissão; não existe export ACBrMDFe documentado para alteração posterior.",
        };
      }
      const capacidade = detector(command.documento);
      if (!capacidade.ok) return { ok: false, erro: `${capacidade.nome}: ${capacidade.ausentes.join(", ")}` };
      try {
        getBinding({ ...command, capacidade });
      } catch (error) {
        return { ok: false, erro: error.message };
      }
      return { ok: true };
    },
    async enqueue(command) {
      assertOperationPayload(command);
      const capacidade = detector(command.documento);
      if (!capacidade.ok) throw new Error(`${capacidade.nome} indisponível.`);
      registerQueueHandlers(command.contexto, getBinding);
      const numero = command.payload.numero || fiscalNumeracao.reservarProximoNumero(
        command.payload.serie || "1",
        modelo(command.documento),
      ).numero;
      const payload = {
        documento: command.documento,
        operacao: command.operacao,
        capacidade,
        ...command.payload,
        numero,
        modeloDocumento: modelo(command.documento),
        correlationId: command.correlationId || crypto.randomUUID(),
        numeroDocumento: String(command.payload.numeroDocumento || command.payload.numeroVenda || numero),
      };
      const enqueued = command.contexto.filaFiscal.enfileirar(
        tipoFila(command.documento, command.operacao),
        payload,
        payload.correlationId,
        payload.numeroDocumento,
      );
      command.contexto.filaFiscal.dispararProcessamento();
      return { ok: true, queueId: enqueued.id, deduplicado: enqueued.deduplicado, status: "PENDENTE" };
    },
  };
}

const defaultAdapter = createTransportFiscalAdapter();
module.exports = { ...defaultAdapter, createTransportFiscalAdapter, enviarCallbackTransporte, normalizeResponse };
