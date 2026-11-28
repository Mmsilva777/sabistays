// Ficheiros enviados no chat: guardados em disco (sem passar pela memória), com pré-visualizações
// em JPEG geradas no navegador (fotos reduzidas e imagens de vídeos), e preparação para o Claude analisar.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export const MAX_MB = Number(process.env.FICHEIROS_MAX_MB || 50);
export const TOTAL_MB = Number(process.env.FICHEIROS_TOTAL_MB || 3000);
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;
const MAX_PREVIEWS = 6;

const IMG_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".tsv", ".xml", ".html", ".htm", ".log", ".ics", ".vcf"]);

export function categoria(nome, tipo) {
  const ext = path.extname(nome).toLowerCase();
  if (tipo.startsWith("image/") || [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"].includes(ext)) return "imagem";
  if (tipo.startsWith("video/") || [".mp4", ".mov", ".webm", ".m4v", ".3gp"].includes(ext)) return "video";
  if (tipo === "application/pdf" || ext === ".pdf") return "pdf";
  if (tipo.includes("zip") || ext === ".zip") return "zip";
  if (tipo.startsWith("text/") || TEXT_EXT.has(ext)) return "texto";
  return "outro";
}

export class Ficheiros {
  constructor(dir) {
    this.dir = path.join(dir, "ficheiros");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.metaFile = path.join(dir, "ficheiros.json");
    try {
      this.meta = JSON.parse(fs.readFileSync(this.metaFile, "utf8"));
    } catch {
      this.meta = {};
    }
  }

  save() {
    const tmp = this.metaFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.meta), { mode: 0o600 });
    fs.renameSync(tmp, this.metaFile);
  }

  usadoBytes() {
    return Object.values(this.meta).reduce((s, f) => s + f.tamanho + (f.previas || []).reduce((a, p) => a + p.tamanho, 0), 0);
  }

  get(id) {
    return /^[a-f0-9]{16}$/.test(id) ? this.meta[id] || null : null;
  }

  caminho(id) {
    return path.join(this.dir, id);
  }

  caminhoPrevia(id, n) {
    return path.join(this.dir, `${id}.p${n}.jpg`);
  }

  /** Guarda o corpo do pedido diretamente em disco, com limite de tamanho. */
  async receber(req, { nome, tipo, autorId }) {
    const limite = MAX_MB * 1024 * 1024;
    const declarado = Number(req.headers["content-length"] || 0);
    if (declarado > limite) throw Object.assign(new Error(`ficheiro maior que ${MAX_MB} MB`), { status: 413 });
    if (this.usadoBytes() + declarado > TOTAL_MB * 1024 * 1024) {
      throw Object.assign(new Error("o espaço para ficheiros do chat está cheio; apaguem ficheiros antigos ou aumentem o limite"), { status: 507 });
    }
    const id = crypto.randomBytes(8).toString("hex");
    const destino = this.caminho(id);
    let total = 0;
    const contador = new Transform({
      transform(chunk, _enc, cb) {
        total += chunk.length;
        if (total > limite) return cb(Object.assign(new Error(`ficheiro maior que ${MAX_MB} MB`), { status: 413 }));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, contador, fs.createWriteStream(destino, { mode: 0o600 }));
    } catch (e) {
      fs.rmSync(destino, { force: true });
      throw e;
    }
    if (!total) {
      fs.rmSync(destino, { force: true });
      throw Object.assign(new Error("ficheiro vazio"), { status: 400 });
    }
    const limpo = String(nome || "ficheiro").replace(/[\\/\0\r\n"]/g, "_").slice(0, 120) || "ficheiro";
    const t = String(tipo || "application/octet-stream").slice(0, 100);
    this.meta[id] = {
      id,
      nome: limpo,
      tipo: t,
      categoria: categoria(limpo, t),
      tamanho: total,
      autorId,
      at: new Date().toISOString(),
      previas: [],
      mensagemId: null,
    };
    this.save();
    return this.meta[id];
  }

  /** Pré-visualização em JPEG (foto reduzida ou imagem de um vídeo), criada no navegador. */
  async receberPrevia(req, id, autorId) {
    const f = this.get(id);
    if (!f || f.autorId !== autorId) throw Object.assign(new Error("ficheiro não encontrado"), { status: 404 });
    if (f.previas.length >= MAX_PREVIEWS) throw Object.assign(new Error("demasiadas pré-visualizações"), { status: 400 });
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > MAX_PREVIEW_BYTES) throw Object.assign(new Error("pré-visualização demasiado grande"), { status: 413 });
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw Object.assign(new Error("a pré-visualização tem de ser JPEG"), { status: 400 });
    const n = f.previas.length;
    fs.writeFileSync(this.caminhoPrevia(id, n), buf, { mode: 0o600 });
    f.previas.push({ n, tamanho: buf.length });
    this.save();
    return f;
  }

  ligarMensagem(id, mensagemId) {
    const f = this.get(id);
    if (f) {
      f.mensagemId = mensagemId;
      this.save();
    }
  }

  publico(f) {
    return f && { id: f.id, nome: f.nome, tipo: f.tipo, categoria: f.categoria, tamanho: f.tamanho, previas: f.previas.length };
  }

  // ---------- conteúdo para o Claude ----------

  /** Devolve blocos de conteúdo (texto, imagem, documento) que descrevem o ficheiro para o Claude. */
  blocosParaClaude(f) {
    const titulo = `Anexo "${f.nome}" (${f.categoria}, ${(f.tamanho / 1024 / 1024).toFixed(1)} MB)`;
    const blocos = [];
    const img = (buf, mt) => ({ type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } });
    try {
      if (f.categoria === "imagem") {
        blocos.push({ type: "text", text: titulo + ":" });
        if (f.previas.length) blocos.push(img(fs.readFileSync(this.caminhoPrevia(f.id, 0)), "image/jpeg"));
        else if (IMG_TYPES.has(f.tipo) && f.tamanho <= 4.5 * 1024 * 1024) blocos.push(img(fs.readFileSync(this.caminho(f.id)), f.tipo));
        else blocos.push({ type: "text", text: "(imagem num formato ou tamanho que não consigo ver)" });
      } else if (f.categoria === "video") {
        blocos.push({ type: "text", text: `${titulo}. Não vejo vídeo diretamente; seguem ${f.previas.length} imagens tiradas ao longo do vídeo, por ordem:` });
        for (const p of f.previas) blocos.push(img(fs.readFileSync(this.caminhoPrevia(f.id, p.n)), "image/jpeg"));
      } else if (f.categoria === "pdf") {
        if (f.tamanho <= 25 * 1024 * 1024) {
          blocos.push({ type: "text", text: titulo + ":" });
          blocos.push({ type: "document", title: f.nome, source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(this.caminho(f.id)).toString("base64") } });
        } else blocos.push({ type: "text", text: `${titulo}: PDF demasiado grande para analisar (máx. 25 MB).` });
      } else if (f.categoria === "texto") {
        const t = fs.readFileSync(this.caminho(f.id), "utf8").slice(0, 150_000);
        blocos.push({ type: "text", text: `${titulo}:\n<ficheiro nome="${f.nome}">\n${t}\n</ficheiro>` });
      } else if (f.categoria === "zip") {
        blocos.push(...blocosZip(fs.readFileSync(this.caminho(f.id)), titulo));
      } else {
        blocos.push({ type: "text", text: `${titulo}: formato que não consigo abrir (tipo ${f.tipo}).` });
      }
    } catch (e) {
      blocos.push({ type: "text", text: `${titulo}: não foi possível ler (${e.message}).` });
    }
    return blocos;
  }
}

