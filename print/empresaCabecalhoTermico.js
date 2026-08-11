/**
 * Cabeçalho da empresa na térmica — SSOT para cupom, vasilhame e demais comprovantes.
 * Evita endereço/telefone divergirem entre ACBr (tags) e ESC/POS.
 */
const { toThermalText, toThermalDoc } = require("../thermalText");

function tx(v) {
  return toThermalText(v);
}

/** Logradouro/nº/bairro — ou `endereco` legado já completo. */
function formatarLinhaEnderecoEmpresa(empresa) {
  const e = empresa || {};
  const logradouro = String(e.logradouro || "").trim();
  if (logradouro) {
    return [logradouro, e.numero, e.bairro]
      .filter((p) => p != null && String(p).trim())
      .map((p) => tx(String(p).trim()))
      .join(", ");
  }
  const legado = String(e.endereco || "").trim();
  return legado ? tx(legado) : "";
}

function formatarCidadeUfEmpresa(empresa) {
  const e = empresa || {};
  const cidade = String(e.cidade || "").trim();
  const uf = String(e.uf || "").trim();
  if (!cidade && !uf) return "";
  if (cidade && uf) return tx(`${cidade} - ${uf}`);
  return tx(cidade || uf);
}

function resolverCabecalhoEmpresa(empresa) {
  const e = empresa && typeof empresa === "object" ? empresa : {};
  const nome = String(e.nome || e.nomeFantasia || e.razaoSocial || "").trim();
  const cnpj = String(e.cnpj || "").trim();
  const telefone = String(e.telefone || "").trim();
  return {
    nome: nome ? tx(nome) : "",
    cnpj: cnpj ? toThermalDoc(cnpj) : "",
    endereco: formatarLinhaEnderecoEmpresa(e),
    cidadeUf: formatarCidadeUfEmpresa(e),
    telefone: telefone ? toThermalDoc(telefone) : "",
  };
}

/** Linhas ACBr já centralizadas (sem logo). */
function linhasCabecalhoEmpresaTags(empresa, cols) {
  const h = resolverCabecalhoEmpresa(empresa);
  const max = Number.isFinite(cols) && cols > 0 ? cols : 48;
  const out = [];
  if (h.nome) out.push(`<ce><n>${h.nome}</n></ce>`);
  if (h.cnpj) out.push(`<ce>CNPJ: ${h.cnpj}</ce>`);
  if (h.endereco) out.push(`<ce>${h.endereco.slice(0, max)}</ce>`);
  if (h.cidadeUf) out.push(`<ce>${h.cidadeUf.slice(0, max)}</ce>`);
  if (h.telefone) out.push(`<ce>Tel: ${h.telefone}</ce>`);
  return out;
}

/**
 * Cabeçalho ESC/POS (impressora já em align ct).
 * `printer` = API escpos (text/style).
 */
function aplicarCabecalhoEmpresaEscpos(printer, empresa, cols) {
  const h = resolverCabecalhoEmpresa(empresa);
  const max = Number.isFinite(cols) && cols > 0 ? cols : 48;
  if (h.nome) printer.style("b").text(h.nome).style("normal");
  if (h.cnpj) printer.text("CNPJ: " + h.cnpj);
  if (h.endereco) printer.text(h.endereco.slice(0, max));
  if (h.cidadeUf) printer.text(h.cidadeUf.slice(0, max));
  if (h.telefone) printer.text("Tel: " + h.telefone);
  return h;
}

module.exports = {
  formatarLinhaEnderecoEmpresa,
  formatarCidadeUfEmpresa,
  resolverCabecalhoEmpresa,
  linhasCabecalhoEmpresaTags,
  aplicarCabecalhoEmpresaEscpos,
};
