/* ============================================================
   data.js — Couche données (100% temps réel, sans clé API).

   - Crypto  : Binance REST (klines) + WebSocket, fallback d'hosts
               et reconnexion auto. Si Binance est injoignable,
               bascule sur Yahoo (BTC-USD, etc.) — toujours du réel.
   - Forex   : Yahoo Finance v8 via le proxy serveur (/api/yahoo),
     & Stocks  polling ~5 s (Yahoo n'offre pas de WS public gratuit).

   Le mode "démo" (random walk) a été RETIRÉ : toutes les sources
   sont désormais des cotations réelles.

   Format bougie interne, utilisé partout :
   { time: <sec unix>, open, high, low, close, volume }
   ============================================================ */

import { clamp } from './utils.js';

/* ============================================================
   SANITISATION DES BOUGIES — invariants lightweight-charts.

   lightweight-charts exige des bougies :
   1. à timestamps STRICTEMENT CROISSANTS et UNIQUES ;
   2. avec des valeurs O/H/L/C finies ;
   3. dont high = max(o,h,l,c) et low = min(o,h,l,c).

   Yahoo (et parfois Binance en bord de fenêtre) viole ces règles :
   - bougie « en cours » qui DUPLIQUE le timestamp de la précédente ;
   - séries non triées après agrégation/poll ;
   - high/low qui n'encadrent pas open/close (arrondis du fournisseur)
     → corps de bougie dégénérés, mèches absentes, « trous » visuels.

   Cette fonction normalise tout cela de façon idempotente. Appelée
   sur CHAQUE série avant affichage/analyse.
   ============================================================ */
function sanitizeCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  // 1) Garder uniquement les bougies entièrement valides (valeurs finies).
  const valid = [];
  for (const c of candles) {
    const t = Number(c.time);
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) ||
        !Number.isFinite(l) || !Number.isFinite(cl)) continue;
    if (o <= 0 || cl <= 0) continue; // prix nul/négatif = donnée corrompue
    valid.push({
      time: Math.floor(t),
      open: o,
      // 3) Forcer high/low à réellement encadrer le corps (cohérence OHLC).
      high: Math.max(o, h, l, cl),
      low: Math.min(o, h, l, cl),
      close: cl,
      volume: Number.isFinite(Number(c.volume)) ? Math.max(0, Number(c.volume)) : 0,
    });
  }
  if (valid.length === 0) return [];

  // 2) Trier par temps croissant.
  valid.sort((a, b) => a.time - b.time);

  // 4) Dédupliquer : à timestamp égal, garder la DERNIÈRE (donnée la plus
  //    fraîche issue du poll). On écrase l'entrée précédente du même bucket.
  const out = [];
  for (const c of valid) {
    if (out.length && out[out.length - 1].time === c.time) {
      out[out.length - 1] = c;
    } else {
      out.push(c);
    }
  }
  return out;
}

// ----- Catalogue de symboles -----
// `source` = provider primaire. `yahoo` = symbole Yahoo (forex avec
// suffixe `=X`, crypto avec `-USD` pour le fallback).
export const SYMBOLS = {
  crypto: [
    { id: 'BTCUSDT', label: 'BTC/USDT', desc: 'Bitcoin', source: 'binance', yahoo: 'BTC-USD' },
    { id: 'ETHUSDT', label: 'ETH/USDT', desc: 'Ethereum', source: 'binance', yahoo: 'ETH-USD' },
    { id: 'SOLUSDT', label: 'SOL/USDT', desc: 'Solana', source: 'binance', yahoo: 'SOL-USD' },
    { id: 'BNBUSDT', label: 'BNB/USDT', desc: 'BNB', source: 'binance', yahoo: 'BNB-USD' },
    { id: 'XRPUSDT', label: 'XRP/USDT', desc: 'Ripple', source: 'binance', yahoo: 'XRP-USD' },
    { id: 'DOGEUSDT', label: 'DOGE/USDT', desc: 'Dogecoin', source: 'binance', yahoo: 'DOGE-USD' },
  ],
  forex: [
    { id: 'EURUSD', label: 'EUR/USD', desc: 'Euro / Dollar', source: 'yahoo', yahoo: 'EURUSD=X' },
    { id: 'GBPUSD', label: 'GBP/USD', desc: 'Livre / Dollar', source: 'yahoo', yahoo: 'GBPUSD=X' },
    { id: 'USDJPY', label: 'USD/JPY', desc: 'Dollar / Yen', source: 'yahoo', yahoo: 'USDJPY=X' },
    { id: 'AUDUSD', label: 'AUD/USD', desc: 'Aussie / Dollar', source: 'yahoo', yahoo: 'AUDUSD=X' },
    { id: 'USDCHF', label: 'USD/CHF', desc: 'Dollar / Franc suisse', source: 'yahoo', yahoo: 'USDCHF=X' },
    { id: 'USDCAD', label: 'USD/CAD', desc: 'Dollar / Dollar canadien', source: 'yahoo', yahoo: 'USDCAD=X' },
  ],
  stocks: [
    { id: 'AAPL', label: 'AAPL', desc: 'Apple Inc.', source: 'yahoo', yahoo: 'AAPL' },
    { id: 'TSLA', label: 'TSLA', desc: 'Tesla Inc.', source: 'yahoo', yahoo: 'TSLA' },
    { id: 'NVDA', label: 'NVDA', desc: 'NVIDIA Corp.', source: 'yahoo', yahoo: 'NVDA' },
    { id: 'MSFT', label: 'MSFT', desc: 'Microsoft', source: 'yahoo', yahoo: 'MSFT' },
    { id: 'AMZN', label: 'AMZN', desc: 'Amazon', source: 'yahoo', yahoo: 'AMZN' },
    { id: 'GOOGL', label: 'GOOGL', desc: 'Alphabet', source: 'yahoo', yahoo: 'GOOGL' },
  ],
};

