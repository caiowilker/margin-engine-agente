// Validação operacional A1/CSC/ambiente via ACBr (sem armazenar CSC)
const fs = require("fs");
const acbr = require("./acbr");

function extrairValor(resposta, chave) {
  const linha = (resposta || "")
    .split("\n")
    .find((l) => l.toUpperCase().startsWith(chave.toUpperCase() + "="));
  return linha ? linha.split("=").slice(1).join("=").trim() : null;
}

async function validarEmissao() {
  if (!acbr.EMISSAO_FISCAL) {
    return { ok: true, fiscal: false, motivo: "EMISSAO_FISCAL desabilitado" };
  }

  const ambienteEsperado = (process.env.AMBIENTE_SEFAZ || "homologacao")
    .toLowerCase()
    .trim();

  let resposta;
  try {
    resposta = await acbr.enviarComando("NFCe.Status");
  } catch (err) {
    throw new Error(
      `ACBr indisponível para validação fiscal: ${err.message}`,
    );
  }

  const texto = resposta.toUpperCase();

  if (
    /CERTIFICADO.*VENC|CERTIFICADO.*EXPIR|CERTIFICADO.*INVALID|SEM CERTIFICADO|CERTIFICADO=N/.test(
      texto,
    )
  ) {
    throw new Error(
      "Certificado A1 inválido, ausente ou vencido (verifique ACBr Monitor)",
    );
  }

  const validade = extrairValor(resposta, "ValidadeCertificado");
  if (validade) {
    const dt = new Date(validade.replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$2-$1"));
    if (!Number.isNaN(dt.getTime()) && dt < new Date()) {
      throw new Error(`Certificado A1 vencido em ${validade}`);
    }
  }

  if (
    /CSC.*NAO|CSC.*INV|SEM CSC|IDTOKEN.*VAZIO|CSC=N/.test(texto)
  ) {
    throw new Error(
      "CSC não configurado corretamente no ACBr Monitor",
    );
  }

  const ambAcbr =
    extrairValor(resposta, "Ambiente") ||
    extrairValor(resposta, "TipoAmbiente") ||
    "";
  if (ambAcbr) {
    const t = ambAcbr.toUpperCase();
    const acbrHomolog = t.includes("HOMOLOG") || t === "2";
    const acbrProd = t.includes("PRODUC") || t === "1";
    if (ambienteEsperado === "homologacao" && acbrProd && !acbrHomolog) {
      throw new Error(
        "AMBIENTE_SEFAZ=homologacao mas ACBr Monitor está em produção",
      );
    }
    if (ambienteEsperado === "producao" && acbrHomolog && !acbrProd) {
      throw new Error(
        "AMBIENTE_SEFAZ=producao mas ACBr Monitor está em homologação",
      );
    }
  }

  const certPath = process.env.CERT_A1_PATH;
  if (certPath && !fs.existsSync(certPath)) {
    throw new Error(`CERT_A1_PATH não encontrado: ${certPath}`);
  }

  return {
    ok: true,
    fiscal: true,
    ambienteEsperado,
    ambienteAcbr: ambAcbr || null,
    idCsc: extrairValor(resposta, "IdCSC") ? "configurado" : null,
  };
}

module.exports = { validarEmissao, extrairValor };
