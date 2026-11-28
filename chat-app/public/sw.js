// Service worker do chat: torna-o instalável como app e mostra notificações.
// Não guarda mensagens em cache; tudo vem sempre do servidor.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { corpo: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    // Se o chat estiver aberto e à frente, não incomoda.
    const janelas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (janelas.some((j) => j.visibilityState === "visible" && j.focused)) return;
    const atuais = await self.registration.getNotifications({ tag: "sabi-chat" });
    const n = atuais.length ? (atuais[0].data && atuais[0].data.n) || 1 : 0;
    await self.registration.showNotification(d.titulo || "Sabi Stays", {
      body: n ? `${d.corpo || ""}\n(+${n} ${n === 1 ? "mensagem" : "mensagens"})` : d.corpo || "Nova mensagem",
      tag: "sabi-chat",
      renotify: true,
      icon: "/img/icon-192.png",
      badge: "/img/badge-96.png",
      data: { url: "/", n: n + 1 },
      requireInteraction: !!d.urgente,
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const j of janelas) if ("focus" in j) return j.focus();
    return self.clients.openWindow("/");
  })());
});

// Necessário em alguns browsers para oferecer a instalação.
self.addEventListener("fetch", () => {});
