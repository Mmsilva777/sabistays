# Chat Sabi Stays

Chat privado dos sócios da Sabi Stays, com convidados quando é preciso e o Claude como assistente.
Funciona no navegador do telemóvel ou do computador e pode instalar-se como app no ecrã inicial.

## Como funciona

- **Sócios** (Marco, Lisa, Fernando): cada um recebe um link pessoal. Abre-o uma vez e fica com sessão iniciada nesse dispositivo. Não há palavras-passe.
- **Convidados** (advogado, contabilista, fornecedor, proprietário): qualquer sócio cria um link no botão de membros, com prazo (7, 30, 90 dias ou sem prazo). O convidado só vê as mensagens a partir do momento em que entra. O acesso pode ser retirado a qualquer momento.
- **Claude**: lê a conversa, mas só responde quando alguém escreve **@claude** (ou toca no botão @claude). Tem em conta as últimas 120 mensagens e as notas em "O que o Claude sabe", que os sócios editam no painel de membros. Pode pesquisar na web quando a pergunta o pede (leis, voos, preços).
- As mensagens ficam guardadas no vosso servidor (`/var/lib/sabi-chat`). Para fazer cópia de segurança, basta copiar essa pasta.

## Custos

- Servidor: o VPS Hetzner que já têm (o chat é leve e cabe ao lado do site).
- Claude: pago por uso na API da Anthropic. Cada resposta custa em média 5 a 10 cêntimos (mais se pesquisar na web). Com uso normal entre sócios, contem com 5 a 20 € por mês.
- Há dois travões: o limite mensal do chat (`CLAUDE_LIMITE_MENSAL_USD`, 25 USD por omissão; o gasto aparece no painel de membros) e o limite de gasto que se define na própria consola da Anthropic.

## Instalar no servidor (uma vez, cerca de 20 minutos)

1. **Chave da API**: em https://console.anthropic.com criar conta, adicionar um cartão em *Billing*, definir um limite mensal em *Limits* e criar uma chave em *API keys*. A chave começa por `sk-ant-`. Não a partilhem no chat nem por email.
2. **DNS**: onde compraram `sabistays-sal.com`, criar um registo **A** com o nome `chat` a apontar para o IP do VPS Hetzner (está no painel da Hetzner).
3. **Servidor**: entrar por SSH (`ssh root@<IP do servidor>`) e correr:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/mmsilva777/sabistays/main/chat-app/deploy/instalar.sh | bash
   ```
   O script instala o Node.js e o Caddy (HTTPS automático), descarrega o código, cria o serviço e liga o endereço `chat.sabistays-sal.com`.
4. **Colar a chave**: `nano /etc/sabi-chat.env`, preencher `ANTHROPIC_API_KEY=`, guardar e `systemctl restart sabi-chat`.
5. **Criar os sócios**:
   ```bash
   sabi-chat novo-socio "Marco"
   sabi-chat novo-socio "Lisa"
   sabi-chat novo-socio "Fernando"
   ```
   Cada comando mostra um link. Enviem cada link só à pessoa respetiva.

Se o servidor já tiver um Caddyfile com o site, o script acrescenta só o bloco do chat (ver `deploy/Caddyfile.exemplo`).

### Quando as portas 80/443 já são de um Caddy em Docker (caso do VPS da Sabi Stays)

No VPS atual, o projeto guesttv (em `/opt/guesttv`, Docker Compose) já tem um Caddy em Docker com as portas da web. Nesse caso:

1. Desligar o Caddy do sistema: `systemctl disable --now caddy`.
2. Pôr o chat a ouvir no gateway da rede Docker do guesttv (`docker network inspect guesttv_internal` mostra o Gateway, ex. 172.18.0.1): em `/etc/sabi-chat.env`, `HOST=172.18.0.1`, e `systemctl restart sabi-chat`.
3. Acrescentar ao `/opt/guesttv/Caddyfile` o bloco de `deploy/Caddyfile.exemplo`, com `reverse_proxy 172.18.0.1:8787`.
4. Com o ufw ativo, deixar a rede Docker chegar ao chat: `ufw allow in on br-<id da rede> to 172.18.0.1 port 8787 proto tcp`.
5. Recarregar: `docker exec -w /etc/caddy guesttv-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.

## Gestão no dia a dia

| Para quê | Comando no servidor |
| --- | --- |
| Ver membros | `sabi-chat lista` |
| Link novo para alguém que mudou de telemóvel | `sabi-chat novo-link <id>` |
| Retirar ou devolver o acesso | `sabi-chat desativar <id>` / `sabi-chat ativar <id>` |
| Atualizar o chat para a versão mais recente | `bash /opt/sabistays/chat-app/deploy/instalar.sh` |
| Ver erros | `journalctl -u sabi-chat -n 50` |

Os convidados também se gerem diretamente no chat (botão de membros, no canto superior direito).

## Experimentar no computador

```bash
cd chat-app
npm install
node admin.mjs novo-socio "Marco"      # mostra o link
ANTHROPIC_API_KEY=sk-ant-... node server.mjs
```
Abrir o link mostrado (http://localhost:8787/entrar#...).

## Ficheiros

- `server.mjs`: servidor (Node, sem frameworks). Mensagens em tempo real por Server-Sent Events.
- `lib/claude.mjs`: ligação ao Claude (modelo `claude-opus-5-5`, contexto do negócio em cache, pesquisa web, limite de gasto).
- `lib/store.mjs`: membros e mensagens em ficheiros na pasta de dados.
- `admin.mjs`: comandos de gestão de membros.
- `contexto-exemplo.md`: notas iniciais do Claude; no servidor passam para `data/contexto.md` e editam-se no chat.
- `public/`: a app (HTML, CSS, JS).
- `deploy/`: instalação no servidor (script, serviço systemd, Caddy, exemplo de configuração).
