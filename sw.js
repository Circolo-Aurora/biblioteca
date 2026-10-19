/* Service worker della biblioteca: rende il sito installabile come app e lo apre anche con poca rete.
   - pagine HTML: prima la rete (così gli aggiornamenti arrivano subito), se manca la copia salvata;
   - immagini, icone, font e lettore di codici a barre: dalla copia salvata, scaricati una volta;
   - Apps Script, Google Books, Open Library: sempre dalla rete, mai salvati.
   Se cambi un'immagine o un'icona, aumenta VERSIONE: i telefoni scaricano tutto di nuovo. */
const VERSIONE = "biblioteca-v3";
const DA_SALVARE = [
  "./", "index.html", "admin.html", "manifest.webmanifest",
  "assets/logo-aurora.png", "assets/icona-biblioteca.png",
  "assets/icone/icon-192.png", "assets/icone/favicon-32.png", "assets/icone/favicon-16.png"
];
const ESTERNI_DA_SALVARE = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSIONE).then(c => c.addAll(DA_SALVARE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(chiavi => Promise.all(chiavi.filter(k => k !== VERSIONE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const url = new URL(r.url);
  if (url.origin !== location.origin) {
    if (ESTERNI_DA_SALVARE.test(url.hostname)) e.respondWith(primaCopia(r));
    return;
  }
  if (r.mode === "navigate" || /\.html$|\/$|\.webmanifest$/.test(url.pathname)) e.respondWith(primaRete(r));
  else e.respondWith(primaCopia(r));
});

async function primaRete(r) {
  const cache = await caches.open(VERSIONE);
  try {
    const risposta = await Promise.race([
      fetch(r),
      new Promise((_, no) => setTimeout(() => no(new Error("lenta")), 5000))
    ]);
    if (risposta.ok) cache.put(r, risposta.clone());
    return risposta;
  } catch (err) {
    return (await cache.match(r, { ignoreSearch: true })) || (await cache.match("index.html")) || Response.error();
  }
}

async function primaCopia(r) {
  const cache = await caches.open(VERSIONE);
  const salvata = await cache.match(r);
  if (salvata) return salvata;
  const risposta = await fetch(r);
  if (risposta.ok || risposta.type === "opaque") cache.put(r, risposta.clone());
  return risposta;
}
