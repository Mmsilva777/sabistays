// Chat interno da Sabi Stays: sócios, convidados e o Claude quando chamado com @claude.
// Sem frameworks: Node puro + a SDK da Anthropic. Mensagens em tempo real por Server-Sent Events.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./lib/store.mjs";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeBot, MODEL, estimateCost } from "./lib/claude.mjs";
import { Arquivo, arquivarLote } from "./lib/arquivo.mjs";
import { Ficheiros, MAX_MB, TOTAL_MB } from "./lib/ficheiros.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DADOS || path.join(here, "data");
const CONTEXT_FILE = process.env.CONTEXTO || path.join(DATA_DIR, "contexto.md");
const MONTHLY_LIMIT_USD = Number(process.env.CLAUDE_LIMITE_MENSAL_USD || 25);
const COOKIE = "sabi_chat";
const PUBLIC_DIR = path.join(here, "public");

const store = new Store(DATA_DIR);
// Na primeira arrancada, copiar o contexto de exemplo para a pasta de dados (editável pelos sócios).
if (!fs.existsSync(CONTEXT_FILE)) {
  fs.copyFileSync(path.join(here, "contexto-exemplo.md"), CONTEXT_FILE);
}
const arquivo = new Arquivo(DATA_DIR);
const ficheiros = new Ficheiros(DATA_DIR);
const claude = new ClaudeBot({ store, contextFile: CONTEXT_FILE, arquivo, ficheiros });
// Arquivo automático: corre quando há ARQUIVO_LOTE mensagens novas ou ao fim de ARQUIVO_PAUSA_MIN minutos sem conversa.
const ARQUIVO_LOTE = Number(process.env.ARQUIVO_LOTE || 25);
const ARQUIVO_PAUSA_MIN = Number(process.env.ARQUIVO_PAUSA_MIN || 10);

// ---------- utilitários HTTP ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

const MEDIA_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https" || (process.env.URL_PUBLICO || "").startsWith("https://");
}

async function readJson(req, limit = 20_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("pedido demasiado grande"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("JSON inválido"), { status: 400 });
  }
}

// Pedidos que mudam dados têm de vir da própria página (proteção CSRF).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] !== "cross-site";
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function currentMember(req) {
  return store.findByToken(parseCookies(req)[COOKIE]);
}

function publicMember(m, full = false) {
  const base = { id: m.id, name: m.name, role: m.role };
  if (!full) return base;
  return { ...base, active: m.active, createdAt: m.createdAt, expiresAt: m.expiresAt };
}

function inviteLink(req, token) {
  const base = process.env.URL_PUBLICO || `${isHttps(req) ? "https" : "http"}://${req.headers.host}`;
  return `${base.replace(/\/$/, "")}/entrar#${token}`;
}

// ---------- limites simples ----------

const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

// ---------- tempo real (SSE) ----------

const clients = new Set(); // { res, member }

function broadcast(event, data, filter = () => true) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (!filter(c.member)) continue;
    c.res.write(payload);
  }
}

function broadcastMessage(msg) {
  // Convidados só recebem mensagens posteriores à sua entrada (todas as novas são).
  broadcast("mensagem", msg, (m) => !m.seesFrom || msg.at >= m.seesFrom);
}

function broadcastPresence() {
  const online = [...new Set([...clients].map((c) => c.member.id))];
  broadcast("presenca", { online });
}

setInterval(() => {
  for (const c of clients) c.res.write(": ping\n\n");
  // Desligar quem foi desativado entretanto.
  for (const c of clients) {
    const fresh = store.getMember(c.member.id);
    if (!fresh || !fresh.active || (fresh.expiresAt && new Date(fresh.expiresAt) < new Date())) {
      c.res.end();
      clients.delete(c);
    }
  }
}, 25_000).unref();

// ---------- Claude ----------

let claudeQueue = Promise.resolve();