export const TIMEFRAMES = [
  { id: '1m', label: '1m', sec: 60 },
  { id: '5m', label: '5m', sec: 300 },
  { id: '15m', label: '15m', sec: 900 },
  { id: '1h', label: '1H', sec: 3600 },
  { id: '4h', label: '4H', sec: 14400 },
  { id: '1d', label: '1D', sec: 86400 },
  { id: '1w', label: '1W', sec: 604800 },
];

export function findSymbol(id) {
  for (const cat of Object.keys(SYMBOLS)) {
    const s = SYMBOLS[cat].find((x) => x.id === id);
    if (s) return { ...s, category: cat };
  }
  return null;
}

/* ============================================================
   YAHOO — mapping timeframe → (interval, range) + polling.

   Contraintes Yahoo : le 1m n'est dispo que sur ~7 jours, les
   intraday sur ~60 j. `range` = historique chargé au départ ;
   `poll` = fenêtre légère re-fetchée toutes les X s pour le live.
   `resample` = facteur d'agrégation (4h non natif → 4×60m).
   ============================================================ */
const YF_TF = {
  '1m':  { interval: '1m',  range: '5d',  poll: '1d'  },
  '5m':  { interval: '5m',  range: '1mo', poll: '1d'  },
  '15m': { interval: '15m', range: '1mo', poll: '5d'  },
  '1h':  { interval: '60m', range: '3mo', poll: '5d'  },
  '4h':  { interval: '60m', range: '6mo', poll: '1mo', resample: 4 },
  '1d':  { interval: '1d',  range: '2y',  poll: '1mo' },
  '1w':  { interval: '1wk', range: '10y', poll: '6mo' },
};

/** Agrège des bougies en buckets de `bucketSec` (alignés sur l'epoch UTC). */
function resampleCandles(candles, bucketSec) {
  // Entrée triée/dédupliquée pour que l'agrégation soit déterministe.
  candles = sanitizeCandles(candles);
  const out = [];
  let cur = null;
  for (const c of candles) {
    const bucket = Math.floor(c.time / bucketSec) * bucketSec;
    if (!cur || cur.time !== bucket) {
      if (cur) out.push(cur);
      cur = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* Base du proxy Yahoo.
   - En local (server.py / server.js) : laisser vide → '/api/yahoo'.
   - Sur GitHub Pages : définir window.YAHOO_PROXY_URL dans index.html
     vers votre Cloudflare Worker, ex. 'https://xxx.workers.dev/api/yahoo'.
   Le Worker accepte les mêmes paramètres (?symbol=&interval=&range=). */
const YAHOO_PROXY =
  (typeof window !== 'undefined' && window.YAHOO_PROXY_URL) || '/api/yahoo';

/** Appel proxy Yahoo → { meta, candles } (bougies au format interne). */
async function fetchYahooRaw(yahooSymbol, interval, range) {
  const url = `${YAHOO_PROXY}?symbol=${encodeURIComponent(yahooSymbol)}&interval=${interval}&range=${range}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

/** Charge l'historique Yahoo pour (symbole, timeframe), resamplé si besoin. */
async function fetchYahooKlines(yahooSymbol, tfId, limit) {
  const map = YF_TF[tfId] || YF_TF['1h'];
  const { candles } = await fetchYahooRaw(yahooSymbol, map.interval, map.range);
  let series = candles;
  if (map.resample) series = resampleCandles(series, TIMEFRAMES.find((t) => t.id === tfId).sec);
  else series = sanitizeCandles(series); // resampleCandles sanitise déjà en interne
  return series.slice(-limit);
}

/* ============================================================
   CHARGEMENT HISTORIQUE — point d'entrée unique.
   Retourne { candles, provider, delayed }.
     provider : 'binance' | 'yahoo'
     delayed  : true si données différées (Yahoo, ~1–15 min)
   ============================================================ */
const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://data-api.binance.vision',
];

export async function fetchKlines(symbolId, tfId, limit = 500) {
  const sym = findSymbol(symbolId);
  if (!sym) throw new Error(`Symbole inconnu: ${symbolId}`);

  // ----- Forex & actions : Yahoo uniquement -----
  if (sym.source === 'yahoo') {
    const candles = await fetchYahooKlines(sym.yahoo, tfId, limit);
    if (!candles.length) throw new Error('Aucune cotation Yahoo');
    return { candles, provider: 'yahoo', delayed: true };
  }

  // ----- Crypto : Binance, puis Yahoo en secours -----
  let lastErr = null;
  for (const host of BINANCE_HOSTS) {
    try {
      const url = `${host}/api/v3/klines?symbol=${symbolId}&interval=${tfId}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const candles = sanitizeCandles(raw.map((k) => ({
        time: Math.floor(k[0] / 1000),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      })));
      return { candles, provider: 'binance', delayed: false };
    } catch (err) {
      lastErr = err;
      console.warn('Binance host failed:', host, err.message);
    }
  }
  // Secours : Yahoo (BTC-USD…) — données réelles différées, jamais de démo.
  console.warn('Binance injoignable, bascule sur Yahoo:', lastErr?.message);
  const candles = await fetchYahooKlines(sym.yahoo, tfId, limit);
  if (!candles.length) throw new Error('Crypto indisponible (Binance + Yahoo)');
  return { candles, provider: 'yahoo', delayed: true };
}

/* ============================================================
   STREAMS TEMPS RÉEL
   ============================================================ */

// ----- WebSocket Binance avec reconnexion auto (crypto) -----
const WS_HOSTS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];

