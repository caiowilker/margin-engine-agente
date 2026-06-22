// Validação de payload fiscal antes de montar INI / chamar ACBr
function limpar(v) {
  return String(v ?? "").trim();
}

function validarPayloadNfce(payload) {
  if (!payload || typeof payload !== "object") {
    const err = new Error("Payload de emissão NFC-e inválido.");
    err.permanente = true;
    throw err;
  }

  const itens = payload.itens || [];
  if (!Array.isArray(itens) || itens.length === 0) {
    const err = new Error("NFC-e exige ao menos 1 item na venda.");
    err.permanente = true;
    throw err;
  }

  const total = Number(payload.total);
  if (!Number.isFinite(total) || total <= 0) {
    const err = new Error("Total da venda inválido para NFC-e.");
    err.permanente = true;
    throw err;
  }

  let somaItens = 0;
  for (let i = 0; i < itens.length; i++) {
    const item = itens[i];
    if (!limpar(item.nome)) {
      const err = new Error(`Item ${i + 1} sem descrição (xProd).`);
      err.permanente = true;
      throw err;
    }
    const qtd = Number(item.quantidade);
    const pu = Number(item.precoUnitario);
    if (!Number.isFinite(qtd) || qtd <= 0) {
      const err = new Error(`Item "${item.nome}": quantidade inválida.`);
      err.permanente = true;
      throw err;
    }
    if (!Number.isFinite(pu) || pu < 0) {
      const err = new Error(`Item "${item.nome}": preço unitário inválido.`);
      err.permanente = true;
      throw err;
    }
    const itemTotal = Number(item.total ?? qtd * pu);
    somaItens += itemTotal;

    const ncm = String(item.ncm || "").replace(/\D/g, "");
    if (ncm && ncm.length !== 8) {
      const err = new Error(
        `Item "${item.nome}": NCM deve ter 8 dígitos (informado: ${ncm}).`,
      );
      err.permanente = true;
      throw err;
    }
  }

  const desconto = Number(payload.desconto || 0);
  const esperado = somaItens - desconto;
  if (Math.abs(esperado - total) > 0.05) {
    const err = new Error(
      `Total da venda (R$ ${total.toFixed(2)}) não confere com itens-desconto (R$ ${esperado.toFixed(2)}).`,
    );
    err.permanente = true;
    throw err;
  }

  const cpf = String(payload.cpfCliente || "").replace(/\D/g, "");
  const cnpj = String(payload.cnpjCliente || "").replace(/\D/g, "");
  if (cpf && cpf.length !== 11) {
    const err = new Error("CPF do consumidor deve ter 11 dígitos.");
    err.permanente = true;
    throw err;
  }
  if (cnpj && cnpj.length !== 14) {
    const err = new Error("CNPJ do consumidor deve ter 14 dígitos.");
    err.permanente = true;
    throw err;
  }
  if (cpf && cnpj) {
    const err = new Error("Informe apenas CPF ou CNPJ do consumidor, não ambos.");
    err.permanente = true;
    throw err;
  }
}

module.exports = { validarPayloadNfce };
