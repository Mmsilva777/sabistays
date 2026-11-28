#!/usr/bin/env bash
# Corre de 10 em 10 minutos (sabi-chat-update.timer): se houver código novo no GitHub, atualiza o chat.
set -euo pipefail
cd /opt/sabistays
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git merge -q --ff-only origin/main
  bash chat-app/deploy/atualizar.sh
  echo "Atualizado para $(git rev-parse --short HEAD)."
fi
