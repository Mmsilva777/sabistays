"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const lista = $("lista");
  const texto = $("texto");
  let eu = null;
  let membros = [];
  let online = new Set();
  let mensagens = [];
  let naoLidas = 0;
  let eventos = null;
  const tituloBase = document.title;
  const CORES = ["#0B5F66", "#E17053", "#188C96", "#B5832A", "#7A5C99", "#3F7D4E"];

  async function pedir(url, opcoes = {}) {
    const r = await fetch(url, {
      credentials: "same-origin",
      headers: opcoes.body ? { "Content-Type": "application/json" } : {},
      ...opcoes,
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(dados.erro || "erro"), { status: r.status });
    return dados;
  }

  // ---------- entrada ----------

  async function entrar() {
    // Link pessoal: /entrar#TOKEN. O token vai no fragmento para não ficar em registos do servidor.
    if (location.pathname === "/entrar" && location.hash.length > 1) {
      const token = decodeURIComponent(location.hash.slice(1));
      history.replaceState(null, "", "/");
      try {
        await pedir("/api/entrar", { method: "POST", body: JSON.stringify({ token }) });
      } catch {
        mostrarPorta("Este link já não é válido. Pede um link novo a um dos sócios.");
        return;
      }
    }
    try {
      const r = await pedir("/api/eu");
      eu = r.membro;
    } catch {
      mostrarPorta();
      return;
    }
    $("porta").hidden = true;
    $("app").hidden = false;
    await carregarMembros();
    const r = await pedir("/api/mensagens");
    mensagens = r.mensagens;
    $("mais").hidden = mensagens.length < 150;
    desenharTudo();
    ligarEventos();
    texto.focus();
  }

  function mostrarPorta(msg) {
    if (msg) $("porta-texto").textContent = msg;
    $("app").hidden = true;
    $("porta").hidden = false;
  }

  // ---------- desenho ----------

  function corDe(id) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return CORES[h % CORES.length];
  }

  const fmtHora = new Intl.DateTimeFormat("pt-PT", { hour: "2-digit", minute: "2-digit" });
  const fmtDia = new Intl.DateTimeFormat("pt-PT", { weekday: "long", day: "numeric", month: "long" });
  function chaveDia(iso) {
    return new Date(iso).toDateString();
  }
  function rotuloDia(iso) {
    const d = new Date(iso);
    const hoje = new Date();
    const ontem = new Date(Date.now() - 86400000);
    if (d.toDateString() === hoje.toDateString()) return "Hoje";
    if (d.toDateString() === ontem.toDateString()) return "Ontem";
    return fmtDia.format(d);
  }

  function escapar(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // Texto simples: escapar, destacar @menções e transformar URLs em links.
  function inline(s) {
    return escapar(s)
      .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|\s)(@claude)\b/gi, '$1<span class="mencao">$2</span>');
  }

  // Markdown leve para as respostas do Claude (negrito, itálico, código, listas, parágrafos).
  function markdown(s) {
    const linhas = s.split("\n");
    let html = "";
    let emLista = false;
    let paragrafo = [];
    const fecharP = () => {
      if (paragrafo.length) html += `<p>${paragrafo.join("<br>")}</p>`;
      paragrafo = [];
    };
    const fmt = (t) =>
      inline(t)
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/^#{1,6}\s+(.*)$/, "<b>$1</b>");
    for (const l of linhas) {
      const item = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (item) {
        fecharP();
        if (!emLista) { html += "<ul>"; emLista = true; }
        html += `<li>${fmt(item[1])}</li>`;
      } else {
        if (emLista) { html += "</ul>"; emLista = false; }
        if (!l.trim()) fecharP();
        else paragrafo.push(fmt(l));
      }
    }
    fecharP();
    if (emLista) html += "</ul>";
    return html;
  }

  function nodoMensagem(m, anterior) {
    if (m.kind === "sistema") {
      const d = document.createElement("div");
      d.className = "sistema";
      d.textContent = m.text;
      return d;
    }
    const minha = m.authorId === eu.id;
    const seguida = anterior && anterior.authorId === m.authorId && anterior.kind === m.kind && new Date(m.at) - new Date(anterior.at) < 5 * 60000;
    const d = document.createElement("div");
    d.className = "msg" + (minha ? " minha" : "") + (m.kind === "claude" ? " claude" : "") + (seguida ? " seguida" : "");
    d.dataset.id = m.id;
    let html = "";
    if (!minha && !seguida) {
      const membro = membros.find((x) => x.id === m.authorId);
      const papel = m.kind === "claude" ? "assistente" : membro?.role === "convidado" ? "convidado" : "";
      const cor = m.kind === "claude" ? "var(--coral)" : corDe(m.authorId);
      html += `<span class="autor" style="color:${cor}">${escapar(m.authorName)}${papel ? `<small>${papel}</small>` : ""}</span>`;
    }
    html += `<div class="corpo">${m.kind === "claude" ? markdown(m.text) : inline(m.text)}</div>`;
    html += `<span class="hora">${fmtHora.format(new Date(m.at))}</span>`;
    d.innerHTML = html;
    return d;
  }

  function desenharTudo(manterPosicao = false) {
    const posicao = lista.scrollTop;
    const mais = $("mais");
    lista.replaceChildren(mais);
    let ultimoDia = null;
    let anterior = null;
    for (const m of mensagens) {
      if (chaveDia(m.at) !== ultimoDia) {
        ultimoDia = chaveDia(m.at);
        const d = document.createElement("div");
        d.className = "dia";
        d.textContent = rotuloDia(m.at);
        lista.append(d);
        anterior = null;
      }
      lista.append(nodoMensagem(m, anterior));
      anterior = m;
    }
    if (!mensagens.length) {
      const d = document.createElement("div");
      d.className = "sistema";
      d.textContent = "Ainda não há mensagens. Diz olá, ou escreve @claude para chamar o assistente.";
      lista.append(d);
    }
    lista.scrollTop = manterPosicao ? posicao : lista.scrollHeight;
  }

  function juntarMensagem(m) {
    if (mensagens.some((x) => x.id === m.id)) return;
    const pertoDoFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 120;
    mensagens.push(m);
    // Não saltar para o fim se a pessoa estiver a ler mensagens antigas.
    desenharTudo(!pertoDoFim && m.authorId !== eu.id);
    if (document.hidden && m.authorId !== eu.id) {
      naoLidas++;
      document.title = `(${naoLidas}) ${tituloBase}`;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      naoLidas = 0;
      document.title = tituloBase;
    }
  });

  // ---------- tempo real ----------

  function ligarEventos() {
    if (eventos) eventos.close();
    eventos = new EventSource("/api/eventos");
    eventos.addEventListener("open", () => atualizarEstado());
    eventos.addEventListener("mensagem", (e) => juntarMensagem(JSON.parse(e.data)));
    eventos.addEventListener("presenca", (e) => {
      online = new Set(JSON.parse(e.data).online);
      atualizarEstado();
      if (!$("painel").hidden) desenharMembros();
    });
    eventos.addEventListener("claude", (e) => {
      $("escrevendo").hidden = !JSON.parse(e.data).escrevendo;
    });
    eventos.addEventListener("error", async () => {
      $("estado").textContent = "sem ligação, a tentar de novo…";
      // Se a sessão acabou (acesso retirado), mostrar a porta.
      try {
        await pedir("/api/eu");
      } catch (err) {
        if (err.status === 401) {
          eventos.close();
          mostrarPorta("O teu acesso a este chat terminou.");
        }
      }
    });
  }

  function atualizarEstado() {
    const ativos = membros.filter((m) => m.active !== false).length;
    const n = online.size;
    $("estado").textContent = `${ativos} membros + Claude · ${n} online`;
  }

  // Ao voltar à app (telemóvel), recarregar mensagens perdidas.
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !eu) return;
    try {
      const r = await pedir("/api/mensagens");
      mensagens = r.mensagens;
      desenharTudo();
    } catch {}
  });

  // ---------- enviar ----------

  function ajustarAltura() {
    texto.style.height = "auto";
    texto.style.height = Math.min(texto.scrollHeight, 160) + "px";
  }
  texto.addEventListener("input", ajustarAltura);
  texto.addEventListener("keydown", (e) => {
    // Enter envia; Shift+Enter muda de linha (no telemóvel o Enter muda de linha).
    const telemovel = matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !telemovel && !e.isComposing) {
      e.preventDefault();
      $("compor").requestSubmit();
    }
  });

  $("compor").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = texto.value.trim();
    if (!t) return;
    $("btn-enviar").disabled = true;
    try {
      const r = await pedir("/api/mensagens", { method: "POST", body: JSON.stringify({ texto: t }) });
      texto.value = "";
      ajustarAltura();
      juntarMensagem(r.mensagem);
    } catch (err) {
      if (err.status === 401) mostrarPorta("A tua sessão terminou.");
      else alertaSistema(err.message);
    } finally {
      $("btn-enviar").disabled = false;
      texto.focus();
    }
  });

  function alertaSistema(t) {
    const d = document.createElement("div");
    d.className = "sistema";
    d.textContent = t;
    lista.append(d);
    lista.scrollTop = lista.scrollHeight;
  }

  $("btn-claude").addEventListener("click", () => {
    if (!/@claude\b/i.test(texto.value)) texto.value = "@claude " + texto.value;
    texto.focus();
    texto.setSelectionRange(texto.value.length, texto.value.length);
    ajustarAltura();
  });

  $("btn-mais").addEventListener("click", async () => {
    if (!mensagens.length) return;
    const alturaAntes = lista.scrollHeight;
    const r = await pedir("/api/mensagens?antes=" + encodeURIComponent(mensagens[0].at));
    mensagens = r.mensagens.concat(mensagens);
    $("mais").hidden = r.mensagens.length < 150;
    desenharTudo();
    lista.scrollTop = lista.scrollHeight - alturaAntes;
  });

  // ---------- membros e convites ----------

  async function carregarMembros() {
    const r = await pedir("/api/membros");
    membros = r.membros;
    atualizarEstado();
  }

  function desenharMembros() {
    const ul = $("membros");
    ul.replaceChildren();
    const ordem = { socio: 0, convidado: 1 };
    const todos = [...membros].sort((a, b) => ordem[a.role] - ordem[b.role] || a.name.localeCompare(b.name));
    const claudeLi = document.createElement("li");
    claudeLi.innerHTML = `<span class="bola" style="background:var(--coral)">C</span><span class="info"><b>Claude</b><small>assistente · responde quando é chamado</small></span>`;
    ul.append(claudeLi);
    for (const m of todos) {
      const li = document.createElement("li");
      if (m.active === false) li.classList.add("inativo");
      const expirou = m.expiresAt && new Date(m.expiresAt) < new Date();
      let sub = m.role === "socio" ? "sócio" : "convidado";
      if (m.expiresAt) sub += ` · ${expirou ? "expirou" : "até"} ${new Date(m.expiresAt).toLocaleDateString("pt-PT")}`;
      if (m.active === false) sub += " · sem acesso";
      if (m.id === eu.id) sub += " · tu";
      li.innerHTML = `<span class="bola${online.has(m.id) ? " on" : ""}" style="background:${corDe(m.id)}">${escapar(m.name.slice(0, 1).toUpperCase())}</span><span class="info"><b>${escapar(m.name)}</b><small>${escapar(sub)}</small></span>`;
      if (eu.role === "socio" && m.role === "convidado") {
        const acoes = document.createElement("span");
        acoes.className = "acoes";
        const bLink = document.createElement("button");
        bLink.type = "button";
        bLink.textContent = "Novo link";
        bLink.onclick = async () => {
          const r = await pedir(`/api/membros/${m.id}/novo-link`, { method: "POST", body: "{}" });
          mostrarLink(r.link);
          await carregarMembros();
          desenharMembros();
        };
        const bAcesso = document.createElement("button");
        bAcesso.type = "button";
        bAcesso.textContent = m.active === false ? "Devolver" : "Retirar";
        bAcesso.onclick = async () => {
          if (m.active !== false && !confirm(`Retirar o acesso a ${m.name}?`)) return;
          await pedir(`/api/membros/${m.id}/${m.active === false ? "ativar" : "desativar"}`, { method: "POST", body: "{}" });
          await carregarMembros();
          desenharMembros();
        };
        acoes.append(bLink, bAcesso);
        li.append(acoes);
      }
      ul.append(li);
    }
  }

  function mostrarLink(link) {
    $("link-texto").value = link;
    $("link-caixa").hidden = false;
    $("link-texto").select();
  }

  $("btn-membros").addEventListener("click", async () => {
    await carregarMembros();
    desenharMembros();
    $("so-socios").hidden = eu.role !== "socio";
    if (eu.role === "socio") {
      try {
        const u = await pedir("/api/claude/uso");
        $("uso").textContent = `Gasto do Claude este mês: ${u.mesUsd.toFixed(2)} USD de ${u.limiteUsd} USD de limite.`;
        const c = await pedir("/api/contexto");
        $("contexto-texto").value = c.texto;
        $("contexto-estado").textContent = "";
      } catch {}
    }
    $("painel").hidden = false;
  });
  $("btn-fechar").addEventListener("click", () => ($("painel").hidden = true));
  $("painel").addEventListener("click", (e) => {
    if (e.target === $("painel")) $("painel").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("painel").hidden = true;
  });

  $("convidar").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await pedir("/api/convidados", {
        method: "POST",
        body: JSON.stringify({ nome: $("conv-nome").value, dias: Number($("conv-dias").value) }),
      });
      $("conv-nome").value = "";
      mostrarLink(r.link);
      await carregarMembros();
      desenharMembros();
    } catch (err) {
      alert(err.message);
    }
  });

  $("contexto").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await pedir("/api/contexto", { method: "PUT", body: JSON.stringify({ texto: $("contexto-texto").value }) });
      $("contexto-estado").textContent = "Guardado ✓";
    } catch (err) {
      $("contexto-estado").textContent = err.message;
    }
  });

  $("btn-copiar").addEventListener("click", async () => {
    const v = $("link-texto").value;
    try {
      await navigator.clipboard.writeText(v);
      $("btn-copiar").textContent = "Copiado ✓";
    } catch {
      $("link-texto").select();
      document.execCommand("copy");
      $("btn-copiar").textContent = "Copiado ✓";
    }
    setTimeout(() => ($("btn-copiar").textContent = "Copiar link"), 2000);
  });

  $("btn-sair").addEventListener("click", async () => {
    if (!confirm("Sair deste dispositivo? Para voltar a entrar vais precisar do teu link pessoal.")) return;
    await pedir("/api/sair", { method: "POST", body: "{}" });
    if (eventos) eventos.close();
    mostrarPorta("Saíste. Para voltar a entrar, abre o teu link pessoal.");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  entrar();
})();
