/**
 * Relatório de vendas selecionadas em tags ACBr — layout em relatorioVendasLayout.js.
 */
const { tagLogoHeader, tagCorte } = require("./acbrTags");
const { buildRelatorioVendasLayout } = require("./relatorioVendasLayout");

function lineToTags(line) {
  if (!line || line.kind === "blank") return "";
  if (line.kind === "sep") return line.text || "";

  let text = String(line.text ?? "");
  if (line.bold) text = `<n>${text}</n>`;
  if (line.size === "lg") text = `<e>${text}</e>`;
  if (line.center) return `<ce>${text}</ce>`;
  return text;
}

function renderFromLayout({ showLogo, lines }, payload) {
  const out = ["</zera>"];
  if (showLogo) {
    const logo = tagLogoHeader(payload);
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

function renderRelatorioVendasTags(payload = {}) {
  return renderFromLayout(buildRelatorioVendasLayout(payload), payload);
}

module.exports = {
  renderRelatorioVendasTags,
};
