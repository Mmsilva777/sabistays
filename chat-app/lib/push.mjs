// Notificações push (Web Push) para o chat instalado como app.
// As chaves VAPID são geradas no primeiro arranque e guardadas na pasta de dados.
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";

const MAX_POR_MEMBRO = 10; // dispositivos por pessoa

export class Push {
  constructor(dir, contacto = "mailto:ola@sabistays-sal.com") {
    this.dir = dir;
    this.ficheiro = path.join(dir, "push.json");
    const chavesFicheiro = path.join(dir, "vapid.json");
    let chaves;
    if (process.env.VAPID_PUBLICA && process.env.VAPID_PRIVADA) {
      chaves = { publicKey: process.env.VAPID_PUBLICA, privateKey: process.env.VAPID_PRIVADA };
    } else if (fs.existsSync(chavesFicheiro)) {
      chaves = JSON.parse(fs.readFileSync(chavesFicheiro, "utf8"));
    } else {
      chaves = webpush.generateVAPIDKeys();
      fs.writeFileSync(chavesFicheiro, JSON.stringify(chaves), { mode: 0o600 });
    }
    this.publica = chaves.publicKey;
    webpush.setVapidDetails(process.env.PUSH_CONTACTO || contacto, chaves.publicKey, chaves.privateKey);
    this._subs = [];
    this.mtime = -1;
  }

  // Relê o ficheiro se outro processo (admin.mjs) o alterou.
  get subs() {
    let m = 0;
    try { m = fs.statSync(this.ficheiro).mtimeMs; } catch {}
    if (m !== this.mtime) {
      this.mtime = m;
      try { this._subs = JSON.parse(fs.readFileSync(this.ficheiro, "utf8")); } catch { this._subs = []; }
    }
    return this._subs;
  }
  set subs(v) { this._subs = v; }

  guardar() {
    const tmp = this.ficheiro + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this._subs), { mode: 0o600 });
    fs.renameSync(tmp, this.ficheiro);
    try { this.mtime = fs.statSync(this.ficheiro).mtimeMs; } catch {}
  }

  static valida(sub) {
    return (
      sub && typeof sub.endpoint === "string" && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000 &&
      sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string"
    );
  }

  subscrever(memberId, sub) {
    if (!Push.valida(sub)) return false;
    this.subs = this.subs.filter((s) => s.sub.endpoint !== sub.endpoint);
    this.subs.push({ memberId, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, at: new Date().toISOString() });
    const meus = this.subs.filter((s) => s.memberId === memberId);
    if (meus.length > MAX_POR_MEMBRO) {
      const sair = new Set(meus.slice(0, meus.length - MAX_POR_MEMBRO).map((s) => s.sub.endpoint));
      this.subs = this.subs.filter((s) => !sair.has(s.sub.endpoint));
    }
    this.guardar();
    return true;
  }

  cancelar(memberId, endpoint) {
    const antes = this.subs.length;
    this.subs = this.subs.filter((s) => !(s.memberId === memberId && (!endpoint || s.sub.endpoint === endpoint)));
    if (this.subs.length !== antes) this.guardar();
  }

  tem(memberId, endpoint) {
    return this.subs.some((s) => s.memberId === memberId && s.sub.endpoint === endpoint);
  }

  // destinos: (memberId) => conteúdo da notificação ou null para não enviar
  async enviar(destinos) {
    const mortos = new Set();
    await Promise.all(
      this.subs.map(async (s) => {
        const conteudo = destinos(s.memberId);
        if (!conteudo) return;
        try {
          await webpush.sendNotification(s.sub, JSON.stringify(conteudo), { TTL: 60 * 60 * 12, urgency: conteudo.urgente ? "high" : "normal" });
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) mortos.add(s.sub.endpoint);
          else console.error("push falhou:", err.statusCode || err.message);
        }
      }),
    );
    if (mortos.size) {
      this.subs = this.subs.filter((s) => !mortos.has(s.sub.endpoint));
      this.guardar();
    }
  }
}
