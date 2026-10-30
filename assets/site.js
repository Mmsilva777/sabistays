(function () {
  var root = document.documentElement;

  // Idioma: ?lang=en > escolha guardada > idioma do navegador
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  var q = new URLSearchParams(location.search);
  var lang = q.get('lang') || store('sabi-lang') || ((navigator.language || 'pt').slice(0, 2) === 'pt' ? 'pt' : 'en');
  if (lang !== 'pt' && lang !== 'en') lang = 'pt';

  function setLang(l) {
    lang = l;
    root.setAttribute('data-lang', l);
    root.setAttribute('lang', l === 'pt' ? 'pt' : 'en');
    document.querySelectorAll('[data-set-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-set-lang') === l ? 'true' : 'false');
    });
    document.querySelectorAll('option[data-' + l + ']').forEach(function (o) { o.textContent = o.getAttribute('data-' + l); });
    document.querySelectorAll('input[name="idioma"]').forEach(function (i) { i.value = l; });
    store('sabi-lang', l);
    sim();
  }
  document.querySelectorAll('[data-set-lang]').forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.getAttribute('data-set-lang')); });
  });

  // Origem da visita (para saber que post ou anúncio trouxe cada inscrição)
  var origem = ['utm_source', 'utm_medium', 'utm_campaign', 'ref']
    .map(function (k) { return q.get(k) ? k.replace('utm_', '') + '=' + q.get(k) : ''; })
    .filter(Boolean).join(' · ');
  if (!origem && document.referrer && document.referrer.indexOf(location.host) < 0) {
    try { origem = 'referrer=' + new URL(document.referrer).hostname; } catch (e) {}
  }
  if (origem) store('sabi-origem', origem); else origem = store('sabi-origem') || 'direto';
  document.querySelectorAll('input[name="origem"]').forEach(function (i) { i.value = origem; });

  // Cabeçalho com linha ao fazer scroll
  var top = document.getElementById('top');
  addEventListener('scroll', function () { top.classList.toggle('scrolled', scrollY > 8); }, { passive: true });

  // Simulação (mesmas fórmulas do modelo financeiro)
  var PLATAFORMA = 0.03, SABI = 0.20;
  var $ = function (id) { return document.getElementById(id); };
  function eur(n) {
    return Math.round(n).toLocaleString(lang === 'pt' ? 'pt-PT' : 'en-GB').replace(/,/g, lang === 'pt' ? ' ' : ',') + ' €';
  }
  function sim() {
    if (!$('preco')) return;
    var preco = +$('preco').value, ocup = +$('ocup').value / 100;
    var noites = 365 * ocup, bruto = noites * preco;
    var plat = bruto * PLATAFORMA, liquido = bruto - plat, sabi = liquido * SABI;
    $('preco-out').textContent = preco + ' €';
    $('ocup-out').textContent = Math.round(ocup * 100) + '%';
    $('noites').textContent = Math.round(noites);
    $('bruto').textContent = eur(bruto);
    $('plataforma').textContent = '−' + eur(plat);
    $('sabi').textContent = '−' + eur(sabi);
    $('liquido').textContent = eur(liquido - sabi);
  }
  ['preco', 'ocup'].forEach(function (id) { var el = $(id); if (el) el.addEventListener('input', sim); });

  // Formulários (Netlify Forms; fora do domínio funciona em modo de pré-visualização)
  var MSG = {
    pt: { falta: 'Preenche os campos em falta e aceita a política de privacidade.', enviar: 'A enviar…', erro: 'Não foi possível enviar. Tenta de novo ou escreve para ola@sabistays-sal.com.',
          okP: 'Obrigado! A tua casa está na lista.', okPt: 'Vamos entrar em contacto nas próximas semanas para uma conversa de 15 minutos.',
          okH: 'Obrigado! Estás na lista.', okHt: 'Avisamos-te por email quando as primeiras casas abrirem.', prev: '(Pré-visualização: nada foi enviado.)' },
    en: { falta: 'Please fill in the missing fields and accept the privacy policy.', enviar: 'Sending…', erro: "Couldn't send. Please try again or email ola@sabistays-sal.com.",
          okP: "Thank you! Your home is on the list.", okPt: "We'll be in touch in the coming weeks for a 15-minute call.",
          okH: "Thank you! You're on the list.", okHt: "We'll email you when the first homes open.", prev: '(Preview: nothing was sent.)' }
  };
  var aoVivo = /(^|\.)sabistays-sal\.com$|netlify\.app$/.test(location.hostname);

  document.querySelectorAll('form.f').forEach(function (form) {
    var estado = form.querySelector('.estado');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var m = MSG[lang];
      if (!form.checkValidity()) {
        estado.className = 'estado full erro'; estado.textContent = m.falta;
        var bad = form.querySelector(':invalid'); if (bad) bad.focus();
        return;
      }
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true; estado.className = 'estado full'; estado.textContent = m.enviar;
      var dados = new URLSearchParams(new FormData(form)).toString();
      var envio = aoVivo
        ? fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: dados })
            .then(function (r) { if (!r.ok) throw new Error(r.status); })
        : new Promise(function (ok) { setTimeout(ok, 500); });
      envio.then(function () {
        var dono = form.getAttribute('name') === 'proprietarios';
        var box = form.parentNode;
        box.innerHTML = '<div class="feito" tabindex="-1"><h3></h3><p></p></div>';
        box.querySelector('h3').textContent = dono ? m.okP : m.okH;
        box.querySelector('p').textContent = (dono ? m.okPt : m.okHt) + (aoVivo ? '' : ' ' + m.prev);
        box.firstChild.focus();
        if (window.gtag) gtag('event', 'inscricao', { tipo: form.getAttribute('name') });
      }).catch(function () {
        btn.disabled = false; estado.className = 'estado full erro'; estado.textContent = m.erro;
      });
    });
  });

  setLang(lang);
})();
