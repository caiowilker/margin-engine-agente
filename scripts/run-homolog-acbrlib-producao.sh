#!/usr/bin/env bash
# Homologação ACBrLib produção — Node Windows (FFI real com ACBrNFe64.dll)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WIN_NODE="/mnt/c/Program Files/nodejs/node.exe"
if [[ ! -f "$WIN_NODE" ]]; then
  echo "Node Windows não encontrado em $WIN_NODE"
  echo "Execute na pasta agente-local: node scripts/homolog-acbrlib-producao.js"
  exit 1
fi

export ACBR_DRIVER=lib
unset ACBR_LIB_ALLOW_PARITY
export EMISSAO_FISCAL=true
# Paths vêm de homolog-acbrlib/.env (dotenv no script Node). Não sobrescrever com demo.
export MARGIN_ENGINE_ROOT="${MARGIN_ENGINE_ROOT:-$ROOT/homolog-data}"
export ACBR_WIN_STAGING="${ACBR_WIN_STAGING:-C:/Users/Caio Wilker/AppData/Local/Temp/margin-acbrlib-compiled}"

echo "MARGIN_ENGINE_ROOT=$MARGIN_ENGINE_ROOT"
echo "ACBR_WIN_STAGING=$ACBR_WIN_STAGING"
echo "(ACBR_LIB_PATH/INI via homolog-acbrlib/.env)"
echo ""

"$WIN_NODE" "$ROOT/scripts/homolog-acbrlib-producao.js" "$@"
