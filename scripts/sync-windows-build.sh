#!/usr/bin/env bash
# Sincroniza agente-local → C:\build\pdv-agente (WSL ou Git Bash)
# Uso: npm run sync:windows-build
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="${BUILD_ROOT:-/mnt/c/build/pdv-agente}"
FRONT_ROOT="${FRONT_ROOT:-$(dirname "$AGENT_ROOT")/margin-engine-front}"
SYNC_FRONT="${SYNC_FRONT:-1}"
FRONT_BUILD_ENV="${FRONT_BUILD_ENV:-production}"
WIN_BUILD_SCRIPTS="$AGENT_ROOT/build/windows"

mkdir -p "$BUILD_ROOT/dist/app" "$BUILD_ROOT/output"

echo "==> Build root: $BUILD_ROOT"

echo "==> Verificando alinhamento de versão release..."
node "$AGENT_ROOT/scripts/check-release-alignment.js"

echo "==> Sincronizando versão do instalador..."
node "$AGENT_ROOT/scripts/sync-installer-version.js" "$BUILD_ROOT/pdv-agente-installer.iss" 2>/dev/null || \
  node "$AGENT_ROOT/scripts/sync-installer-version.js"

echo "==> Gerando ícone do instalador..."
node "$AGENT_ROOT/scripts/build-installer-icon.js"

RSYNC_EXCLUDES=(
  --exclude node_modules
  --exclude '/data'
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
  # Schemas XSD não vão no git (gitignore data/) — preservar no destino do build
  --exclude 'acbrlib/data/Schemas'
  --exclude 'acbrlib/data/cert'
  --exclude 'acbrlib/data/log'
  --exclude 'acbrlib/data/notas'
  --exclude 'acbrlib/data/pdf'
)

echo "==> Sincronizando agente → $BUILD_ROOT/dist/app"
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$AGENT_ROOT/" "$BUILD_ROOT/dist/app/"

echo "==> Copiando scripts de build Windows"
cp "$AGENT_ROOT/pdv-agente-installer.iss" "$BUILD_ROOT/pdv-agente-installer.iss"
cp "$AGENT_ROOT/LICENSE.txt" "$BUILD_ROOT/LICENSE.txt"
for f in prepare-build.ps1 compile-installer.ps1 validate-build.ps1 deploy-to-installed.ps1 sign-installer.ps1 LEIA-ME.md; do
  if [[ -f "$WIN_BUILD_SCRIPTS/$f" ]]; then
    cp "$WIN_BUILD_SCRIPTS/$f" "$BUILD_ROOT/$f"
  fi
done
cp "$AGENT_ROOT/docs/INSTALADOR-WINDOWS.md" "$BUILD_ROOT/LEIA-ME-INSTALADOR.md"
mkdir -p "$BUILD_ROOT/assets"
cp "$AGENT_ROOT/assets/margin-engine.ico" "$BUILD_ROOT/assets/margin-engine.ico"

if [[ "$SYNC_FRONT" == "1" ]]; then
  if [[ "${FRONT_REBUILD:-1}" == "1" && -f "$AGENT_ROOT/scripts/build-frontend-dist.sh" ]]; then
    echo "==> Build frontend-dist ($FRONT_BUILD_ENV)"
    FRONT_ROOT="$FRONT_ROOT" TARGET="$AGENT_ROOT/frontend-dist" \
      bash "$AGENT_ROOT/scripts/build-frontend-dist.sh" "$FRONT_BUILD_ENV"
  fi
  if [[ -f "$AGENT_ROOT/frontend-dist/index.html" ]]; then
    echo "==> Copiando frontend-dist → dist/app/frontend-dist"
    mkdir -p "$BUILD_ROOT/dist/app/frontend-dist"
    rsync -a --delete "$AGENT_ROOT/frontend-dist/" "$BUILD_ROOT/dist/app/frontend-dist/"
  elif [[ -f "$FRONT_ROOT/dist/index.html" ]]; then
    echo "==> Copiando frontend-dist ← $FRONT_ROOT/dist"
    mkdir -p "$BUILD_ROOT/dist/app/frontend-dist"
    rsync -a --delete "$FRONT_ROOT/dist/" "$BUILD_ROOT/dist/app/frontend-dist/"
  else
    echo "AVISO: frontend-dist não atualizado"
  fi
else
  echo "AVISO: SYNC_FRONT=0"
fi

echo "==> Gerando manifest.json (SHA-256, agente + frontend-dist)..."
(cd "$AGENT_ROOT" && npm run manifest)
cp "$AGENT_ROOT/manifest.json" "$BUILD_ROOT/dist/app/manifest.json"

