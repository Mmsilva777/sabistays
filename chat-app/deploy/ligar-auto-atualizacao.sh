#!/usr/bin/env bash
# Liga a atualização automática (correr uma vez, como root).
set -euo pipefail
cp /opt/sabistays/chat-app/deploy/sabi-chat-update.service /opt/sabistays/chat-app/deploy/sabi-chat-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sabi-chat-update.timer
echo "Atualização automática ligada: o servidor procura código novo de 10 em 10 minutos."
