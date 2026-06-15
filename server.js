/* ============================================================
   server.js — Serveur statique + proxy Yahoo Finance.

   Pourquoi un serveur ? Le navigateur ne peut PAS appeler Yahoo
   directement (CORS bloqué + User-Agent requis). On expose donc :

     GET /api/yahoo?symbol=<SYM>&interval=<I>&range=<R>

   qui appelle Yahoo v8 côté serveur (avec User-Agent), normalise
   la réponse en bougies OHLCV internes, et renvoie du JSON propre.

   Zéro dépendance : http + fetch natif (Node 18+). Aucun build.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_FALLBACK = 'https://query2.finance.yahoo.com/v8/finance/chart';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/* ---------------- Proxy Yahoo ---------------- */

async function fetchYahoo(symbol, interval, range) {
  // =X (forex) et ^ (indices) doivent être encodés dans le chemin.
  const enc = encodeURIComponent(symbol);
  const qs = `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const hosts = [YAHOO_BASE, YAHOO_FALLBACK];
  let lastErr = null;

  for (const base of hosts) {
    try {
      const res = await fetch(`${base}/${enc}${qs}`, {
        headers: {
          // SANS User-Agent, Yahoo renvoie souvent 403/429.
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      if (!r || !r.timestamp) throw new Error('Réponse Yahoo vide');
      return normalize(r);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Yahoo injoignable');
}

/** Transforme la réponse Yahoo en { meta, candles[] } au format interne. */
function normalize(r) {
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    // Yahoo insère des trous (null) sur certaines minutes : on les saute.
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      time: ts[i],
      open: o,
      high: h,
      low: l,
      close: c,
      volume: q.volume?.[i] ?? 0,
    });
  }
  const meta = r.meta || {};
  return {
    meta: {
      symbol: meta.symbol,
      price: meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
      currency: meta.currency,
      time: meta.regularMarketTime,
      timezone: meta.exchangeTimezoneName,
    },
    candles,
  };
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/* ---------------- Fichiers statiques ---------------- */

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Anti path-traversal : on résout puis on vérifie qu'on reste sous ROOT.
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ---------------- Routeur ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (u.pathname === '/api/yahoo') {
    const symbol = u.searchParams.get('symbol');
    const interval = u.searchParams.get('interval') || '15m';
    const range = u.searchParams.get('range') || '1mo';
    if (!symbol) return sendJSON(res, 400, { error: 'symbol requis' });
    try {
      const data = await fetchYahoo(symbol, interval, range);
      return sendJSON(res, 200, { ...data, ts: Date.now() });
    } catch (err) {
      return sendJSON(res, 502, { error: String(err.message || err) });
    }
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`TradeVision V3 — http://localhost:${PORT}`);
});
