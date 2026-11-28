// Armazenamento simples em ficheiros: membros em JSON, mensagens em JSONL (uma por linha).
// Chega para um chat de poucas pessoas e é fácil de copiar como cópia de segurança.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export function newId() {
  return crypto.randomBytes(8).toString("hex");
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.membersFile = path.join(dir, "membros.json");
    this.messagesFile = path.join(dir, "mensagens.jsonl");
    this.usageFile = path.join(dir, "uso-claude.json");
    this._members = this.#readJson(this.membersFile, []);
    this._membersMtime = this.#mtime(this.membersFile);
    this.usage = this.#readJson(this.usageFile, {});
    this.messages = [];
    if (fs.existsSync(this.messagesFile)) {
      for (const line of fs.readFileSync(this.messagesFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.messages.push(JSON.parse(line));
        } catch {
          // linha corrompida (ex.: corte de energia a meio da escrita): ignorar
        }
      }
    }
  }

  #mtime(file) {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }

  // O admin.mjs pode alterar membros.json com o servidor a correr: reler se o ficheiro mudou.
  get members() {
    const mt = this.#mtime(this.membersFile);
    if (mt !== this._membersMtime) {
      this._members = this.#readJson(this.membersFile, this._members);
      this._membersMtime = mt;
    }
    return this._members;
  }

  #readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  #writeJson(file, value) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // ---------- membros ----------

  saveMembers() {
    this.#writeJson(this.membersFile, this._members);
    this._membersMtime = this.#mtime(this.membersFile);
  }

  /** Cria um membro e devolve { member, token }. O token só existe aqui: guardamos apenas o hash. */
  addMember({ name, role, createdBy = null, expiresAt = null }) {
    if (!["socio", "convidado"].includes(role)) throw new Error("papel inválido");
    const clean = String(name || "").trim().slice(0, 40);
    if (!clean) throw new Error("nome em falta");
    const token = newToken();
    const member = {
      id: newId(),
      name: clean,
      role,
      tokenHash: hashToken(token),
      active: true,
      createdAt: new Date().toISOString(),
      createdBy,
      expiresAt,
      // Convidados só veem mensagens a partir do momento em que entram.
      seesFrom: role === "convidado" ? new Date().toISOString() : null,
    };
    this.members.push(member);
    this.saveMembers();
    return { member, token };
  }

  /** Gera um novo link para um membro existente (o antigo deixa de funcionar). */
  resetToken(id) {
    const m = this.members.find((x) => x.id === id);
    if (!m) throw new Error("membro não encontrado");
    const token = newToken();
    m.tokenHash = hashToken(token);
    m.active = true;
    this.saveMembers();
    return { member: m, token };
  }

  setActive(id, active) {
    const m = this.members.find((x) => x.id === id);
    if (!m) throw new Error("membro não encontrado");
    m.active = active;
    this.saveMembers();
    return m;
  }

  findByToken(token) {
    if (!token) return null;
    const h = hashToken(token);
    const m = this.members.find((x) => {
      const a = Buffer.from(x.tokenHash, "hex");
      const b = Buffer.from(h, "hex");
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    if (!m || !m.active) return null;
    if (m.expiresAt && new Date(m.expiresAt) < new Date()) return null;
    return m;
  }

  getMember(id) {
    return this.members.find((x) => x.id === id) || null;
  }

  // ---------- mensagens ----------

  addMessage({ authorId, authorName, kind = "humano", text, replyTo = null, anexo = null }) {
    const msg = {
      id: newId(),
      at: new Date().toISOString(),
      authorId,
      authorName,
      kind, // "humano" | "claude" | "sistema"
      text: String(text).slice(0, 8000),
      replyTo,
    };
    if (anexo) msg.anexo = anexo; // { id, nome, tipo, categoria, tamanho, previas }
    this.messages.push(msg);
    fs.appendFileSync(this.messagesFile, JSON.stringify(msg) + "\n", { mode: 0o600 });
    return msg;
  }

  /** Mensagens que um membro pode ver (convidados: só desde que entraram). */
  visibleTo(member, { before = null, limit = 200 } = {}) {
    let list = this.messages;
    if (member.seesFrom) list = list.filter((m) => m.at >= member.seesFrom);
    if (before) list = list.filter((m) => m.at < before);
    return list.slice(-limit);
  }

  recent(limit) {
    return this.messages.slice(-limit);
  }

  // ---------- uso do Claude (para o limite mensal) ----------

  addUsage(costUsd) {
    const month = new Date().toISOString().slice(0, 7);
    this.usage[month] = (this.usage[month] || 0) + costUsd;
    this.#writeJson(this.usageFile, this.usage);
  }

  monthUsage() {
    return this.usage[new Date().toISOString().slice(0, 7)] || 0;
  }
}