function handleClaude(trigger, asker) {
  if (!claude.enabled) {
    const msg = store.addMessage({
      authorId: null,
      authorName: "Sistema",
      kind: "sistema",
      text: "O Claude ainda não está ligado: falta configurar a chave da API no servidor (ver LEIA-ME).",
    });
    broadcastMessage(msg);
    return;
  }
  if (store.monthUsage() >= MONTHLY_LIMIT_USD) {
    const msg = store.addMessage({
      authorId: null,
      authorName: "Sistema",
      kind: "sistema",
      text: `O Claude atingiu o limite de gasto deste mês (${MONTHLY_LIMIT_USD} USD). Volta no início do próximo mês, ou aumentem o limite no servidor.`,
    });
    broadcastMessage(msg);
    return;
  }
  if (rateLimited(`claude:${asker.id}`, 20, 60 * 60_000)) {
    const msg = store.addMessage({
      authorId: null,
      authorName: "Sistema",
      kind: "sistema",
      text: `${asker.name}, chamaste o Claude muitas vezes na última hora. Tenta daqui a pouco.`,
    });
    broadcastMessage(msg);
    return;
  }
  claudeQueue = claudeQueue.then(async () => {
    broadcast("claude", { escrevendo: true });
    try {
      const { text, costUsd } = await claude.reply(trigger, asker);
      store.addUsage(costUsd);
      const msg = store.addMessage({ authorId: "claude", authorName: "Claude", kind: "claude", text, replyTo: trigger.id });
      broadcastMessage(msg);
      agendarArquivo();
    } catch (err) {
      console.error("Erro do Claude:", err?.status, err?.message);
      const msg = store.addMessage({
        authorId: null,
        authorName: "Sistema",
        kind: "sistema",
        text: "O Claude não conseguiu responder agora (erro na ligação à API). Tentem outra vez daqui a pouco.",
      });
      broadcastMessage(msg);
    } finally {
      broadcast("claude", { escrevendo: false });
    }
  });
}

// ---------- arquivo automático por temas ----------

let arquivando = false;
let arquivoTimer = null;
const arquivoClient = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

async function correrArquivo(motivo) {
  if (!arquivoClient || arquivando) return;
  if (store.monthUsage() >= MONTHLY_LIMIT_USD) return;
  arquivando = true;
  try {
    // Em lotes de 80 mensagens, até não haver pendentes.
    for (let volta = 0; volta < 20; volta++) {
      const pendentes = arquivo.pendentes(store.messages);
      if (!pendentes.length) break;
      const lote = pendentes.slice(0, 80);
      const idx = store.messages.findIndex((m) => m.id === lote[0].id);
      const anterior = store.messages.slice(Math.max(0, idx - 10), idx).filter((m) => m.kind !== "sistema");
      const { resultado, usage } = await arquivarLote({ client: arquivoClient, model: MODEL, arquivo, lote, contextoAnterior: anterior });
      store.addUsage(estimateCost(usage));
      arquivo.aplicar(resultado, lote);
      const temas = Object.fromEntries(lote.map((m) => [m.id, arquivo.temasDe(m.id)]));
      broadcast("arquivo", { temas }, (m) => m.role === "socio");
    }
    console.log(`Arquivo atualizado (${motivo}).`);
  } catch (err) {
    console.error("Erro no arquivo:", err?.status, err?.message);
  } finally {
    arquivando = false;
  }
}

function agendarArquivo() {
  if (!arquivoClient) return;
  clearTimeout(arquivoTimer);
  if (arquivo.pendentes(store.messages).length >= ARQUIVO_LOTE) {
    correrArquivo("lote cheio");
    return;
  }
  arquivoTimer = setTimeout(() => correrArquivo("pausa na conversa"), ARQUIVO_PAUSA_MIN * 60_000);
  arquivoTimer.unref?.();
}

// Ao arrancar, arquivar o que tenha ficado pendente.
setTimeout(() => {
  if (arquivo.pendentes(store.messages).length) correrArquivo("arranque");
}, 15_000).unref();

