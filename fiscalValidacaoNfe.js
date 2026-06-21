// Validação de payload NF-e modelo 55 antes de montar INI / chamar ACBr
function limpar(v) {
  return String(v ?? "").trim();
}

function normalizarDestinatario(payload) {
  if (payload?.destinatario && typeof payload.destinatario === "object") {
    return payload.destinatario;
  }
  const d = {};
  const cpf = String(payload?.cpfCliente || payload?.destinatarioCpf || "").replace(/\D/g, "");
  const cnpj = String(payload?.cnpjCliente || payload?.destinatarioCnpj || "").replace(/\D/g, "");
  if (cpf.length === 11) d.cpfCnpj = cpf;
  else if (cnpj.length === 14) d.cpfCnpj = cnpj;
  d.razaoSocial = payload?.nomeCliente || payload?.destinatarioNome || payload?.razaoSocial;
  d.inscricaoEstadual = payload?.inscricaoEstadual || payload?.destinatarioIe;
  d.indIEDest = payload?.indIEDest;
  d.email = payload?.email || payload?.destinatarioEmail;
  if (payload?.enderecoDestinatario) {
    d.endereco = payload.enderecoDestinatario;
  } else {
    d.endereco = {
      logradouro: payload?.logradouro,
      numero: payload?.numero,
      complemento: payload?.complemento,
      bairro: payload?.bairro,
      cep: payload?.cep,
      codigoMunicipio: payload?.codigoMunicipio || payload?.codigoIbge,
      municipio: payload?.municipio || payload?.cidade,
      uf: payload?.uf,
    };
  }
  return d;
}

function validarDestinatarioNfe(dest) {
  const faltando = [];
  const doc = String(dest?.cpfCnpj || "").replace(/\D/g, "");
  if (doc.length !== 11 && doc.length !== 14) {
    faltando.push("CPF ou CNPJ do destinatário");
  }
  if (!limpar(dest?.razaoSocial)) faltando.push("Razão social / nome do destinatário");
  const end = dest?.endereco || {};
  if (!limpar(end.logradouro)) faltando.push("Logradouro");
  if (!limpar(end.numero)) faltando.push("Número");
  if (!limpar(end.bairro)) faltando.push("Bairro");
  const cep = String(end.cep || "").replace(/\D/g, "");
  if (cep.length !== 8) faltando.push("CEP (8 dígitos)");
  if (!limpar(end.municipio)) faltando.push("Município");
  if (!limpar(end.uf) || String(end.uf).length !== 2) faltando.push("UF");
  const ibge = String(end.codigoMunicipio || "").replace(/\D/g, "");
  if (ibge.length !== 7) faltando.push("Código IBGE do município (7 dígitos)");

  const indIE = dest?.indIEDest ?? (limpar(dest?.inscricaoEstadual) ? 1 : doc.length === 14 ? 1 : 9);
  if (indIE === 1 && doc.length === 14 && !limpar(dest?.inscricaoEstadual)) {
    faltando.push("Inscrição estadual (contribuinte ICMS)");
  }

  if (faltando.length) {
    const err = new Error(
      `Destinatário incompleto para NF-e: ${faltando.join(", ")}.`,
    );
    err.permanente = true;
    err.camposFaltando = faltando;
    throw err;
  }

  return { ...dest, cpfCnpj: doc, indIEDest: indIE, endereco: { ...end, cep, codigoMunicipio: ibge } };
}

function validarPayloadNfe(payload) {
  if (!payload || typeof payload !== "object") {
    const err = new Error("Payload de emissão NF-e inválido.");
    err.permanente = true;
    throw err;
  }

  const itens = payload.itens || [];
  if (!Array.isArray(itens) || itens.length === 0) {
    const err = new Error("NF-e exige ao menos 1 item na venda.");
    err.permanente = true;
    throw err;
  }

  const total = Number(payload.total);
  if (!Number.isFinite(total) || total <= 0) {
    const err = new Error("Total da venda inválido para NF-e.");
    err.permanente = true;
    throw err;
  }

  for (let i = 0; i < itens.length; i++) {
    const item = itens[i];
    if (!limpar(item.nome)) {
      const err = new Error(`Item ${i + 1} sem descrição (xProd).`);
      err.permanente = true;
      throw err;
    }
  }

  const dest = validarDestinatarioNfe(normalizarDestinatario(payload));
  return dest;
}

module.exports = {
  validarPayloadNfe,
  validarDestinatarioNfe,
  normalizarDestinatario,
};
