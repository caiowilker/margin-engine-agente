/**
 * Gera acbrlib.ini com paths resolvidos via DirectoryManager — nunca hardcoded.
 */
const path = require("path");
const { getDirectoryManager } = require("./directoryManager");

function gerarConteudoIni(opts = {}) {
  const dm = getDirectoryManager();
  const paths = dm.PATHS;
  dm.ensureAll();

  const isProd =
    String(opts.ambiente || opts.tpAmb || "2") === "1" ||
    String(opts.ambiente || "").toLowerCase() === "producao";
  const ambLib = isProd ? "0" : "1";
  const ambSefaz = isProd ? "producao" : "homologacao";
  const uf = opts.uf || "MG";
  const certFile = opts.certFile || path.join(paths.root, "cert", "cert.pfx");
  const senhaIni = opts.certSenha ? "__VAULT__" : opts.senhaIni || "";
  const cscIni = opts.cscToken ? "__VAULT__" : opts.csc || "";
  const idCsc = opts.cscId || "000001";

  const logsDir = paths.fiscalLogs;
  const schemasDir = path.join(paths.fiscalConfig, "..", "schemas", "NFe");
  const configDir = paths.fiscalConfig;
  const xmlDir = paths.fiscalXml;
  const pdfDir = paths.fiscalPdf;
  const servicosDest = path.join(configDir, "ACBrNFeServicos.ini");

  return `[Principal]
TipoResposta=2
LogNivel=4
LogPath=${logsDir}

[Sistema]
Nome=MarginEngine-Agente
Versao=1.0.0
AmbienteSefaz=${ambSefaz}

[ACBrNFe]
Ambiente=${ambLib}
AmbienteSefaz=${ambSefaz}
ModeloDF=65
VersaoDF=4.00
PathSchemas=${schemasDir}
PathSalvar=${xmlDir}
PathNFe=${xmlDir}
PathPDF=${pdfDir}
ArquivoServicos=${servicosDest}
SalvarGer=1
SalvarWS=1
ExibirErroSchema=1
FormaEmissao=0
Timeout=30000

[NFe]
Ambiente=${ambLib}
AmbienteSefaz=${ambSefaz}
UF=${uf}

[Certificado]
Arquivo=${certFile}
Senha=${senhaIni}
NumeroSerie=

[DFe]
UF=${uf}
SSLCryptLib=1
SSLHttpLib=3
SSLXmlSignLib=4
SSLType=5

[NFCe]
IdCSC=${idCsc}
CSC=${cscIni}

[DANFE]
PathPDF=${pdfDir}
TipoDANFE=1
ImprimeCodigoEan=0

[DANFENFe]
ExibeEAN=0
LarguraCodProd=72
`;
}

function gravarIni(destPath, opts = {}) {
  const fs = require("fs");
  const content = gerarConteudoIni(opts);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content, "utf8");
  return destPath;
}

module.exports = { gerarConteudoIni, gravarIni };
