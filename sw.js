/* Togethere — service worker
   Estratégia: network-first para arquivos do próprio site (sempre pega a versão
   nova quando há internet; usa o cache só quando estiver offline).
   Chamadas externas (planilha/Apps Script) e POSTs passam direto, sem cache. */
const CACHE = 'togethere-2026-07-24-b90';
const CORE = ['./', './index.html', './logo.png', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './manifest.json'];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(CORE); }).catch(function(){}));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){ if(k!==CACHE) return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  const req = e.request;
  if (req.method !== 'GET') return;                 // não intercepta POST (sincronização da nuvem)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // chamadas externas (Apps Script) passam direto

  e.respondWith(
    fetch(req).then(function(res){
      const copy = res.clone();
      caches.open(CACHE).then(function(c){ c.put(req, copy); }).catch(function(){});
      return res;
    }).catch(function(){
      return caches.match(req).then(function(m){ return m || caches.match('./index.html'); });
    })
  );
});
