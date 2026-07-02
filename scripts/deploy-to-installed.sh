#!/usr/bin/env bash
# Atualiza instalação Windows preservando .env, data/, INIs e node_modules locais.
# Uso: ./scripts/deploy-to-installed.sh
set -euo pipefail

SRC="${SRC:-/mnt/c/build/pdv-agente/dist/app}"
DEST="${DEST:-/mnt/c/Program Files/Margin Engine/app}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${DEST}/.backup-${TS}"

if [[ ! -d "$SRC" ]]; then
  echo "ERRO: build não encontrado em $SRC — rode npm run sync:windows-build"
  exit 1
fi
if [[ ! -d "$DEST" ]]; then
  echo "ERRO: instalação não encontrada em $DEST"
  exit 1
fi

echo "==> Origem:  $SRC"
echo "==> Destino: $DEST"
echo "==> Backup:  $BACKUP_DIR"

mkdir -p "$BACKUP_DIR"
[[ -f "$DEST/.env" ]] && cp -a "$DEST/.env" "$BACKUP_DIR/.env"
[[ -d "$DEST/data" ]] && cp -a "$DEST/data" "$BACKUP_DIR/data"
[[ -f "$DEST/acbrlib/data/config/acbrlib.ini" ]] && \
  mkdir -p "$BACKUP_DIR/acbrlib-config" && \
  cp -a "$DEST/acbrlib/data/config/acbrlib.ini" "$BACKUP_DIR/acbrlib-config/acbrlib.ini"

RSYNC_EXCLUDES=(
  --exclude '.env'
  --exclude '/data'
  --exclude 'node_modules'
  --exclude 'acbrlib/data/config/acbrlib.ini'
  --exclude '.backup-*'
  --exclude '*.db'
  --exclude '*.db-shm'
  --exclude '*.db-wal'
)

echo "==> Sincronizando código (preservando configurações)..."
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$SRC/" "$DEST/"

# frontend-dist explícito
if [[ -d "$SRC/frontend-dist" ]]; then
  echo "==> Atualizando frontend-dist..."
  rsync -a --delete "$SRC/frontend-dist/" "$DEST/frontend-dist/"
fi

# Restaura INI fiscal se o rsync tocou na pasta config
if [[ -f "$BACKUP_DIR/acbrlib-config/acbrlib.ini" ]]; then
  mkdir -p "$DEST/acbrlib/data/config"
  cp -a "$BACKUP_DIR/acbrlib-config/acbrlib.ini" "$DEST/acbrlib/data/config/acbrlib.ini"
fi

echo ""
echo "======================================================"
echo "  Deploy concluído"
echo "======================================================"
echo "Preservados: .env, data/, acbrlib.ini, node_modules"
echo "Backup em:   $BACKUP_DIR"
echo ""
echo "Reinicie o serviço do agente no Windows."
echo "======================================================"
