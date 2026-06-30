#!/usr/bin/env bash
# Gera frontend-dist para o agente local (instalador Windows).
# Uso: ./scripts/build-frontend-dist.sh [production|homolog]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONT_ROOT="${FRONT_ROOT:-$(dirname "$AGENT_ROOT")/margin-engine-front}"
TARGET="${TARGET:-$AGENT_ROOT/frontend-dist}"
ENV="${1:-production}"

if [[ ! -d "$FRONT_ROOT" ]]; then
  echo "ERRO: margin-engine-front não encontrado em $FRONT_ROOT"
  exit 1
fi

case "$ENV" in
  homolog)
    BUILD_CMD="build:pdv-homolog"
    ;;
  production|prod)
    BUILD_CMD="build:pdv-prod"
    ENV="production"
    ;;
  *)
    echo "ERRO: ambiente inválido '$ENV' (use production ou homolog)"
    exit 1
    ;;
esac

echo "==> Build frontend ($ENV) em $FRONT_ROOT"
(cd "$FRONT_ROOT" && npm run "$BUILD_CMD")

echo "==> Copiando dist → $TARGET"
mkdir -p "$TARGET"
rsync -a --delete "$FRONT_ROOT/dist/" "$TARGET/"

echo "OK — frontend-dist ($ENV)"
echo "  API: $(grep -o 'https://[^\"]*' "$TARGET/assets/index-"*.js 2>/dev/null | head -1 || echo 'verifique VITE_API_URL no bundle')"