// ---------- leitura de ZIP (sem dependências) ----------

export function lerZip(buf) {
  // Procurar o "end of central directory" a partir do fim.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip inválido");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entradas = [];
  for (let k = 0; k < n && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const tamanho = buf.readUInt32LE(p + 24);
    const lenNome = buf.readUInt16LE(p + 28);
    const lenExtra = buf.readUInt16LE(p + 30);
    const lenCom = buf.readUInt16LE(p + 32);
    const offLocal = buf.readUInt32LE(p + 42);
    const nome = buf.toString("utf8", p + 46, p + 46 + lenNome);
    entradas.push({ nome, metodo, comprimido, tamanho, offLocal });
    p += 46 + lenNome + lenExtra + lenCom;
  }
  const extrair = (e) => {
    const lp = e.offLocal;
    if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error("entrada inválida");
    const ini = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const dados = buf.subarray(ini, ini + e.comprimido);
    if (e.metodo === 0) return Buffer.from(dados);
    if (e.metodo === 8) return zlib.inflateRawSync(dados, { maxOutputLength: 30 * 1024 * 1024 });
    throw new Error("compressão não suportada");
  };
  return { entradas: entradas.filter((e) => !e.nome.endsWith("/") && !e.nome.startsWith("__MACOSX/")), extrair };
}

function blocosZip(buf, titulo) {
  const { entradas, extrair } = lerZip(buf);
  const blocos = [];
  const lista = entradas.slice(0, 300).map((e) => `- ${e.nome} (${(e.tamanho / 1024).toFixed(0)} KB)`).join("\n");
  blocos.push({ type: "text", text: `${titulo}. Contém ${entradas.length} ficheiros:\n${lista}${entradas.length > 300 ? "\n(...)" : ""}` });
  let imagens = 0;
  let pdfs = 0;
  let texto = 0;
  for (const e of entradas) {
    const ext = path.extname(e.nome).toLowerCase();
    try {
      if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext) && imagens < 8 && e.tamanho <= 4.5 * 1024 * 1024) {
        const mt = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
        blocos.push({ type: "text", text: `Imagem do zip: ${e.nome}` });
        blocos.push({ type: "image", source: { type: "base64", media_type: mt, data: extrair(e).toString("base64") } });
        imagens++;
      } else if (ext === ".pdf" && pdfs < 3 && e.tamanho <= 15 * 1024 * 1024) {
        blocos.push({ type: "text", text: `PDF do zip: ${e.nome}` });
        blocos.push({ type: "document", title: path.basename(e.nome), source: { type: "base64", media_type: "application/pdf", data: extrair(e).toString("base64") } });
        pdfs++;
      } else if (TEXT_EXT.has(ext) && texto < 200_000) {
        const t = extrair(e).toString("utf8").slice(0, 60_000);
        texto += t.length;
        blocos.push({ type: "text", text: `<ficheiro nome="${e.nome}">\n${t}\n</ficheiro>` });
      }
    } catch {
      blocos.push({ type: "text", text: `(não consegui abrir ${e.nome})` });
    }
  }
  if (imagens >= 8 || pdfs >= 3) blocos.push({ type: "text", text: "(Por limite de tamanho, só incluí as primeiras imagens e PDFs do zip.)" });
  return blocos;
}
