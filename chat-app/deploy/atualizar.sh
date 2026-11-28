#!/usr/bin/env bash
# Atualiza o chat para a versão mais recente do GitHub, sem mexer na configuração nem nos dados.
# Correr como root:  cd /opt/sabistays && git pull && bash chat-app/deploy/atualizar.sh
set -euo pipefail
cd /opt/sabistays/chat-app
npm ci --omit=dev --no-audit --no-fund
cp deploy/sabi-chat.service /etc/systemd/system/sabi-chat.service
# Atualização automática: o servidor procura código novo no GitHub de 10 em 10 minutos.
cp deploy/sabi-chat-update.service deploy/sabi-chat-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sabi-chat-update.timer >/dev/null 2>&1 || true
systemctl restart sabi-chat
sleep 2
systemctl is-active --quiet sabi-chat && echo "Chat atualizado e a correr." || { echo "!! O chat não arrancou:"; journalctl -u sabi-chat -n 20 --no-pager; exit 1; }
