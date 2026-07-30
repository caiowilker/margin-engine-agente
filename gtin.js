/**
 * GTIN/EAN GS1 — tamanho + dígito verificador.
 * SKU interno do PDV não deve ser usado como cEAN.
 */

function gtinValido(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(d.length)) return false;
  if (/^0+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length - 1; i++) {
    const digit = Number(d[d.length - 2 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(d[d.length - 1]);
}

/**
 * Resolve GTIN apenas de campos de barras (nunca de codigo/SKU).
 * @returns {string} dígitos válidos ou "" → SEM GTIN
 */
function resolverGtin(item) {
  const candidatos = [
    item?.gtinComercial,
    item?.gtin,
    item?.codigoBarras,
    item?.ean,
    item?.ean13,
  ];
  for (const raw of candidatos) {
    const gtin = String(raw || "").replace(/\D/g, "");
    if (gtinValido(gtin)) return gtin;
  }
  return "";
}

module.exports = { gtinValido, resolverGtin };
