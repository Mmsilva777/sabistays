"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const lista = $("lista");
  const texto = $("texto");
  let eu = null;
  let maxMb = 50;
  let nomesTemas = {}; // id -> nome (só sócios)
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

  let linkUsado = null; // o link pessoal acabado de abrir (para o ecrã de boas-vindas)

  async function entrar() {
    // Link pessoal: /entrar#TOKEN. O token vai no fragmento para não ficar em registos do servidor.
    if (location.pathname === "/entrar" && location.hash.length > 1) {
      const token = decodeURIComponent(location.hash.slice(1));
      history.replaceState(null, "", "/");
      try {
        await pedir("/api/entrar", { method: "POST", body: JSON.stringify({ token }) });
        linkUsado = location.origin + "/entrar#" + encodeURIComponent(token);
      } catch {
        mostrarPorta("Este link já não é válido. Pede um link novo a um dos sócios.");
        return;
      }
    }
    try {
      const r = await pedir("/api/eu");
      eu = r.membro;
      maxMb = r.maxMb || maxMb;
    } catch {
      mostrarPorta();
      return;
    }
    $("porta").hidden = true;
    $("app").hidden = false;
    await carregarMembros();
    $("btn-arquivo").hidden = eu.role !== "socio";
    $("pastas").hidden = $("btn-pastas").hidden = eu.role !== "socio";
    if (eu.role === "socio") await carregarNomesTemas();
    const r = await pedir("/api/mensagens");
    mensagens = r.mensagens;
    $("mais").hidden = mensagens.length < 150;
    desenharTudo();
    ligarEventos();
    estadoApp();
    if (linkUsado && !instalada()) mostrarBoasVindas();
    else texto.focus();
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
    if (m.anexo) html += htmlAnexo(m.anexo);
    if (m.text) html += `<div class="corpo">${m.kind === "claude" ? markdown(m.text) : inline(m.text)}</div>`;
    if (m.temas && m.temas.length && eu.role === "socio") {
      html += `<span class="temas">${m.temas.map((t) => `<span class="tema">${escapar(nomesTemas[t] || t)}</span>`).join("")}</span>`;
    }
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
    eventos = new EventSource("/api/eventos" + (document.hidden ? "?visivel=0" : ""));
    eventos.addEventListener("open", () => atualizarEstado());
    eventos.addEventListener("ola", (e) => { cid = JSON.parse(e.data).cid; });
    eventos.addEventListener("mensagem", (e) => juntarMensagem(JSON.parse(e.data)));
    eventos.addEventListener("presenca", (e) => {
      online = new Set(JSON.parse(e.data).online);
      atualizarEstado();
      if (!$("painel").hidden) desenharMembros();
    });
    eventos.addEventListener("arquivo", async (e) => {
      const { temas } = JSON.parse(e.data);
      if (eu.role === "socio") await carregarNomesTemas();
      for (const m of mensagens) if (temas[m.id]) m.temas = temas[m.id];
      desenharTudo(true);
      if (!$("arquivo").hidden && !temaAberto) abrirArquivo();
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

  // Diz ao servidor se o chat está à frente, para não mandar notificações a quem já está a ler.
  let cid = null;
  document.addEventListener("visibilitychange", () => {
    if (!cid) return;
    fetch("/api/visivel", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cid, visivel: !document.hidden }) }).catch(() => {});
  });

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
    if (!t && !ficheiroEscolhido) return;
    $("btn-enviar").disabled = true;
    try {
      let anexo = null;
      if (ficheiroEscolhido) anexo = await enviarFicheiro(ficheiroEscolhido);
      const r = await pedir("/api/mensagens", { method: "POST", body: JSON.stringify({ texto: t, anexo }) });
      limparFicheiro();
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
    estadoApp();
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
    if (e.key === "Escape") { $("painel").hidden = true; $("arquivo").hidden = true; fecharPastas(); marcarPasta(null); }
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
    await desligarNotificacoes().catch(() => {});
    await pedir("/api/sair", { method: "POST", body: "{}" });
    if (eventos) eventos.close();
    mostrarPorta("Saíste. Para voltar a entrar, abre o teu link pessoal.");
  });


  // ---------- anexos ----------

  let ficheiroEscolhido = null;

  function tamanhoLegivel(b) {
    if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + " KB";
    return (b / 1024 / 1024).toFixed(1) + " MB";
  }

  const ICONES = { pdf: "📄", zip: "🗜️", texto: "📝", video: "🎬", imagem: "🖼️", outro: "📎" };

  function htmlAnexo(a) {
    const url = `/api/ficheiros/${a.id}`;
    if (a.categoria === "imagem") {
      const src = a.previas ? `${url}/previa/0` : url;
      return `<a class="anexo-img" href="${url}" target="_blank" rel="noopener"><img src="${src}" alt="${escapar(a.nome)}" loading="lazy"></a>`;
    }
    if (a.categoria === "video") {
      const poster = a.previas ? ` poster="${url}/previa/0"` : "";
      return `<video class="anexo-video" controls preload="none" playsinline src="${url}"${poster}></video>`;
    }
    return `<a class="anexo-ficheiro" href="${url}?descarregar" rel="noopener"><span class="ic">${ICONES[a.categoria] || "📎"}</span><span><b>${escapar(a.nome)}</b><small>${tamanhoLegivel(a.tamanho)} · descarregar</small></span></a>`;
  }

  $("btn-anexo").addEventListener("click", () => $("ficheiro").click());
  function grandeDemais(f) {
    if (f.size <= maxMb * 1024 * 1024) return false;
    alertaSistema(`"${f.name}" tem ${tamanhoLegivel(f.size)}. O máximo por ficheiro é ${maxMb} MB.`);
    return true;
  }

  function escolherFicheiro(f) {
    if (!f || grandeDemais(f)) return;
    ficheiroEscolhido = f;
    $("anexo-nome").textContent = `${f.name} (${tamanhoLegivel(f.size)})`;
    $("anexo-barra").style.width = "0%";
    $("anexo-escolhido").hidden = false;
    texto.focus();
  }

  // Vários ficheiros de uma vez: cada um segue numa mensagem própria.
  async function enviarVarios(lista) {
    for (const f of lista) {
      if (grandeDemais(f)) continue;
      escolherFicheiro(f);
      try {
        const anexo = await enviarFicheiro(f);
        const r = await pedir("/api/mensagens", { method: "POST", body: JSON.stringify({ texto: "", anexo }) });
        juntarMensagem(r.mensagem);
      } catch (err) {
        alertaSistema(`Não foi possível enviar "${f.name}": ${err.message}`);
      }
    }
    limparFicheiro();
  }

  function receberFicheiros(lista) {
    const fs = [...lista].filter((f) => f && f.size > 0);
    if (!fs.length) return;
    if (fs.length === 1) escolherFicheiro(fs[0]);
    else enviarVarios(fs);
  }

  $("ficheiro").addEventListener("change", () => {
    receberFicheiros($("ficheiro").files);
    $("ficheiro").value = "";
  });

  // Arrastar e largar ficheiros para a janela do chat.
  let arrastos = 0;
  const temFicheiros = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!temFicheiros(e) || $("app").hidden) return;
    e.preventDefault();
    arrastos++;
    $("largar").hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    if (!temFicheiros(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!temFicheiros(e)) return;
    arrastos = Math.max(0, arrastos - 1);
    if (!arrastos) $("largar").hidden = true;
  });
  window.addEventListener("drop", (e) => {
    if (!temFicheiros(e)) return;
    e.preventDefault();
    arrastos = 0;
    $("largar").hidden = true;
    if (!$("app").hidden) receberFicheiros(e.dataTransfer.files);
  });

  // Colar uma imagem (Ctrl+V) na caixa de texto.
  texto.addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files || [])];
    if (!fs.length) return;
    e.preventDefault();
    receberFicheiros(fs);
  });
  $("btn-tirar-anexo").addEventListener("click", limparFicheiro);

  function limparFicheiro() {
    ficheiroEscolhido = null;
    $("ficheiro").value = "";
    $("anexo-escolhido").hidden = true;
  }

  function enviarComProgresso(url, corpo, headers, aoProgresso) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => e.lengthComputable && aoProgresso && aoProgresso(e.loaded / e.total);
      xhr.onload = () => {
        let d = {};
        try { d = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(d);
        else reject(new Error(d.erro || `erro ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("falhou a ligação durante o envio"));
      xhr.send(corpo);
    });
  }

  async function enviarFicheiro(f) {
    const r = await enviarComProgresso("/api/ficheiros", f, {
      "Content-Type": f.type || "application/octet-stream",
      "X-Nome": encodeURIComponent(f.name),
    }, (p) => ($("anexo-barra").style.width = Math.round(p * 90) + "%"));
    const id = r.ficheiro.id;
    // Pré-visualizações leves (para mostrar no chat e para o Claude ver).
    try {
      const previas = r.ficheiro.categoria === "imagem" ? [await reduzirImagem(f)] : r.ficheiro.categoria === "video" ? await framesVideo(f, 6) : [];
      for (const b of previas.filter(Boolean)) {
        await enviarComProgresso(`/api/ficheiros/${id}/previa`, b, { "Content-Type": "image/jpeg" });
      }
    } catch {
      // sem pré-visualização: o ficheiro segue na mesma
    }
    $("anexo-barra").style.width = "100%";
    return id;
  }

  function canvasParaJpeg(fonte, w, h, max) {
    const escala = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * escala);
    c.height = Math.round(h * escala);
    c.getContext("2d").drawImage(fonte, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
  }

  function reduzirImagem(f) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = async () => {
        const b = await canvasParaJpeg(img, img.naturalWidth, img.naturalHeight, 1600);
        URL.revokeObjectURL(url);
        resolve(b);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function framesVideo(f, n) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(f);
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      const frames = [];
      let tempos = [];
      const acabar = () => { URL.revokeObjectURL(url); resolve(frames); };
      const seguinte = () => {
        if (!tempos.length) return acabar();
        v.currentTime = tempos.shift();
      };
      v.onloadedmetadata = () => {
        const d = v.duration && isFinite(v.duration) ? v.duration : 1;
        tempos = Array.from({ length: n }, (_, i) => Math.min(d - 0.05, (d * (i + 0.5)) / n));
        seguinte();
      };
      v.onseeked = async () => {
        try { frames.push(await canvasParaJpeg(v, v.videoWidth, v.videoHeight, 1280)); } catch {}
        seguinte();
      };
      v.onerror = acabar;
      setTimeout(acabar, 20000);
      v.src = url;
    });
  }

  // ---------- arquivo por temas ----------

  let temaAberto = null;

  async function carregarNomesTemas() {
    try {
      const r = await pedir("/api/arquivo");
      nomesTemas = Object.fromEntries(r.temas.map((t) => [t.id, t.nome]));
      desenharPastas(r);
      return r;
    } catch {
      return null;
    }
  }

  const ROTULOS = { decisao: "Decisões", numero: "Números", contacto: "Contactos", tarefa: "Tarefas", ideia: "Ideias", nota: "Notas" };
  const fmtData = new Intl.DateTimeFormat("pt-PT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  async function abrirArquivo() {
    temaAberto = null;
    const r = await carregarNomesTemas();
    if (!r) return;
    const cx = $("arquivo-conteudo");
    let html = "";
    html += `<p class="ajuda">${r.ultimaExecucao ? "Última atualização: " + fmtData.format(new Date(r.ultimaExecucao)) : "Ainda não foi arquivado nada."}${r.pendentes ? ` · ${r.pendentes} mensagens por arquivar` : ""}</p>`;
    if (r.factos.length) {
      html += `<details class="memoria" open><summary>Memória do Claude (${r.factos.length})</summary><ul>${r.factos.map((f) => `<li>${inline(f)}</li>`).join("")}</ul></details>`;
    }
    html += `<div class="temas-grelha">`;
    for (const t of r.temas) {
      html += `<button type="button" class="tema-cartao" data-tema="${t.id}"><b>${escapar(t.nome)}</b><small>${t.mensagens} mensagens · ${t.itens} dados</small>${t.resumo ? `<span>${escapar(t.resumo.replace(/[*#`_]/g, "").slice(0, 140))}${t.resumo.length > 140 ? "…" : ""}</span>` : ""}</button>`;
    }
    html += `</div>`;
    html += `<form id="novo-tema" class="convidar"><input id="novo-tema-nome" placeholder="Novo tema (ex.: Boa Vista)" maxlength="60" required><button type="submit">Criar tema</button></form>`;
    cx.innerHTML = html;
    marcarPasta(null);
    cx.querySelectorAll(".tema-cartao").forEach((b) => (b.onclick = () => abrirTema(b.dataset.tema)));
    $("novo-tema").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await pedir("/api/arquivo/temas", { method: "POST", body: JSON.stringify({ nome: $("novo-tema-nome").value }) });
        abrirArquivo();
      } catch (err) { alert(err.message); }
    };
    $("arquivo-titulo").textContent = "Arquivo";
    $("btn-arquivo-voltar").hidden = true;
  }

  function htmlMensagemArquivo(m) {
    const anexo = m.anexo ? ` <a href="/api/ficheiros/${m.anexo.id}?descarregar">📎 ${escapar(m.anexo.nome)}</a>` : "";
    return `<li><small>${escapar(m.kind === "claude" ? "Claude" : m.authorName)} · ${fmtData.format(new Date(m.at))}</small><div>${m.kind === "claude" ? markdown(m.text) : inline(m.text)}${anexo}</div></li>`;
  }

  async function abrirTema(id) {
    temaAberto = id;
    marcarPasta(id);
    const { tema: t } = await pedir("/api/arquivo/temas/" + id);
    let html = `<p><a class="descarregar" href="/api/arquivo/temas/${t.id}.md">Descarregar este tema (.md)</a></p>`;
    html += `<h3>Resumo</h3><div class="resumo">${t.resumo ? markdown(t.resumo) : "<p class='ajuda'>Ainda sem resumo.</p>"}</div>`;
    for (const tipo of Object.keys(ROTULOS)) {
      const lista = t.itens.filter((i) => i.tipo === tipo);
      if (!lista.length) continue;
      html += `<h3>${ROTULOS[tipo]}</h3><ul class="itens">${lista.map((i) => `<li>${inline(i.texto)} <small>${escapar(i.autor || "")} · ${new Date(i.at).toLocaleDateString("pt-PT")}</small></li>`).join("")}</ul>`;
    }
    html += `<h3>Conversa (${t.mensagens.length})</h3><ul class="conversa">${t.mensagens.slice().reverse().map(htmlMensagemArquivo).join("")}</ul>`;
    $("arquivo-conteudo").innerHTML = html;
    $("arquivo-titulo").textContent = t.nome;
    $("btn-arquivo-voltar").hidden = false;
    $("arquivo-conteudo").scrollTop = 0;
  }

  $("btn-arquivo").addEventListener("click", () => {
    $("arquivo").hidden = false;
    abrirArquivo();
  });
  $("btn-arquivo-fechar").addEventListener("click", () => { $("arquivo").hidden = true; marcarPasta(null); });
  $("btn-arquivo-voltar").addEventListener("click", abrirArquivo);
  $("btn-arquivar-agora").addEventListener("click", async () => {
    try {
      await pedir("/api/arquivo/agora", { method: "POST", body: "{}" });
      $("btn-arquivar-agora").textContent = "A arquivar…";
      setTimeout(() => ($("btn-arquivar-agora").textContent = "Arquivar agora"), 8000);
    } catch (err) { alert(err.message); }
  });
  let pesquisaTimer = null;
  $("arquivo-pesquisa").addEventListener("input", () => {
    clearTimeout(pesquisaTimer);
    pesquisaTimer = setTimeout(async () => {
      const q = $("arquivo-pesquisa").value.trim();
      if (q.length < 2) return abrirArquivo();
      temaAberto = "pesquisa";
      const r = await pedir("/api/arquivo/pesquisa?q=" + encodeURIComponent(q));
      let html = `<h3>Dados (${r.itens.length})</h3><ul class="itens">${r.itens.map((i) => `<li>${inline(i.texto)} <small>${escapar(nomesTemas[i.tema] || i.tema)}</small></li>`).join("")}</ul>`;
      html += `<h3>Mensagens (${r.mensagens.length})</h3><ul class="conversa">${r.mensagens.slice().reverse().map(htmlMensagemArquivo).join("")}</ul>`;
      $("arquivo-conteudo").innerHTML = html;
      $("arquivo-titulo").textContent = `Pesquisa: ${q}`;
      $("btn-arquivo-voltar").hidden = false;
    }, 300);
  });

  // ---------- pastas (barra lateral) ----------

  function desenharPastas(r) {
    const lista = $("pastas-lista");
    const ativa = lista.querySelector(".pasta.ativa")?.dataset.tema || null;
    lista.innerHTML = r.temas
      .slice()
      .sort((a, b) => (b.mensagens + b.itens) - (a.mensagens + a.itens))
      .map((t) => {
        const resumo = t.resumo ? t.resumo.replace(/[*#`_>]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) : "Ainda sem resumo";
        return `<button type="button" class="pasta" data-tema="${t.id}"><span class="ic">${t.mensagens || t.itens ? "📂" : "📁"}</span><span class="pasta-txt"><b>${escapar(t.nome)}<em>${t.mensagens}</em></b><small>${escapar(resumo)}</small></span></button>`;
      })
      .join("");
    lista.querySelectorAll(".pasta").forEach((b) => (b.onclick = () => abrirPasta(b.dataset.tema)));
    marcarPasta(ativa && !$("arquivo").hidden ? ativa : null);
    $("pasta-memoria-n").textContent = r.factos.length ? `${r.factos.length} factos guardados` : "Ainda vazia";
    $("pastas-estado").textContent = r.ultimaExecucao
      ? `Atualizado ${fmtData.format(new Date(r.ultimaExecucao))}${r.pendentes ? ` · ${r.pendentes} por arquivar` : ""}`
      : "Ainda não foi arquivado nada.";
  }
  function marcarPasta(id) {
    $("pastas-lista").querySelectorAll(".pasta").forEach((b) => b.classList.toggle("ativa", b.dataset.tema === id));
    $("pasta-memoria").classList.toggle("ativa", id === "memoria");
  }
  function abrirPastas() { $("pastas").classList.add("aberta"); $("pastas-fundo").hidden = false; }
  function fecharPastas() { $("pastas").classList.remove("aberta"); $("pastas-fundo").hidden = true; }
  function abrirPasta(id) {
    $("arquivo").hidden = false;
    abrirTema(id);
    fecharPastas();
  }
  $("btn-pastas").addEventListener("click", abrirPastas);
  $("btn-pastas-fechar").addEventListener("click", fecharPastas);
  $("pastas-fundo").addEventListener("click", fecharPastas);
  $("btn-pastas-tudo").addEventListener("click", () => { $("arquivo").hidden = false; abrirArquivo(); fecharPastas(); });
  $("pasta-memoria").addEventListener("click", async () => {
    $("arquivo").hidden = false;
    await abrirArquivo();
    marcarPasta("memoria");
    fecharPastas();
  });
  let pastasTimer = null;
  $("pastas-pesquisa").addEventListener("input", () => {
    clearTimeout(pastasTimer);
    pastasTimer = setTimeout(() => {
      const q = $("pastas-pesquisa").value;
      $("arquivo").hidden = false;
      $("arquivo-pesquisa").value = q;
      $("arquivo-pesquisa").dispatchEvent(new Event("input"));
      if (q.trim().length >= 2) marcarPasta(null);
    }, 300);
  });
  $("pastas-pesquisa").addEventListener("keydown", (e) => { if (e.key === "Enter") fecharPastas(); });

  // ---------- app instalável e notificações ----------

  const ua = navigator.userAgent;
  const ehIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const ehAndroid = /Android/.test(ua);
  const instalada = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const temPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let pedidoInstalar = null;
  let registo = null;
  let notifAtivo = false;

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").then((r) => { registo = r; estadoApp(); }).catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    pedidoInstalar = e;
    estadoApp();
    if (!$("boas-vindas").hidden) desenharBoasVindas();
  });
  window.addEventListener("appinstalled", () => {
    pedidoInstalar = null;
    estadoApp();
    if (!$("boas-vindas").hidden) {
      $("bv-passos").innerHTML = "";
      $("bv-instalar").hidden = true;
      $("bv-nota").innerHTML = "✓ App instalada. Abre a <b>Sabi Chat</b> " + (ehAndroid || ehIOS ? "no ecrã principal" : "no menu Iniciar ou na barra de tarefas") + " e ativa as notificações quando ela pedir.";
      $("bv-continuar").textContent = "Fechar";
    }
  });

  // ---------- boas-vindas (instalação guiada a partir do link pessoal) ----------

  function mostrarBoasVindas() {
    $("bv-titulo").textContent = `Olá, ${eu.name.split(/\s+/)[0]}!`;
    desenharBoasVindas();
    $("boas-vindas").hidden = false;
  }

  function desenharBoasVindas() {
    if ($("boas-vindas").hidden && !linkUsado) return;
    const g = guia(linkUsado);
    $("bv-instalar").hidden = !g.instalar;
    $("bv-copiar").hidden = !g.copiar;
    $("bv-links").innerHTML = g.links.map((l, n) => `<a href="${escapar(l.href)}"${l.download ? " download" : ""} class="${n ? "secundario" : ""}">${l.texto}</a>`).join("");
    $("bv-passos").innerHTML = g.passos.map((p) => `<li>${p}</li>`).join("");
    $("bv-nota").innerHTML = g.nota;
    const podeNotif = temPush && Notification.permission === "default";
    $("bv-notif").hidden = !podeNotif && !notifAtivo;
    $("bv-notif").disabled = notifAtivo;
    $("bv-notif").textContent = notifAtivo ? "🔔 Notificações ativas ✓" : "🔔 Ativar notificações";
  }

  // Deteção do sistema e do browser, para mostrar a forma certa de instalar.
  function navegador() {
    const so = ehIOS ? "ios" : ehAndroid ? "android" : /Windows/.test(ua) ? "windows" : /Macintosh|Mac OS X/.test(ua) ? "mac" : "linux";
    const br = /FxiOS|Firefox\//.test(ua) ? "firefox"
      : /SamsungBrowser/.test(ua) ? "samsung"
      : /EdgiOS|EdgA?\//.test(ua) ? "edge"
      : /OPR\/|OPiOS|Opera/.test(ua) ? "opera"
      : /CriOS|Chrome\//.test(ua) ? "chrome"
      : /Safari\//.test(ua) ? "safari" : "outro";
    return { so, br, chromium: ["chrome", "edge", "opera", "samsung"].includes(br) };
  }

  // Passos, botões e links para instalar neste aparelho. link = link pessoal (só no ecrã de boas-vindas).
  function guia(link) {
    const { so, br, chromium } = navegador();
    const g = { passos: [], links: [], nota: "", instalar: false, copiar: false };
    const destino = link || location.origin + "/";
    const colarNaApp = "Abre a app <b>Sabi Chat</b> no ecrã principal, cola o link e carrega em <b>Entrar</b>.";
    if (instalada()) { g.nota = "✓ Já estás a usar a app."; return g; }
    if (pedidoInstalar) {
      g.instalar = true;
      g.nota = "Carrega em <b>Instalar app</b> e confirma. Ficas logo com a sessão iniciada.";
      return g;
    }
    if (so === "ios") {
      g.copiar = !!link;
      if (br === "safari") {
        g.passos = [
          link ? "Carrega em <b>Copiar o meu link</b> (vais precisar dele no passo 4)." : "Tem à mão o teu link pessoal (vais precisar dele no passo 4).",
          "Toca em <b>Partilhar</b> (o quadrado com a seta para cima).",
          "Escolhe <b>Adicionar ao ecrã principal</b> e depois <b>Adicionar</b>.",
          colarNaApp,
        ];
      } else {
        g.links.push({ texto: "Abrir no Safari", href: "x-safari-" + destino });
        g.passos = [
          link ? "Carrega em <b>Copiar o meu link</b>." : "Tem à mão o teu link pessoal.",
          "Carrega em <b>Abrir no Safari</b>. No Safari, toca em <b>Partilhar</b> → <b>Adicionar ao ecrã principal</b>.",
          colarNaApp,
          `Em iOS recente também dá diretamente no ${br === "firefox" ? "Firefox" : br === "edge" ? "Edge" : "Chrome"}: <b>Partilhar</b> → <b>Adicionar ao ecrã principal</b>.`,
        ];
      }
      return g;
    }
    if (so === "android") {
      if (br === "firefox") g.passos = ["No Firefox, toca no menu <b>⋮</b>.", "Escolhe <b>Instalar</b> (ou <b>Adicionar ao ecrã principal</b>) e confirma.", "Abre a <b>Sabi Chat</b> no ecrã principal."];
      else if (br === "samsung") g.passos = ["No Samsung Internet, toca no menu <b>≡</b>.", "Escolhe <b>Adicionar página a</b> → <b>Ecrã principal</b>.", "Abre a <b>Sabi Chat</b> no ecrã principal."];
      else g.passos = ["Toca no menu <b>⋮</b> (canto superior direito).", "Escolhe <b>Instalar app</b> (ou <b>Adicionar ao ecrã principal</b>) e confirma.", "Abre a <b>Sabi Chat</b> no ecrã principal."];
      return g;
    }
    // Computador
    if (chromium) {
      g.passos = ["Clica no ícone de instalar à direita da barra de endereço (ou menu <b>⋮</b> → <b>Instalar Sabi Chat</b> / <b>Aplicações</b> → <b>Instalar este site como app</b>).", "A app fica no menu Iniciar e na barra de tarefas (ou nas Aplicações, no Mac)."];
      return g;
    }
    if (so === "mac" && br === "safari") {
      g.passos = ["No Safari, abre o menu <b>Ficheiro</b> → <b>Adicionar à Dock</b> (macOS Sonoma ou mais recente).", "A Sabi Chat fica na Dock e nas Aplicações."];
      return g;
    }
    const nome = br === "firefox" ? "Firefox" : "este browser";
    if (so === "windows") {
      g.links.push({ texto: "Instalar com o Microsoft Edge", href: "microsoft-edge:" + destino });
      g.links.push({ texto: "Ou descarregar atalho para o ambiente de trabalho", href: "/atalho.url", download: true });
      g.passos = [
        `O ${nome} não instala apps web, por isso usamos o <b>Edge</b>, que já vem com o Windows. Carrega em <b>Instalar com o Microsoft Edge</b>${br === "firefox" ? " e, se o Firefox perguntar, escolhe <b>Abrir</b>" : ""}.`,
        link ? "No Edge aparece este mesmo ecrã com o botão <b>Instalar app</b>." : "No Edge, abre o teu link pessoal e carrega em <b>Instalar app</b>.",
        `Preferes continuar no ${nome}? Descarrega o atalho e arrasta-o para o ambiente de trabalho ou para a barra de tarefas.`,
      ];
      return g;
    }
    if (so === "mac") {
      g.copiar = !!link;
      g.links.push({ texto: "Descarregar atalho para a Dock", href: "/atalho.webloc", download: true });
      g.passos = [
        `O ${nome} não instala apps web no Mac. ${link ? "Carrega em <b>Copiar o meu link</b> e abre-o" : "Abre o teu link pessoal"} no <b>Safari</b> (Ficheiro → <b>Adicionar à Dock</b>) ou no <b>Chrome</b> (ícone de instalar na barra de endereço).`,
        `Preferes continuar no ${nome}? Descarrega o atalho e arrasta-o para a Dock.`,
      ];
      return g;
    }
    g.copiar = !!link;
    g.links.push({ texto: "Descarregar atalho", href: "/atalho.desktop", download: true });
    g.passos = [
      `Para uma app com janela própria, abre o teu link pessoal no <b>Chrome</b> ou no <b>Chromium</b> e usa o ícone de instalar.`,
      `Para continuar no ${nome}, descarrega o atalho e põe-no no ambiente de trabalho.`,
    ];
    return g;
  }

  $("bv-instalar").addEventListener("click", async () => {
    if (!pedidoInstalar) return;
    pedidoInstalar.prompt();
    const escolha = await pedidoInstalar.userChoice.catch(() => ({}));
    if (escolha.outcome !== "accepted") desenharBoasVindas();
  });
  $("bv-copiar").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(linkUsado);
      $("bv-copiar").textContent = "Link copiado ✓";
    } catch {
      prompt("Copia o teu link:", linkUsado);
    }
  });
  $("bv-notif").addEventListener("click", async () => {
    $("bv-notif").disabled = true;
    try { await ligarNotificacoes(); } catch {}
    desenharBoasVindas();
  });
  $("bv-continuar").addEventListener("click", () => {
    $("boas-vindas").hidden = true;
    texto.focus();
    // Notificações ativas por defeito: aproveita este toque para pedir a permissão.
    if (temPush && Notification.permission === "default") ligarNotificacoes().catch(() => {});
  });

  function chaveBytes(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function subscricaoAtual() {
    if (!temPush) return null;
    const r = registo || (await navigator.serviceWorker.ready);
    return r.pushManager.getSubscription();
  }

  async function subscrever() {
    const r = registo || (await navigator.serviceWorker.ready);
    const { chave } = await pedir("/api/push");
    let sub = await r.pushManager.getSubscription();
    if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveBytes(chave) });
    await pedir("/api/push", { method: "POST", body: JSON.stringify({ sub: sub.toJSON() }) });
    return sub;
  }

  async function ligarNotificacoes() {
    const perm = await Notification.requestPermission();
    if (perm === "granted") await subscrever();
    await estadoApp();
  }

  async function desligarNotificacoes() {
    const sub = await subscricaoAtual();
    if (!sub) return;
    await pedir("/api/push", { method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe();
    estadoApp();
  }

  async function estadoApp() {
    if (!eu) return;
    // Instalação
    const g = guia(null);
    let ajuda = instalada() ? "✓ Estás a usar o chat como app." : g.instalar ? "Instala o chat como app: fica com o ícone da Sabi Stays e abre numa janela própria." : "";
    if (g.passos.length) ajuda += `<ol class="guia-lista">${g.passos.map((p) => `<li>${p}</li>`).join("")}</ol>`;
    if (g.links.length) ajuda += `<span class="guia-links">${g.links.map((l) => `<a href="${escapar(l.href)}"${l.download ? " download" : ""}>${l.texto}</a>`).join("")}</span>`;
    $("instalar-ajuda").innerHTML = ajuda;
    $("btn-instalar").hidden = !pedidoInstalar || instalada();

    // Notificações
    const b = $("btn-notif");
    let estado = "";
    let ativo = false;
    if (!temPush) {
      estado = ehIOS && !instalada() ? "No iPhone, as notificações só funcionam depois de instalares a app no ecrã principal (iOS 16.4 ou mais recente)." : "Este browser não suporta notificações.";
      b.hidden = true;
    } else if (Notification.permission === "denied") {
      estado = "As notificações estão bloqueadas. Ativa-as nas definições do browser ou do telemóvel para este site.";
      b.hidden = true;
    } else {
      let sub = await subscricaoAtual().catch(() => null);
      // Permissão já dada mas sem subscrição (aparelho novo, app reinstalada): liga sozinho.
      if (!sub && Notification.permission === "granted") sub = await subscrever().catch(() => null);
      if (sub && Notification.permission === "granted") {
        const r = await pedir("/api/push?endpoint=" + encodeURIComponent(sub.endpoint)).catch(() => ({}));
        ativo = !!r.ativo;
        if (!ativo) await pedir("/api/push", { method: "POST", body: JSON.stringify({ sub: sub.toJSON() }) }).then(() => (ativo = true)).catch(() => {});
      }
      estado = ativo
        ? "✓ Notificações ativas neste aparelho: recebes as mensagens novas quando não tens o chat aberto, e um aviso especial quando alguém te menciona (@" + escapar(eu.name.split(/\s+/)[0]) + ")."
        : "Recebe um aviso no telemóvel ou no PC quando chega uma mensagem e não tens o chat aberto.";
      b.hidden = false;
      b.textContent = ativo ? "Desligar notificações" : "Ativar notificações";
      b.classList.toggle("secundario", ativo);
      b.dataset.ativo = ativo ? "1" : "";
    }
    $("notif-estado").innerHTML = estado;
    notifAtivo = ativo;

    // Aviso no topo do chat (até ser fechado)
    let fechado = false;
    try { fechado = localStorage.getItem("sabi-aviso-app") === "1"; } catch {}
    const falta = !instalada() || (temPush && !ativo && Notification.permission !== "denied");
    $("aviso-app").hidden = fechado || !falta;
    const pedirNotif = temPush && !ativo && Notification.permission === "default";
    $("aviso-app-texto").textContent = pedirNotif ? "Ativa as notificações para saberes quando chegam mensagens." : "Instala o chat como app no telemóvel e no PC.";
    $("btn-aviso-app").textContent = pedirNotif ? "Ativar" : "Como?";
    // Na app instalada, o aviso das notificações não se pode esconder até estarem ativas.
    if (pedirNotif && instalada()) $("aviso-app").hidden = false;
    if (!$("boas-vindas").hidden) desenharBoasVindas();
  }

  $("btn-instalar").addEventListener("click", async () => {
    if (!pedidoInstalar) return;
    pedidoInstalar.prompt();
    await pedidoInstalar.userChoice.catch(() => {});
    pedidoInstalar = null;
    estadoApp();
  });
  $("btn-notif").addEventListener("click", async () => {
    const b = $("btn-notif");
    b.disabled = true;
    try {
      if (b.dataset.ativo) await desligarNotificacoes();
      else await ligarNotificacoes();
    } catch (err) {
      alert("Não foi possível ativar as notificações: " + err.message);
    } finally {
      b.disabled = false;
    }
  });
  $("btn-aviso-app").addEventListener("click", async () => {
    if (temPush && !notifAtivo && Notification.permission === "default") return ligarNotificacoes().catch(() => {});
    if (pedidoInstalar && !instalada()) return $("btn-instalar").click();
    $("btn-membros").click();
    setTimeout(() => $("app-titulo").scrollIntoView({ block: "start" }), 50);
  });
  $("btn-aviso-fechar").addEventListener("click", () => {
    $("aviso-app").hidden = true;
    try { localStorage.setItem("sabi-aviso-app", "1"); } catch {}
  });

  // Entrar colando o link (a app instalada no iPhone não partilha a sessão do Safari).
  $("colar-link").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = $("colar-link-texto").value.trim();
    const token = v.includes("#") ? v.slice(v.indexOf("#") + 1) : v;
    try {
      await pedir("/api/entrar", { method: "POST", body: JSON.stringify({ token: decodeURIComponent(token) }) });
      $("colar-link-texto").value = "";
      entrar();
    } catch {
      $("porta-texto").textContent = "Esse link não é válido. Confirma que copiaste o link completo, ou pede um novo a um dos sócios.";
    }
  });

  entrar();
})();
