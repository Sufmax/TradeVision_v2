/* ============================================================
   indicators.js — Indicateurs et niveaux S/R.

   CONTRAT ANTI-LOOKAHEAD (INV-1) :
   Toutes les fonctions de ce module reçoivent un tableau de
   bougies `candles` et ne lisent QUE ce tableau. En replay,
   l'appelant passe le slice tronqué [0..t] — jamais le dataset
   complet. Aucune fonction ici n'accède à un état global ni à
   un index "futur".
   ============================================================ */

import { mean, linearRegression } from './utils.js';

/**
 * ATR (Average True Range) simple sur `period` bougies.
 * Utilisé pour les tolérances adaptatives et le sizing SL/TP.
 */
export function computeATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const n = Math.min(period, candles.length - 1);
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    sum += tr;
  }
  return sum / n;
}

/**
 * Pente de tendance normalisée sur les clôtures :
 * régression linéaire, slope exprimée en % du prix par bougie.
 * > +0.08%/bougie ≈ tendance haussière claire, < -0.08% baissière.
 */
export function computeTrend(candles, lookback = 40) {
  const slice = candles.slice(-Math.min(lookback, candles.length));
  if (slice.length < 5) return { slopePct: 0, r2: 0, direction: 'flat' };
  const closes = slice.map((c) => c.close);
  const { slope, r2 } = linearRegression(closes);
  const avg = mean(closes);
  const slopePct = avg === 0 ? 0 : (slope / avg) * 100;
  let direction = 'flat';
  if (slopePct > 0.05 && r2 > 0.3) direction = 'up';
  else if (slopePct < -0.05 && r2 > 0.3) direction = 'down';
  return { slopePct, r2, direction };
}

/**
 * EMA (moyenne mobile exponentielle) sur `period`, renvoyée comme série
 * alignée sur `closes` (les premières valeurs valent la 1re clôture).
 */
function ema(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length);
  out[0] = closes[0];
  for (let i = 1; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

/**
 * CONFLUENCE DE TENDANCE — cœur directionnel issu du backtesting multi-actifs.
 *
 * Le benchmark (256 backtests crypto/forex/actions, 1d & 1h) a montré que SEULE
 * la famille « suivi de tendance » généralise positivement (EMA crossover PF≈2.7,
 * breakout, momentum), tandis que les approches à contre-tendance (RSI, MACD,
 * Bollinger, mean-reversion) perdent quasi partout (PF<0.85). On construit donc
 * un score directionnel par VOTE de 3 signaux standard robustes :
 *
 *   1. EMA crossover (12 vs 26) : tendance de fond.
 *   2. Momentum / ROC (sur `roc` bougies) : accélération du prix.
 *   3. Breakout de Donchian (sur `don` bougies, hors bougie courante) :
 *      cassure d'un extrême récent.
 *
 * Direction = signe de la somme des votes ; `votes` = nombre de signaux alignés
 * (0..3) → utilisé comme filtre de qualité (on n'entre qu'avec ≥2 votes alignés).
 * INV-1 : ne lit que `candles` (slice passé), aucun accès au futur.
 */
export function computeConfluence(candles, { emaFast = 12, emaSlow = 26, roc = 10, don = 20 } = {}) {
  const n = candles.length;
  if (n < Math.max(emaSlow, roc, don) + 2) {
    return { dir: 'none', votes: 0, score: 0, ema: 0, mom: 0, brk: 0, emaSlowVal: null, hh: null, ll: null };
  }
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, emaFast);
  const slow = ema(closes, emaSlow);

  // 1) État EMA : signe de l'écart fast-slow.
  const emaVote = Math.sign(fast[n - 1] - slow[n - 1]);

  // 2) Momentum ROC : variation sur `roc` bougies.
  const rocVal = (closes[n - 1] - closes[n - 1 - roc]) / closes[n - 1 - roc];
  const momVote = Math.sign(rocVal);

  // 3) Breakout de Donchian : la bougie courante casse-t-elle l'extrême des
  //    `don` bougies PRÉCÉDENTES (exclut la courante → pas d'auto-référence).
  let hh = -Infinity, ll = Infinity;
  for (let i = n - 1 - don; i < n - 1; i++) {
    if (candles[i].high > hh) hh = candles[i].high;
    if (candles[i].low < ll) ll = candles[i].low;
  }
  const close = closes[n - 1];
  const brkVote = close > hh ? 1 : close < ll ? -1 : 0;

  const score = emaVote + momVote + brkVote;
  const dir = score > 0 ? 'long' : score < 0 ? 'short' : 'none';
  // votes alignés = nombre de signaux qui pointent dans la direction dominante
  const votes = dir === 'none' ? 0 : [emaVote, momVote, brkVote].filter((v) => Math.sign(v) === Math.sign(score)).length;

  // emaSlowVal / hh / ll : exposés pour mesurer l'EXTENSION du prix (anti-chasing).
  // Une entrée loin de l'EMA lente ou très au-delà de la borne cassée = mouvement
  // déjà réalisé → on évite de « courir après » (cf. recherche : chasing sous-performe).
  return { dir, votes, score, ema: emaVote, mom: momVote, brk: brkVote, roc: rocVal, emaSlowVal: slow[n - 1], hh, ll };
}

