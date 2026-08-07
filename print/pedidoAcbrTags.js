/**
 * Comanda Order Engine em tags ACBr — layouts por tipo (pedidoLayout.js).
 * Cupom fiscal continua em cupomAcbrTags.js (não misturar).
 */
const { tagCorte, tagLogoHeader } = require("./acbrTags");
const { buildPedidoLayout } = require("./pedidoLayout");
const { normalizarPedidoPayload } = require("./pedidoPrint");

function lineToTags(line) {
  if (!line || line.kind === "blank") return "";
  if (line.kind === "sep") return line.text || "";

  let text = String(line.text ?? "");
  if (line.bold) text = `<n>${text}</n>`;
  if (line.size === "lg") text = `<e>${text}</e>`;

  if (line.center) return `<ce>${text}</ce>`;
  return text;
}

function renderPedidoTags(rawPayload = {}) {
  const { showLogo, lines } = buildPedidoLayout(rawPayload);
  const out = ["</zera>"];

  if (showLogo) {
    const logo = tagLogoHeader(rawPayload);
    if (logo) out.push(logo.replace(/\n$/, ""));
  }

  for (const line of lines) {
    const rendered = lineToTags(line);
    if (rendered !== "") out.push(rendered);
    else if (line.kind === "blank") out.push(" ");
  }

  out.push(tagCorte());
  return out.filter((x) => x != null && x !== "").join("\n") + "\n";
}

module.exports = {
  renderPedidoTags,
  normalizarPedidoPayload,
};
