#!/usr/bin/env bash
# Instala o chat Sabi Stays num servidor Ubuntu (ex.: o VPS Hetzner). Correr como root:
#   curl -fsSL https://raw.githubusercontent.com/mmsilva777/sabistays/main/chat-app/deploy/instalar.sh | bash
# ou, com o repositório já clonado:  bash /opt/sabistays/chat-app/deploy/instalar.sh
set -euo pipefail

REPO=https://github.com/mmsilva777/sabistays.git
DIR=/opt/sabistays

echo "== 1. Node.js 22 e Caddy"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
apt-get install -y git

echo "== 2. Código"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR/chat-app"
npm ci --omit=dev

echo "== 3. Utilizador e pasta de dados"
id sabichat >/dev/null 2>&1 || useradd --system --home /var/lib/sabi-chat --shell /usr/sbin/nologin sabichat
install -d -o sabichat -g sabichat -m 700 /var/lib/sabi-chat

echo "== 4. Configuração"
if [ ! -f /etc/sabi-chat.env ]; then
  install -m 640 -o root -g sabichat deploy/sabi-chat.env.exemplo /etc/sabi-chat.env
  echo ">> Edite /etc/sabi-chat.env e cole a ANTHROPIC_API_KEY (nano /etc/sabi-chat.env)."
fi
# Atalho para gerir membros:  sabi-chat novo-socio "Marco"
cat > /usr/local/bin/sabi-chat <<'SH'
#!/bin/sh
cd /opt/sabistays/chat-app && exec sudo -u sabichat node --env-file=/etc/sabi-chat.env admin.mjs "$@"
SH
chmod 755 /usr/local/bin/sabi-chat
cp deploy/sabi-chat.service /etc/systemd/system/sabi-chat.service
systemctl daemon-reload
systemctl enable --now sabi-chat
systemctl restart sabi-chat

# Se as portas da web já forem de outro programa (ex.: um Caddy em Docker), não usar o Caddy do sistema.
if ss -tlnp 2>/dev/null | grep -E ':(80|443) ' | grep -vq caddy; then
  systemctl disable --now caddy >/dev/null 2>&1 || true
  echo ">> As portas 80/443 já estão ocupadas por outro programa. Ponha o chat atrás desse proxy (ver LEIA-ME, secção Docker)."
else
  if ! grep -q "chat.sabistays-sal.com" /etc/caddy/Caddyfile 2>/dev/null; then
    printf '\n' >> /etc/caddy/Caddyfile
    cat deploy/Caddyfile.exemplo >> /etc/caddy/Caddyfile
  fi
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload-or-restart caddy || echo "!! O Caddy não arrancou. Veja: journalctl -u caddy -n 30 --no-pager"
fi

echo
echo "Pronto. Falta:"
echo " - DNS: registo A  chat.sabistays-sal.com -> IP deste servidor"
echo " - Criar os sócios:  sabi-chat novo-socio \"Marco\"   (repetir para Lisa e Fernando)"
