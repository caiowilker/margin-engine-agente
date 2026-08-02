/**
 * Catálogo ACBrLib PosPrinter — assinaturas koffi alinhadas ao manual oficial
 * e ao exports de ACBrLibPosPrinter.lpr (42 métodos).
 *
 * @see https://acbr.sourceforge.io/ACBrLib/ACBrLibPosPrinter1.html
 * @see docs/ACBRLIB-POSPRINTER.md
 *
 * required = sem estes o provider nativo não sobe.
 * optional = bind se existir na DLL; ausência não derruba o agente.
 */

/** @type {Record<string, string>} */
const POS_FFI_SIGNATURES = {
  // ── Núcleo / ciclo de vida ──────────────────────────────────────────────
  POS_Inicializar: "int POS_Inicializar(str eArqConfig, str eChaveCrypt)",
  POS_Finalizar: "int POS_Finalizar()",
  // POS_Inicializada: Boolean no Pascal — koffi bool (1 byte cdecl)
  POS_Inicializada: "bool POS_Inicializada()",
  POS_Nome: "int POS_Nome(_Out_ uint8 *sNome, _Inout_ int *esTamanho)",
  POS_Versao: "int POS_Versao(_Out_ uint8 *sVersao, _Inout_ int *esTamanho)",
  POS_OpenSSLInfo: "int POS_OpenSSLInfo(_Out_ uint8 *sOpenSSLInfo, _Inout_ int *esTamanho)",
  POS_UltimoRetorno: "int POS_UltimoRetorno(_Out_ uint8 *sMensagem, _Inout_ int *esTamanho)",

  // ── Configuração (ACBrLibPosPrinterST.pas) ───────────────────────────────
  POS_ConfigLer: "int POS_ConfigLer(str eArqConfig)",
  POS_ConfigGravar: "int POS_ConfigGravar(str eArqConfig)",
  POS_ConfigLerValor:
    "int POS_ConfigLerValor(str eSessao, str eChave, _Out_ uint8 *sValor, _Inout_ int *esTamanho)",
  POS_ConfigGravarValor: "int POS_ConfigGravarValor(str eSessao, str eChave, str sValor)",
  POS_ConfigImportar: "int POS_ConfigImportar(str eArqConfig)",
  POS_ConfigExportar:
    "int POS_ConfigExportar(_Out_ uint8 *sMensagem, _Inout_ int *esTamanho)",

  // ── Ativação ────────────────────────────────────────────────────────────
  POS_Ativar: "int POS_Ativar()",
  POS_Desativar: "int POS_Desativar()",

  // ── Impressão ───────────────────────────────────────────────────────────
  // Boolean ACBr → int (0/1), alinhado ao demo oficial Node (ffi-napi Windows).
  // koffi `bool` (1 byte) desalinha a stack em várias builds da DLL.
  POS_Imprimir:
    "int POS_Imprimir(str eString, int PulaLinha, int DecodificarTags, int CodificarPagina, int Copias)",
  POS_ImprimirLinha: "int POS_ImprimirLinha(str aString)",
  POS_ImprimirCmd: "int POS_ImprimirCmd(str aString)",
  POS_ImprimirTags: "int POS_ImprimirTags()",
  POS_ImprimirImagemArquivo: "int POS_ImprimirImagemArquivo(str aPath)",
  POS_ImprimirLogo: "int POS_ImprimirLogo(int nAKC1, int nAKC2, int nFatorX, int nFatorY)",
  POS_ImprimirCheque:
    "int POS_ImprimirCheque(int CodBanco, str AValor, str ADataEmissao, str AFavorecido, str ACidade, str AComplemento, int LerCMC7, int SegundosEspera)",
  POS_ImprimirTextoCheque:
    "int POS_ImprimirTextoCheque(int X, int Y, str AString, int AguardaCheque, int SegundosEspera)",

  // ── Operação / papel / gaveta ───────────────────────────────────────────
  POS_Zerar: "int POS_Zerar()",
  POS_InicializarPos: "int POS_InicializarPos()",
  POS_Reset: "int POS_Reset()",
  POS_PularLinhas: "int POS_PularLinhas(int NumLinhas)",
  POS_CortarPapel: "int POS_CortarPapel(int Parcial)",
  POS_AbrirGaveta: "int POS_AbrirGaveta()",

  // ── Status / portas / logo / cheque ─────────────────────────────────────
  POS_TxRx:
    "int POS_TxRx(str eCmd, uint8 BytesToRead, int ATimeOut, int WaitForTerminator, _Out_ uint8 *sResposta, _Inout_ int *esTamanho)",
  POS_LerInfoImpressora: "int POS_LerInfoImpressora(_Out_ uint8 *sInfo, _Inout_ int *esTamanho)",
  POS_LerStatusImpressora: "int POS_LerStatusImpressora(int Tentativas, _Out_ int *status)",
  POS_LerStatusImpressoraFormatado:
    "int POS_LerStatusImpressoraFormatado(int Tentativas, _Out_ uint8 *sStatus, _Inout_ int *esTamanho)",
  POS_RetornarTags:
    "int POS_RetornarTags(int IncluiAjuda, _Out_ uint8 *sResposta, _Inout_ int *esTamanho)",
  POS_AcharPortas: "int POS_AcharPortas(_Out_ uint8 *sPortas, _Inout_ int *esTamanho)",
  POS_GravarLogoArquivo: "int POS_GravarLogoArquivo(str aPath, int nAKC1, int nAKC2)",
  POS_ApagarLogo: "int POS_ApagarLogo(int nAKC1, int nAKC2)",
  POS_LeituraCheque: "int POS_LeituraCheque(_Out_ uint8 *sResposta, _Inout_ int *esTamanho)",
  POS_LerCMC7:
    "int POS_LerCMC7(int AguardaCheque, int SegundosEspera, _Out_ uint8 *sResposta, _Inout_ int *esTamanho)",
  POS_EjetarCheque: "int POS_EjetarCheque()",
  POS_PodeLerDaPorta: "int POS_PodeLerDaPorta()",
  POS_LerCaracteristicas:
    "int POS_LerCaracteristicas(_Out_ uint8 *sCaracteristicas, _Inout_ int *esTamanho)",
};

