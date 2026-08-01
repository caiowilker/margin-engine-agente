/**
 * ACBrLib Node usa koffi em dois módulos: a base aloca o handle e o bridge
 * declara a função native. Instâncias distintas de koffi tornam seus External
 * incompatíveis, mesmo quando têm a mesma versão/binário (`expected void **`).
 */
const fs = require("fs");
const path = require("path");

const ACBR_PACKAGES = [
  "@projetoacbr/acbrlib-base-node",
  "@projetoacbr/acbrlib-dfe-node",
  "@projetoacbr/acbrlib-nfe-node",
  "@projetoacbr/acbrlib-nfse-node",
];

function versionOf(packageDir) {
  return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version;
}

function enforceSingleKoffi({ appRoot = path.resolve(__dirname, ".."), packages = ACBR_PACKAGES } = {}) {
  const rootKoffi = path.join(appRoot, "node_modules", "koffi");
  if (!fs.existsSync(rootKoffi)) {
    throw new Error("[ACBrLib] koffi raiz ausente; execute Reparar no instalador");
  }
  const rootVersion = versionOf(rootKoffi);
  const removed = [];

  for (const packageName of packages) {
    const nested = path.join(appRoot, "node_modules", packageName, "node_modules", "koffi");
    if (!fs.existsSync(nested)) continue;
    const nestedVersion = versionOf(nested);
    if (nestedVersion !== rootVersion) {
      throw new Error(
        `[ACBrLib] múltiplas versões de koffi detectadas (${rootVersion} e ${nestedVersion}); execute Reparar no instalador`,
      );
    }
    fs.rmSync(nested, { recursive: true, force: true });
    removed.push(nested);
  }
  return { rootVersion, removed };
}

module.exports = { ACBR_PACKAGES, enforceSingleKoffi };
