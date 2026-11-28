// Gestão dos membros a partir do servidor.
//   node admin.mjs novo-socio "Marco"      cria um sócio e mostra o link pessoal
//   node admin.mjs novo-convidado "Ana" 30 cria um convidado com acesso por 30 dias (0 = sem prazo)
//   node admin.mjs lista                   mostra todos os membros
//   node admin.mjs novo-link <id>          gera um link novo (o antigo deixa de funcionar)
//   node admin.mjs desativar <id>          retira o acesso
//   node admin.mjs ativar <id>             devolve o acesso
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = new Store(process.env.DADOS || path.join(here, "data"));
const base = (process.env.URL_PUBLICO || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, "");
const link = (token) => `${base}/entrar#${token}`;

const [cmd, a, b] = process.argv.slice(2);
try {
  switch (cmd) {
    case "novo-socio": {
      const { member, token } = store.addMember({ name: a, role: "socio" });
      console.log(`Sócio ${member.name} criado (id ${member.id}).\nLink pessoal (enviar só a esta pessoa):\n${link(token)}`);
      break;
    }
    case "novo-convidado": {
      const days = Number(b) || 0;
      const expiresAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
      const { member, token } = store.addMember({ name: a, role: "convidado", expiresAt });
      console.log(`Convidado ${member.name} criado (id ${member.id}).\nLink:\n${link(token)}`);
      break;
    }
    case "lista":
      for (const m of store.members) {
        console.log(`${m.id}  ${m.role.padEnd(9)}  ${m.active ? "ativo   " : "inativo "}  ${m.name}${m.expiresAt ? `  (até ${m.expiresAt.slice(0, 10)})` : ""}`);
      }
      if (!store.members.length) console.log("Ainda não há membros.");
      break;
    case "novo-link": {
      const { member, token } = store.resetToken(a);
      console.log(`Novo link para ${member.name}:\n${link(token)}`);
      break;
    }
    case "desativar":
    case "ativar": {
      const m = store.setActive(a, cmd === "ativar");
      console.log(`${m.name}: ${m.active ? "ativo" : "sem acesso"}.`);
      break;
    }
    default:
      console.log("Comandos: novo-socio <nome> | novo-convidado <nome> [dias] | lista | novo-link <id> | desativar <id> | ativar <id>");
  }
} catch (e) {
  console.error("Erro:", e.message);
  process.exit(1);
}