export function openKlineStream(symbolId, tfId, onCandle, onStatus) {
  let ws = null;
  let closed = false;
  let attempts = 0;
  let hostIdx = 0;

  function connect() {
    if (closed) return;
    const host = WS_HOSTS[hostIdx % WS_HOSTS.length];
    const url = `${host}/ws/${symbolId.toLowerCase()}@kline_${tfId}`;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => { attempts = 0; onStatus?.('connected'); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const k = msg.k;
        if (!k) return;
        onCandle({
          candle: {
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
          },
          isClosed: k.x === true,
        });
      } catch (_) { /* message non-kline ignoré */ }
    };
    ws.onclose = () => { if (!closed) { onStatus?.('reconnecting'); scheduleReconnect(); } };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function scheduleReconnect() {
    attempts += 1;
    hostIdx += 1;
    const delay = clamp(500 * 2 ** attempts, 1000, 15000);
    setTimeout(connect, delay);
  }

  connect();
  return { close() { closed = true; try { ws?.close(); } catch (_) {} } };
}

// ----- Polling Yahoo (forex / actions / fallback crypto) -----
/**
 * Yahoo n'a pas de WebSocket public : on simule le direct en
 * re-interrogeant le proxy toutes les ~5 s (poli, pas de rate-limit).
 * Émet { candle, isClosed } comme openKlineStream :
 *  - la dernière bougie est ré-émise en update (isClosed:false) ;
 *  - dès qu'une bougie plus récente apparaît, la précédente est
 *    émise comme clôturée (isClosed:true).
 */
export function openYahooStream(yahooSymbol, tfId, onCandle, onStatus) {
  const map = YF_TF[tfId] || YF_TF['1h'];
  const bucketSec = TIMEFRAMES.find((t) => t.id === tfId).sec;
  // Daily/weekly : inutile de marteler — 15 s suffit. Intraday : 5 s.
  const pollMs = bucketSec >= 86400 ? 15000 : 5000;
  let currentTime = null;
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const { candles } = await fetchYahooRaw(yahooSymbol, map.interval, map.poll);
      // resampleCandles sanitise déjà ; sinon on sanitise explicitement
      // pour garantir des bougies live valides (high/low cohérents).
      const series = map.resample ? resampleCandles(candles, bucketSec) : sanitizeCandles(candles);
      if (!series.length) { onStatus?.('reconnecting'); return; }

      const last = series[series.length - 1];
      if (currentTime === null) {
        currentTime = last.time;
        onCandle({ candle: last, isClosed: false });
      } else if (last.time > currentTime) {
        // La bougie précédente (celle d'index currentTime) est finalisée.
        const closedBar = series.find((c) => c.time === currentTime);
        if (closedBar) onCandle({ candle: closedBar, isClosed: true });
        currentTime = last.time;
        onCandle({ candle: last, isClosed: false });
      } else {
        // Même bougie en cours : simple mise à jour live.
        onCandle({ candle: last, isClosed: false });
      }
      onStatus?.('connected');
    } catch (err) {
      // On garde le polling actif ; l'UI passe en "reconnexion".
      onStatus?.('reconnecting');
    }
  }

  tick();
  timer = setInterval(tick, pollMs);
  return { close() { stopped = true; clearInterval(timer); } };
}
