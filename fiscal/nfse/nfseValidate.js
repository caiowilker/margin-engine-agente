// Validação de payload NFS-e (modelo 99) antes de enfileirar / chamar ACBr

function limpar(v) {
  return String(v ?? "").trim();
}

function ibgeDoEndereco(end) {
  if (!end || typeof end !== "object") return "";
  return String(end.codigoMunicipio || end.codigoIbge || "").replace(/\D/g, "");
}

function normalizarEndereco(end) {
  if (!end || typeof end !== "object") return end;
  const ibge = ibgeDoEndereco(end);
  return {
    ...end,
    ...(ibge ? { codigoMunicipio: ibge, codigoIbge: ibge } : {}),
  };
}

function normalizarTomador(payload) {
  if (payload?.tomador && typeof payload.tomador === "object") {
    const tom = { ...payload.tomador };
    if (!tom.nome && tom.razaoSocial) tom.nome = tom.razaoSocial;
    if (!tom.endereco && (tom.logradouro || tom.cep)) {
      tom.endereco = {
        logradouro: tom.logradouro,
        numero: tom.numero,
        complemento: tom.complemento,
        bairro: tom.bairro,
        cep: tom.cep,
        municipio: tom.municipio,
        uf: tom.uf,
        codigoIbge: tom.codigoIbge,
      };
    }
    if (tom.endereco) tom.endereco = normalizarEndereco(tom.endereco);
    return tom;
  }
  const doc = String(payload?.cpfCnpjTomador || payload?.tomadorCpfCnpj || "").replace(/\D/g, "");
  return {
    cpfCnpj: doc,
    nome: payload?.nomeTomador || payload?.tomadorNome,
    email: payload?.emailTomador || payload?.tomadorEmail,
    endereco: normalizarEndereco(payload?.enderecoTomador || payload?.endereco),
  };
}

function normalizarServico(payload) {
  if (payload?.servico && typeof payload.servico === "object") {
    const serv = { ...payload.servico };
    if (serv.valorServico == null && serv.valorServicos != null) {
      serv.valorServico = serv.valorServicos;
    }
    return serv;
  }
  return {
    itemListaServico: payload?.itemListaServico,
    discriminacao: payload?.discriminacao,
    valorServico: payload?.valorServico ?? payload?.valor,
    aliquotaIss: payload?.aliquotaIss,
    issRetido: payload?.issRetido === true,
  };
}

function validarTomadorNfse(tom) {
  const faltando = [];
  const doc = String(tom?.cpfCnpj || "").replace(/\D/g, "");
  if (doc.length !== 11 && doc.length !== 14) {
    faltando.push("CPF ou CNPJ do tomador");
  }
  if (!limpar(tom?.nome)) faltando.push("Nome / razão social do tomador");
  const end = tom?.endereco || {};
  if (!limpar(end.logradouro)) faltando.push("Logradouro do tomador");
  if (!limpar(end.numero)) faltando.push("Número do endereço do tomador");
  if (!limpar(end.bairro)) faltando.push("Bairro do tomador");
  const cep = String(end.cep || "").replace(/\D/g, "");
  if (cep.length !== 8) faltando.push("CEP do tomador (8 dígitos)");
  if (!limpar(end.municipio)) faltando.push("Município do tomador");
  if (!limpar(end.uf) || String(end.uf).length !== 2) faltando.push("UF do tomador");
  const ibge = ibgeDoEndereco(end);
  if (ibge.length !== 7) faltando.push("Código IBGE do município do tomador (7 dígitos)");
  return faltando;
}

function validarServicoNfse(serv) {
  const faltando = [];
  if (!limpar(serv?.itemListaServico)) faltando.push("Item da lista LC 116");
  if (!limpar(serv?.discriminacao) || limpar(serv.discriminacao).length < 10) {
    faltando.push("Discriminação do serviço (mín. 10 caracteres)");
  }
  const valor = Number(serv?.valorServico);
  if (!Number.isFinite(valor) || valor <= 0) faltando.push("Valor do serviço");
  const aliq = serv?.aliquotaIss;
  if (aliq != null && aliq !== "") {
    const n = Number(aliq);
    // Aceita percentual (0–100) ou fração de domínio (0–1), ex.: 0.05 = 5%.
    const okPercentual = Number.isFinite(n) && n >= 0 && n <= 100;
    if (!okPercentual) faltando.push("Alíquota ISS inválida");
  }
  return faltando;
}

function validarPayloadNfse(payload) {
  const faltando = [];
  const numeroRps = payload?.numeroRps ?? payload?.numeroVenda;
  if (!limpar(numeroRps)) faltando.push("numeroRps");
  if (!limpar(payload?.correlationId)) faltando.push("correlationId");

  const tomador = normalizarTomador(payload);
  const servico = normalizarServico(payload);
  faltando.push(...validarTomadorNfse(tomador));
  faltando.push(...validarServicoNfse(servico));

  const temIni = payload?.documentIni && String(payload.documentIni).trim();
  if (!temIni && faltando.length > 2) {
    const err = new Error(`Tomador/serviço incompleto para NFS-e: ${faltando.join(", ")}`);
    err.camposFaltando = [...new Set(faltando)];
    err.permanente = true;
    throw err;
  }

  if (!temIni) {
    const err = new Error("documentIni obrigatório para NFS-e");
    err.camposFaltando = ["documentIni"];
    err.permanente = true;
    throw err;
  }

  if (faltando.length) {
    const err = new Error(`Payload NFS-e incompleto: ${faltando.join(", ")}`);
    err.camposFaltando = [...new Set(faltando)];
    err.permanente = true;
    throw err;
  }

  return {
    tomador,
    servico,
    numeroRps: String(numeroRps),
    correlationId: payload.correlationId,
  };
}

module.exports = {
  validarPayloadNfse,
  validarTomadorNfse,
  validarServicoNfse,
  normalizarTomador,
  normalizarServico,
};
