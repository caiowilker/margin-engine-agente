"use strict";

/**
 * Contratos C da ACBrLib para transporte.
 *
 * Os símbolos documentados pela ACBrLib são CTE_* e MDFE_*. A aplicação usa
 * nomes normalizados ACBrCTe_* / ACBrMDFe_* para impedir que APIs de NFe sejam
 * passadas acidentalmente ao adaptador. Nenhuma DLL é carregada sem Windows,
 * caminho existente e todos os exports exigidos.
 *
 * A camada FFI é deliberadamente pequena e aceita um binding injetado nos
 * testes. Isso evita afirmar compatibilidade com uma versão de DLL que ainda
 * não foi validada pelo instalador/homologação.
 */
const fs = require("fs");
const path = require("path");

const CONTRACTS = {
  cte: {
    prefix: "ACBrCTe",
    exports: {
      ACBrCTe_Inicializar: "CTE_Inicializar",
      ACBrCTe_Finalizar: "CTE_Finalizar",
      ACBrCTe_CarregarINI: "CTE_CarregarINI",
      ACBrCTe_Assinar: "CTE_Assinar",
      ACBrCTe_Validar: "CTE_Validar",
      ACBrCTe_Enviar: "CTE_Enviar",
      ACBrCTe_Cancelar: "CTE_Cancelar",
      ACBrCTe_ObterXml: "CTE_ObterXml",
      ACBrCTe_ImprimirPDF: "CTE_ImprimirPDF",
      ACBrCTe_UltimoRetorno: "CTE_UltimoRetorno",
    },
  },
  mdfe: {
    prefix: "ACBrMDFe",
    exports: {
      ACBrMDFe_Inicializar: "MDFE_Inicializar",
      ACBrMDFe_Finalizar: "MDFE_Finalizar",
      ACBrMDFe_CarregarINI: "MDFE_CarregarINI",
      ACBrMDFe_Assinar: "MDFE_Assinar",
      ACBrMDFe_Validar: "MDFE_Validar",
      ACBrMDFe_Enviar: "MDFE_Enviar",
      ACBrMDFe_Encerrar: "MDFE_EncerrarMDFe",
      ACBrMDFe_ObterXml: "MDFE_ObterXml",
      ACBrMDFe_ImprimirPDF: "MDFE_ImprimirPDF",
      ACBrMDFe_UltimoRetorno: "MDFE_UltimoRetorno",
    },
  },
};

function assertWindowsNative(documento, dllPath) {
  if (process.platform !== "win32") {
    throw new Error(`${documento} nativo exige Windows; nenhuma FFI foi carregada.`);
  }
  if (!dllPath || !fs.existsSync(dllPath)) {
    throw new Error(`DLL ${documento} não encontrada para binding nativo.`);
  }
}

function createKoffiBinding(documento, dllPath) {
  assertWindowsNative(documento, dllPath);
  let koffi;
  try {
    koffi = require("koffi");
  } catch {
    throw new Error("Dependência koffi ausente; não é possível validar ACBrLib nativa.");
  }

  const contract = CONTRACTS[documento];
  if (!contract) throw new Error(`Documento de transporte inválido: ${documento}`);
  const library = koffi.load(path.resolve(dllPath));
  const raw = {};
  const declarations = {
    Inicializar: "int __stdcall inicializar(str eArqConfig, str eChaveCrypt)",
    Finalizar: "int __stdcall finalizar()",
    CarregarINI: "int __stdcall carregarINI(str eArquivoINI)",
    Assinar: "int __stdcall assinar()",
    Validar: "int __stdcall validar()",
    Enviar: "int __stdcall enviar(int aLote, bool imprimir, bool sincrono, _Out_ char *buffer, _Inout_ int *bufferLen)",
    Cancelar: "int __stdcall cancelar(str chave, str justificativa, str cnpj, int lote, _Out_ char *buffer, _Inout_ int *bufferLen)",
    Encerrar: "int __stdcall encerrar(str chave, str dataHora, str municipio, str cnpj, str protocolo, _Out_ char *buffer, _Inout_ int *bufferLen)",
    ObterXml: "int __stdcall obterXml(int index, _Out_ char *buffer, _Inout_ int *bufferLen)",
    ImprimirPDF: "int __stdcall imprimirPDF()",
    UltimoRetorno: "int __stdcall ultimoRetorno(_Out_ char *buffer, _Inout_ int *bufferLen)",
  };

  for (const [normalized, exportName] of Object.entries(contract.exports)) {
    const operation = normalized.replace(`${contract.prefix}_`, "");
    try {
      raw[normalized] = library.func(exportName, declarations[operation]);
    } catch (error) {
      throw new Error(
        `${documento} inválido: export documentado ${exportName} ausente/incompatível (${error.message}).`,
      );
    }
  }
  const responseFunctions = new Set(["Enviar", "Cancelar", "Encerrar", "IncluirCondutor", "ObterXml", "UltimoRetorno"]);
  const native = {};
  const getLastError = () => {
    const last = raw[`${contract.prefix}_UltimoRetorno`];
    return last ? callWithResponse(last, []) : "";
  };
  for (const normalized of Object.keys(contract.exports)) {
    const operation = normalized.replace(`${contract.prefix}_`, "");
    if (responseFunctions.has(operation)) {
      native[normalized] = (...args) => callWithResponse(raw[normalized], args, getLastError);
    } else {
      native[normalized] = (...args) => {
        const code = raw[normalized](...args);
        if (code !== 0) throw new Error(`${normalized} falhou (código ${code}): ${getLastError()}`);
        return true;
      };
    }
  }
  return native;
}

function callWithResponse(fn, args, getLastError = () => "") {
  let size = 8192;
  for (let attempt = 0; attempt < 3; attempt++) {
    const buffer = Buffer.alloc(size);
    const length = [size];
    const code = fn(...args, buffer, length);
    if (code === 0) return buffer.toString("utf8", 0, Math.max(0, length[0] - 1));
    if (length[0] > size) {
      size = length[0] + 1;
      continue;
    }
    throw new Error(`ACBrLib retornou código ${code}: ${getLastError()}`);
  }
  throw new Error("ACBrLib retornou resposta maior que o limite permitido.");
}

function validateBinding(documento, binding) {
  const contract = CONTRACTS[documento];
  if (!contract) throw new Error(`Documento de transporte inválido: ${documento}`);
  const missing = Object.keys(contract.exports).filter((name) => typeof binding?.[name] !== "function");
  if (missing.length) {
    throw new Error(
      `${contract.prefix} binding incompleto; exports obrigatórios: ${missing.join(", ")}`,
    );
  }
  return binding;
}

function createTransportNativeBinding(documento, dllPath, injectedBinding = null) {
  return validateBinding(documento, injectedBinding || createKoffiBinding(documento, dllPath));
}

module.exports = {
  CONTRACTS,
  createKoffiBinding,
  createTransportNativeBinding,
  validateBinding,
};