/** Sem estes o modo nativo não sobe. */
const POS_REQUIRED_EXPORTS = new Set([
  "POS_Inicializar",
  "POS_Finalizar",
  "POS_UltimoRetorno",
  "POS_ConfigLer",
  "POS_ConfigGravar",
  "POS_ConfigGravarValor",
  "POS_Ativar",
  "POS_Desativar",
  "POS_InicializarPos",
  "POS_Imprimir",
  "POS_ImprimirLinha",
  "POS_ImprimirCmd",
  "POS_CortarPapel",
  "POS_PularLinhas",
  "POS_AbrirGaveta",
  "POS_Zerar",
  "POS_Reset",
  "POS_Nome",
  "POS_Versao",
]);

/**
 * Subconjunto do worker (sessão quente) — só o caminho de cupom/gaveta.
 * Obrigatórios no worker: Inicializar, Ativar, Imprimir, Finalizar.
 */
const POS_WORKER_EXPORTS = [
  "POS_Inicializar",
  "POS_Finalizar",
  "POS_UltimoRetorno",
  "POS_ConfigGravar",
  "POS_ConfigGravarValor",
  "POS_Ativar",
  "POS_Desativar",
  "POS_InicializarPos",
  "POS_Imprimir",
  "POS_AbrirGaveta",
  "POS_Zerar",
  "POS_CortarPapel",
  "POS_PularLinhas",
];

const POS_WORKER_REQUIRED = new Set([
  "POS_Inicializar",
  "POS_Finalizar",
  "POS_UltimoRetorno",
  "POS_ConfigGravarValor",
  "POS_ConfigGravar",
  "POS_Ativar",
  "POS_Desativar",
  "POS_InicializarPos",
  "POS_Imprimir",
]);

/**
 * Uso no agente Margin Engine (documentação / auditoria).
 * @type {Record<string, "hot"|"support"|"unused">}
 */
const POS_AGENT_USAGE = {
  POS_Inicializar: "hot",
  POS_Finalizar: "hot",
  POS_Ativar: "hot",
  POS_Desativar: "hot",
  POS_InicializarPos: "hot",
  POS_Imprimir: "hot",
  POS_ConfigGravarValor: "hot",
  POS_ConfigGravar: "hot",
  POS_ConfigLer: "support",
  POS_UltimoRetorno: "hot",
  POS_AbrirGaveta: "hot",
  POS_Zerar: "support",
  POS_Reset: "support",
  POS_CortarPapel: "support",
  POS_PularLinhas: "support",
  POS_ImprimirLinha: "support",
  POS_ImprimirCmd: "support",
  POS_Nome: "support",
  POS_Versao: "support",
  POS_GravarLogoArquivo: "support",
  POS_ImprimirLogo: "support",
  POS_LerStatusImpressoraFormatado: "support",
  POS_AcharPortas: "support",
  POS_LerInfoImpressora: "support",
  POS_PodeLerDaPorta: "support",
  POS_LerCaracteristicas: "support",
  POS_Inicializada: "unused",
  POS_OpenSSLInfo: "unused",
  POS_ConfigLerValor: "unused",
  POS_ConfigImportar: "unused",
  POS_ConfigExportar: "unused",
  POS_ImprimirTags: "unused",
  POS_ImprimirImagemArquivo: "unused",
  POS_ApagarLogo: "unused",
  POS_LerStatusImpressora: "unused",
  POS_RetornarTags: "unused",
  POS_TxRx: "unused",
  POS_ImprimirCheque: "unused",
  POS_ImprimirTextoCheque: "unused",
  POS_LeituraCheque: "unused",
  POS_LerCMC7: "unused",
  POS_EjetarCheque: "unused",
};

function listCatalog() {
  return Object.keys(POS_FFI_SIGNATURES).sort();
}

module.exports = {
  POS_FFI_SIGNATURES,
  POS_REQUIRED_EXPORTS,
  POS_WORKER_EXPORTS,
  POS_WORKER_REQUIRED,
  POS_AGENT_USAGE,
  listCatalog,
};