// ---------- ficheiros: servir com suporte a Range (para vídeos) ----------

function podeVerFicheiro(me, f) {
  if (!f) return false;
  if (!f.mensagemId) return f.autorId === me.id; // ainda não publicado: só quem enviou
  const msg = store.messages.find((m) => m.id === f.mensagemId);
  if (!msg) return false;
  return !me.seesFrom || msg.at >= me.seesFrom;
}

function servirFicheiro(req, res, file, tipo, nome, inline) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return send(res, 404, { erro: "ficheiro não encontrado" });
  }
  const headers = {
    ...SECURITY_HEADERS,
    "Content-Type": tipo,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(nome)}`,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    if (start < 0) start = 0;
    if (start >= stat.size || end < start) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  fs.createReadStream(file).pipe(res);
}

// ---------- rotas ----------

async function api(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (method !== "GET" && !sameOrigin(req)) return send(res, 403, { erro: "origem não permitida" });

  if (p === "/api/entrar" && method === "POST") {
    if (rateLimited(`login:${req.socket.remoteAddress}`, 20, 15 * 60_000)) return send(res, 429, { erro: "demasiadas tentativas" });
    const { token } = await readJson(req);
    const m = store.findByToken(String(token || ""));
    if (!m) return send(res, 401, { erro: "link inválido ou expirado" });
    const maxAge = m.expiresAt ? Math.max(60, Math.floor((new Date(m.expiresAt) - Date.now()) / 1000)) : 60 * 60 * 24 * 365;
    const cookie = `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
    return send(res, 200, { ok: true, membro: publicMember(m) }, { "Set-Cookie": cookie });
  }

  if (p === "/api/sair" && method === "POST") {
    return send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  const me = currentMember(req);
  if (!me) return send(res, 401, { erro: "sessão em falta" });

  if (p === "/api/eu" && method === "GET") {
    return send(res, 200, { membro: publicMember(me), claude: claude.enabled, maxMb: MAX_MB });
  }

  if (p === "/api/mensagens" && method === "GET") {
    const before = url.searchParams.get("antes");
    let mensagens = store.visibleTo(me, { before, limit: 150 });
    if (me.role === "socio") mensagens = mensagens.map((m) => ({ ...m, temas: arquivo.temasDe(m.id) }));
    return send(res, 200, { mensagens });
  }

  if (p === "/api/mensagens" && method === "POST") {
    if (rateLimited(`msg:${me.id}`, 40, 60_000)) return send(res, 429, { erro: "estás a enviar mensagens demasiado depressa" });
    const { texto, anexo: anexoId } = await readJson(req);
    const text = String(texto || "").trim();
    let anexo = null;
    if (anexoId) {
      const f = ficheiros.get(String(anexoId));
      if (!f || f.autorId !== me.id || f.mensagemId) return send(res, 400, { erro: "anexo inválido" });
      anexo = ficheiros.publico(f);
    }
    if (!text && !anexo) return send(res, 400, { erro: "mensagem vazia" });
    if (text.length > 8000) return send(res, 400, { erro: "mensagem demasiado longa" });
    const msg = store.addMessage({ authorId: me.id, authorName: me.name, text, anexo });
    if (anexo) ficheiros.ligarMensagem(anexo.id, msg.id);
    broadcastMessage(msg);
    if (ClaudeBot.isMention(text)) handleClaude(msg, me);
    agendarArquivo();
    return send(res, 201, { mensagem: msg });
  }

  if (p === "/api/eventos" && method === "GET") {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const client = { res, member: me };
    clients.add(client);
    broadcastPresence();
    req.on("close", () => {
      clients.delete(client);
      broadcastPresence();
    });
    return;
  }

  // ----- ficheiros -----
  if (p === "/api/ficheiros" && method === "POST") {
    if (rateLimited(`up:${me.id}`, 30, 10 * 60_000)) return send(res, 429, { erro: "demasiados envios; espera um pouco" });
    const nome = decodeURIComponent(String(req.headers["x-nome"] || "ficheiro"));
    const f = await ficheiros.receber(req, { nome, tipo: req.headers["content-type"], autorId: me.id });
    return send(res, 201, { ficheiro: ficheiros.publico(f) });
  }
  let fm = p.match(/^\/api\/ficheiros\/([a-f0-9]{16})\/previa$/);
  if (fm && method === "POST") {
    const f = await ficheiros.receberPrevia(req, fm[1], me.id);
    return send(res, 201, { ficheiro: ficheiros.publico(f) });
  }
  fm = p.match(/^\/api\/ficheiros\/([a-f0-9]{16})(?:\/previa\/(\d))?$/);
  if (fm && (method === "GET" || method === "HEAD")) {
    const f = ficheiros.get(fm[1]);
    if (!podeVerFicheiro(me, f)) return send(res, 404, { erro: "ficheiro não encontrado" });
    if (fm[2] !== undefined) {
      const n = Number(fm[2]);
      if (!f.previas.some((x) => x.n === n)) return send(res, 404, { erro: "sem pré-visualização" });
      return servirFicheiro(req, res, ficheiros.caminhoPrevia(f.id, n), "image/jpeg", `previa-${n}.jpg`, true);
    }
    const ext = path.extname(f.nome).toLowerCase();
    const seguro = MEDIA_MIME[ext];
    const download = url.searchParams.has("descarregar") || !seguro;
    return servirFicheiro(req, res, ficheiros.caminho(f.id), seguro || "application/octet-stream", f.nome, !download);
  }

  if (p === "/api/membros" && method === "GET") {
    const list = me.role === "socio" ? store.members : store.members.filter((m) => m.active);
    return send(res, 200, { membros: list.map((m) => publicMember(m, me.role === "socio")) });
  }

  // ----- a partir daqui, só sócios -----
  if (me.role !== "socio") return send(res, 403, { erro: "só os sócios podem fazer isto" });

  if (p === "/api/convidados" && method === "POST") {
    const { nome, dias } = await readJson(req);
    const days = Math.min(365, Math.max(0, Number(dias) || 0));
    const expiresAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    let created;
    try {
      created = store.addMember({ name: nome, role: "convidado", createdBy: me.id, expiresAt });
    } catch (e) {
      return send(res, 400, { erro: e.message });
    }
    const sys = store.addMessage({
      authorId: null,
      authorName: "Sistema",
      kind: "sistema",
      text: `${me.name} convidou ${created.member.name} para o chat${days ? ` (acesso por ${days} dias)` : ""}. Os convidados só veem as mensagens a partir de agora.`,
    });
    broadcastMessage(sys);
    return send(res, 201, { membro: publicMember(created.member, true), link: inviteLink(req, created.token) });
  }

  const m = p.match(/^\/api\/membros\/([a-f0-9]{16})\/(desativar|ativar|novo-link)$/);
  if (m && method === "POST") {
    const target = store.getMember(m[1]);
    if (!target) return send(res, 404, { erro: "membro não encontrado" });
    // Pelo chat só se gerem convidados; os sócios gerem-se no servidor (admin.mjs).
    if (target.role !== "convidado") return send(res, 403, { erro: "os sócios gerem-se no servidor" });
    if (m[2] === "novo-link") {
      const { token } = store.resetToken(target.id);
      return send(res, 200, { link: inviteLink(req, token) });
    }
    store.setActive(target.id, m[2] === "ativar");
    if (m[2] === "desativar") {
      for (const c of clients) if (c.member.id === target.id) { c.res.end(); clients.delete(c); }
      const sys = store.addMessage({ authorId: null, authorName: "Sistema", kind: "sistema", text: `${me.name} retirou o acesso a ${target.name}.` });
      broadcastMessage(sys);
    }
    return send(res, 200, { membro: publicMember(target, true) });
  }

  if (p === "/api/contexto" && method === "GET") {
    return send(res, 200, { texto: fs.existsSync(CONTEXT_FILE) ? fs.readFileSync(CONTEXT_FILE, "utf8") : "" });
  }

  if (p === "/api/contexto" && method === "PUT") {
    const { texto } = await readJson(req, 120_000);
    const t = String(texto || "");
    if (t.length > 100_000) return send(res, 400, { erro: "texto demasiado longo" });
    fs.writeFileSync(CONTEXT_FILE + ".tmp", t, { mode: 0o600 });
    fs.renameSync(CONTEXT_FILE + ".tmp", CONTEXT_FILE);
    const sys = store.addMessage({ authorId: null, authorName: "Sistema", kind: "sistema", text: `${me.name} atualizou o que o Claude sabe sobre a Sabi Stays.` });
    broadcastMessage(sys);
    return send(res, 200, { ok: true });
  }

  // ----- arquivo por temas (só sócios) -----
  if (p === "/api/arquivo" && method === "GET") {
    return send(res, 200, arquivo.resumoTemas(store.messages));
  }
  if (p === "/api/arquivo/agora" && method === "POST") {
    if (!arquivoClient) return send(res, 400, { erro: "falta a chave da API" });
    if (arquivando) return send(res, 409, { erro: "o arquivo já está a ser atualizado" });
    correrArquivo("pedido de " + me.name);
    return send(res, 202, { ok: true });
  }
  if (p === "/api/arquivo/temas" && method === "POST") {
    const { nome } = await readJson(req);
    try {
      return send(res, 201, { tema: arquivo.addTema(nome) });
    } catch (e) {
      return send(res, 400, { erro: e.message });
    }
  }
  if (p === "/api/arquivo/pesquisa" && method === "GET") {
    return send(res, 200, arquivo.pesquisar(url.searchParams.get("q"), store.messages));
  }
  const am = p.match(/^\/api\/arquivo\/temas\/([a-z0-9-]{1,40})(\.md)?$/);
  if (am && method === "GET") {
    if (am[2]) {
      const md = arquivo.markdown(am[1], store.messages);
      if (!md) return send(res, 404, { erro: "tema não encontrado" });
      return send(res, 200, md, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="sabi-arquivo-${am[1]}.md"`,
      });
    }
    const t = arquivo.tema(am[1], store.messages);
    if (!t) return send(res, 404, { erro: "tema não encontrado" });
    return send(res, 200, { tema: t });
  }

  if (p === "/api/ficheiros-uso" && method === "GET") {
    return send(res, 200, { usadoMb: Math.round(ficheiros.usadoBytes() / 1048576), totalMb: TOTAL_MB, maxMb: MAX_MB });
  }

  if (p === "/api/claude/uso" && method === "GET") {
    return send(res, 200, { mesUsd: Number(store.monthUsage().toFixed(2)), limiteUsd: MONTHLY_LIMIT_USD });
  }

  return send(res, 404, { erro: "não encontrado" });
}

function serveStatic(req, res, url) {
  let p = url.pathname;
  if (p === "/" || p === "/entrar") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, "não encontrado");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "não encontrado");
    const ext = path.extname(file);
    const cache = ext === ".html" || ext === ".webmanifest" ? "no-cache" : "public, max-age=86400";
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "método não permitido");
    return serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { erro: err.status ? err.message : "erro interno" });
    if (!err.status) console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Chat Sabi Stays a correr em http://${HOST}:${PORT}`);
  console.log(claude.enabled ? `Claude ligado (limite mensal ${MONTHLY_LIMIT_USD} USD).` : "Claude desligado: falta ANTHROPIC_API_KEY.");
  if (!store.members.some((m) => m.role === "socio")) {
    console.log("Ainda não há sócios. Crie o primeiro com: node admin.mjs novo-socio \"Nome\"");
  }
});
