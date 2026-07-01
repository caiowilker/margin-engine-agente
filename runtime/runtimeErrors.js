/**
 * Erros estruturados do runtime Windows — códigos DIR-*.
 */
class RuntimeError extends Error {
  constructor(code, details = {}) {
    super(RuntimeError.formatMessage(code, details));
    this.name = "RuntimeError";
    this.code = code;
    this.details = details;
    this.cause = details.cause || null;
  }

  static formatMessage(code, d) {
    const arquivo = d.arquivo || d.file || "arquivo";
    const diretorio = d.diretorio || d.directory || "—";
    const motivo = d.motivo || d.reason || "Falha desconhecida.";
    const operacao = d.operacao || d.operation || "gravar";
    const tentativa = d.tentativa != null ? d.tentativa : d.attempt;
    const solucao =
      d.solucao ||
      d.suggestion ||
      "Executar reparo automático. Verificar permissões. Selecionar outro diretório.";

    let msg = `${code}\n\nNão foi possível ${operacao}:\n${arquivo}\n\nDiretório: ${diretorio}\n\nMotivo:\n${motivo}\n\nSolução:\n${solucao}`;
    if (tentativa != null) msg += `\n\nTentativa: ${tentativa}`;
    return msg;
  }
}

function mapFsError(err, ctx = {}) {
  const code = err && err.code;
  const arquivo = ctx.arquivo || ctx.file || "arquivo";
  const diretorio = ctx.diretorio || ctx.directory || "—";
  const operacao = ctx.operacao || "gravar";

  if (code === "EACCES" || code === "EPERM") {
    return new RuntimeError("DIR-004", {
      arquivo,
      diretorio,
      operacao,
      motivo: "Permissão insuficiente.",
      solucao:
        "Executar reparo automático.\nVerificar permissões da pasta.\nExecutar como administrador se necessário.",
      cause: err,
      tentativa: ctx.tentativa,
    });
  }
  if (code === "ENOSPC") {
    return new RuntimeError("DIR-005", {
      arquivo,
      diretorio,
      operacao,
      motivo: "Disco cheio.",
      solucao: "Liberar espaço em disco e tentar novamente.",
      cause: err,
    });
  }
  if (code === "ENOENT") {
    return new RuntimeError("DIR-002", {
      arquivo,
      diretorio,
      operacao,
      motivo: "Diretório ou arquivo não encontrado.",
      solucao: "O sistema tentará recriar automaticamente na próxima operação.",
      cause: err,
    });
  }
  return new RuntimeError("DIR-001", {
    arquivo,
    diretorio,
    operacao,
    motivo: err && err.message ? err.message : String(err),
    cause: err,
  });
}

module.exports = { RuntimeError, mapFsError };