# ── Validações obrigatórias ───────────────────────────────────────────────────
FAIL=0
check() {
  if [[ ! -e "$1" ]]; then
    echo "ERRO: ausente — $2"
    echo "       $1"
    FAIL=1
  else
    echo "OK — $2"
  fi
}

check "$BUILD_ROOT/dist/app/acbrlib/lib/ACBrNFe64.dll" "ACBrNFe64.dll"
check "$BUILD_ROOT/dist/app/acbrlib/lib/ACBrNFSe64.dll" "ACBrNFSe64.dll (NFS-e)"
check "$BUILD_ROOT/dist/app/posprinter/lib/ACBrPosPrinter64.dll" "ACBrPosPrinter64.dll"
check "$BUILD_ROOT/dist/app/print/printerBootstrap.js" "printerBootstrap (auto-detect)"
check "$BUILD_ROOT/dist/app/fiscal/nfse/nfseLib.js" "fiscal/nfse/nfseLib.js"

# Schemas ficam fora do git no rsync principal — preserva destino e completa do repo/instalação
SCHEMA_DIR="$BUILD_ROOT/dist/app/acbrlib/data/Schemas"
SCHEMA_COUNT="$(find "$SCHEMA_DIR" -maxdepth 2 -name '*.xsd' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "${SCHEMA_COUNT:-0}" -lt 10 ]]; then
  for CANDIDATE in \
    "/mnt/c/Program Files/Margin Engine/app/acbrlib/data/Schemas" \
    "/mnt/c/Program Files (x86)/Margin Engine/app/acbrlib/data/Schemas"; do
    if [[ -d "$CANDIDATE" ]]; then
      echo "==> Restaurando Schemas a partir de: $CANDIDATE"
      mkdir -p "$SCHEMA_DIR"
      rsync -a "$CANDIDATE/" "$SCHEMA_DIR/"
      break
    fi
  done
  SCHEMA_COUNT="$(find "$SCHEMA_DIR" -maxdepth 2 -name '*.xsd' 2>/dev/null | wc -l | tr -d ' ')"
fi
if [[ "${SCHEMA_COUNT:-0}" -lt 10 ]]; then
  echo "ERRO: acbrlib/data/Schemas incompleto ($SCHEMA_COUNT .xsd)"
  FAIL=1
else
  echo "OK — schemas XSD: $SCHEMA_COUNT"
fi

# NFS-e: schemas municipais (excluídos do rsync principal por data/Schemas)
NFSE_SRC="$AGENT_ROOT/acbrlib/data/Schemas/NFSe"
NFSE_DST="$SCHEMA_DIR/NFSe"
if [[ -d "$NFSE_SRC" ]]; then
  echo "==> Sincronizando schemas NFS-e → dist/app/acbrlib/data/Schemas/NFSe"
  mkdir -p "$NFSE_DST"
  rsync -a "$NFSE_SRC/" "$NFSE_DST/"
fi
NFSE_XSD="$(find "$NFSE_DST" -name '*.xsd' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "${NFSE_XSD:-0}" -lt 50 ]]; then
  echo "ERRO: schemas NFS-e incompletos ($NFSE_XSD .xsd) — esperado >= 50"
  FAIL=1
else
  echo "OK — schemas NFS-e: $NFSE_XSD"
fi

# Pacote npm declarado (node_modules completo vem no prepare-build.ps1 / npm ci)
if grep -q '"@projetoacbr/acbrlib-nfse-node"' "$BUILD_ROOT/dist/app/package.json" 2>/dev/null; then
  echo "OK — package.json declara @projetoacbr/acbrlib-nfse-node"
else
  echo "ERRO: package.json sem @projetoacbr/acbrlib-nfse-node"
  FAIL=1
fi

if [[ -f "$BUILD_ROOT/dist/app/frontend-dist/index.html" ]]; then
  echo "OK — frontend-dist"
else
  echo "AVISO: frontend-dist/index.html ausente"
fi

if [[ -f "$BUILD_ROOT/dist/node/node.exe" ]]; then
  echo "OK — Node portátil"
else
  echo "AVISO: dist/node/node.exe ausente — extraia Node x64 em dist/node/"
fi

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi

VERSION="$(node -p "require('$BUILD_ROOT/dist/app/package.json').version")"
echo ""
echo "======================================================"
echo "  Sync concluído — v$VERSION"
echo "======================================================"
echo "Próximo passo (PowerShell em C:\\build\\pdv-agente):"
echo "  .\\validate-build.ps1"
echo "  .\\prepare-build.ps1 -Compile"
echo "======================================================"
