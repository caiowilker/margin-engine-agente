/**
 * Comparação de versão do agente — paridade com CompareVersion do instalador Inno.
 * Retorna -1 / 0 / 1 (a < b / iguais / a > b).
 */

function parseVersaoPartes(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/^v/i, "");
  const partes = [0, 0, 0, 0];
  if (!s) return partes;
  const nums = s.split(/[^0-9]+/).filter((p) => p !== "");
  for (let i = 0; i < Math.min(4, nums.length); i++) {
    partes[i] = parseInt(nums[i], 10) || 0;
  }
  return partes;
}

function compararVersao(a, b) {
  const pa = parseVersaoPartes(a);
  const pb = parseVersaoPartes(b);
  for (let i = 0; i < 4; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

function isUpgrade(remoto, atual) {
  return compararVersao(remoto, atual) > 0;
}

function isSameVersion(remoto, atual) {
  return compararVersao(remoto, atual) === 0;
}

function isDowngrade(remoto, atual) {
  return compararVersao(remoto, atual) < 0;
}

module.exports = {
  parseVersaoPartes,
  compararVersao,
  isUpgrade,
  isSameVersion,
  isDowngrade,
};
