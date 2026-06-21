// Texto seguro para impressoras térmicas ESC/POS (encoding CP860).
// Evita "?" quando UTF-8 do banco/agente não mapeia no code page da impressora.

function toThermalText(value) {
  if (value == null) return "";
  let s = String(value);
  const substituicoes = {
    "\u2013": "-",
    "\u2014": "-",
    "\u2026": "...",
    "\u201c": '"',
    "\u201d": '"',
    "\u2018": "'",
    "\u2019": "'",
    "\u00a0": " ",
  };
  for (const [de, para] of Object.entries(substituicoes)) {
    s = s.split(de).join(para);
  }
  s = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

/** CNPJ/CPF/telefone — apenas caracteres ASCII de formatação. */
function toThermalDoc(value) {
  return String(value ?? "")
    .replace(/[^\d./\-()+\s]/g, "")
    .trim();
}

module.exports = { toThermalText, toThermalDoc };