/** Ratio volume récent (5 dernières) vs moyenne (20 dernières). */
export function computeVolumeRatio(candles) {
  if (candles.length < 10) return 1;
  const vols = candles.map((c) => c.volume);
  const recent = mean(vols.slice(-5));
  const base = mean(vols.slice(-20));
  return base === 0 ? 1 : recent / base;
}

/**
 * Swings highs/lows par force adaptative.
 * Force k : un swing high a k bougies plus basses de chaque côté.
 * TUNING: essaie force 2 d'abord ; si < 4 swings trouvés,
 * fallback force 1 (marchés très lisses / petites fenêtres).
 * NOTE : un swing d'index i n'est confirmé qu'avec k bougies
 * APRÈS i — mais ces bougies sont déjà dans le slice passé,
 * donc aucune fuite : on détecte des swings du passé confirmés.
 */
export function findSwings(candles, preferredStrength = 2) {
  for (const k of [preferredStrength, 1]) {
    const swings = extractSwings(candles, k);
    if (swings.length >= 4) return { swings, strength: k };
  }
  return { swings: extractSwings(candles, 1), strength: 1 };
}

function extractSwings(candles, k) {
  const swings = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= k; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high < candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low > candles[i + j].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ index: i, time: candles[i].time, price: candles[i].high, type: 'high' });
    if (isLow) swings.push({ index: i, time: candles[i].time, price: candles[i].low, type: 'low' });
  }
  return swings;
}

/**
 * Niveaux ronds psychologiques proches du prix courant.
 * Granularité adaptée à la magnitude (ex : BTC → 1000/5000,
 * EURUSD → 0.005/0.01).
 */
export function roundLevels(price, count = 4) {
  if (price <= 0) return [];
  const magnitude = Math.pow(10, Math.floor(Math.log10(price)));
  const steps = [magnitude / 10, magnitude / 4, magnitude / 2];
  const out = new Set();
  for (const step of steps) {
    const base = Math.round(price / step) * step;
    for (let i = -count; i <= count; i++) {
      const lvl = base + i * step;
      // Garde uniquement les niveaux dans ±8% du prix
      if (lvl > 0 && Math.abs(lvl - price) / price < 0.08) out.add(lvl);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Niveaux S/R consolidés :
 * 1. swings (poids = nb de touches),
 * 2. niveaux ronds (poids faible),
 * 3. clustering par seuil relatif (tolérance ~ 0.35 * ATR,
 *    bornée en % du prix).
 * Retourne [{ price, kind: 'support'|'resistance'|'round', touches, strength }]
 */
export function computeSRLevels(candles, maxLevels = 8) {
  if (candles.length < 20) return [];
  const lastClose = candles[candles.length - 1].close;
  const atr = computeATR(candles, 14);
  // Tolérance de clustering : relative au prix, calée sur l'ATR
  const tol = Math.max(atr * 0.35, lastClose * 0.0008);

  const { swings } = findSwings(candles, 2);
  const points = [];
  for (const s of swings) {
    points.push({ price: s.price, w: 1.0, isHigh: s.type === 'high' });
  }
  for (const r of roundLevels(lastClose)) {
    points.push({ price: r, w: 0.4, isRound: true });
  }
  if (!points.length) return [];

  // Clustering glouton par proximité
  points.sort((a, b) => a.price - b.price);
  const clusters = [];
  let cur = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].price - cur[cur.length - 1].price <= tol) {
      cur.push(points[i]);
    } else {
      clusters.push(cur);
      cur = [points[i]];
    }
  }
  clusters.push(cur);

  const levels = clusters.map((cl) => {
    const wSum = cl.reduce((s, p) => s + p.w, 0);
    const price = cl.reduce((s, p) => s + p.price * p.w, 0) / wSum;
    const touches = cl.filter((p) => !p.isRound).length;
    const hasRound = cl.some((p) => p.isRound);
    const highCount = cl.filter((p) => p.isHigh).length;
    const lowCount = cl.filter((p) => p.isHigh === false).length;
    let kind;
    if (touches === 0 && hasRound) kind = 'round';
    else if (price > lastClose) kind = 'resistance';
    else kind = 'support';
    // Ces compteurs affinent : un niveau touché par des highs ET des lows est plus fort
    const strength = Math.min(1, (touches * 0.25) + (hasRound ? 0.15 : 0) + (highCount > 0 && lowCount > 0 ? 0.2 : 0));
    return { price, kind, touches, strength };
  });

  // Garde les plus forts, proches du prix
  return levels
    .filter((l) => Math.abs(l.price - lastClose) / lastClose < 0.12)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxLevels)
    .sort((a, b) => a.price - b.price);
}

/**
 * Alerte de proximité : niveau S/R le plus proche si le prix
 * est à moins de 0.5 * ATR.
 */
export function nearestSRAlert(candles, levels) {
  if (!candles.length || !levels.length) return null;
  const price = candles[candles.length - 1].close;
  const atr = computeATR(candles, 14);
  if (atr === 0) return null;
  let best = null;
  for (const l of levels) {
    const d = Math.abs(l.price - price);
    if (d < atr * 0.5 && (!best || d < best.dist)) {
      best = { level: l, dist: d };
    }
  }
  return best;
}
