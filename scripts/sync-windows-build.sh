#!/usr/bin/env bash
# Sincroniza agente-local → C:\build\pdv-agente (WSL ou Git Bash)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="${BUILD_ROOT:-/mnt/c/build/pdv-agente}"
FRONT_ROOT="${FRONT_ROOT:-$(dirname "$AGENT_ROOT")/margin-engine-front}"
SYNC_FRONT="${SYNC_FRONT:-1}"
FRONT_BUILD_ENV="${FRONT_BUILD_ENV:-production}"

if [[ ! -d "$BUILD_ROOT" ]]; then
  echo "ERRO: pasta de build não encontrada: $BUILD_ROOT"
  echo "Crie C:\\build\\pdv-agente no Windows ou defina BUILD_ROOT."
  exit 1
fi

APP_DEST="$BUILD_ROOT/dist/app"
mkdir -p "$APP_DEST"

echo "==> Gerando manifest.json (SHA-256)..."
(cd "$AGENT_ROOT" && npm run manifest)

RSYNC_EXCLUDES=(
  --exclude node_modules
  --exclude data
  --exclude daemon
  --exclude .env
  --exclude test
  --exclude homolog-acbrlib
  --exclude .git
  --exclude .ai
  --exclude .github
  --exclude 'C:\ProgramData'
  --exclude frontend-dist
  --exclude '*.log'
  --exclude 'RESULTADO-*.md'
)

echo "==> Sincronizando agente → $APP_DEST"
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$AGENT_ROOT/" "$APP_DEST/"

echo "==> Copiando pdv-agente-installer.iss"
cp "$AGENT_ROOT/pdv-agente-installer.iss" "$BUILD_ROOT/pdv-agente-installer.iss"
cp "$AGENT_ROOT/pdv-agente-installer.iss" "$APP_DEST/pdv-agente-installer.iss"

if [[ "$SYNC_FRONT" == "1" ]]; then
  if [[ "${FRONT_REBUILD:-1}" == "1" && -f "$AGENT_ROOT/scripts/build-frontend-dist.sh" ]]; then
    echo "==> Build frontend-dist ($FRONT_BUILD_ENV)"
    FRONT_ROOT="$FRONT_ROOT" TARGET="$AGENT_ROOT/frontend-dist" \
      bash "$AGENT_ROOT/scripts/build-frontend-dist.sh" "$FRONT_BUILD_ENV"
  fi
  if [[ -f "$AGENT_ROOT/frontend-dist/index.html" ]]; then
    echo "==> Sincronizando frontend-dist → $APP_DEST/frontend-dist"
    mkdir -p "$APP_DEST/frontend-dist"
    rsync -a --delete "$AGENT_ROOT/frontend-dist/" "$APP_DEST/frontend-dist/"
  elif [[ -f "$FRONT_ROOT/dist/index.html" ]]; then
    echo "==> Sincronizando frontend-dist ← $FRONT_ROOT/dist (sem rebuild)"
    mkdir -p "$APP_DEST/frontend-dist"
    rsync -a --delete "$FRONT_ROOT/dist/" "$APP_DEST/frontend-dist/"
  else
    echo "AVISO: frontend-dist não atualizado (rode scripts/build-frontend-dist.sh)."
  fi
else
  echo "AVISO: SYNC_FRONT=0 — frontend-dist não sincronizado."
fi

if [[ ! -x "$BUILD_ROOT/dist/node/node.exe" && ! -f "$BUILD_ROOT/dist/node/node.exe" ]]; then
  echo "AVISO: dist/node/node.exe não encontrado — copie Node.js portátil x64 para dist/node/"
fi

if [[ ! -f "$APP_DEST/acbrlib/lib/ACBrNFe64.dll" ]]; then
  echo "AVISO: ACBrNFe64.dll ausente em dist/app/acbrlib/lib/"
fi

VERSION="$(node -p "require('$APP_DEST/package.json').version")"
echo ""
echo "OK — build sincronizado (v$VERSION)"
echo "Próximo passo no Windows (PowerShell como Admin em C:\\build\\pdv-agente):"
echo "  .\\prepare-build.ps1"
echo "Ou compile pdv-agente-installer.iss no Inno Setup 6."
