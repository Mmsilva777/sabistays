// Service worker mínimo: permite instalar o chat como app no telemóvel.
// Não guarda mensagens em cache; tudo vem sempre do servidor.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
