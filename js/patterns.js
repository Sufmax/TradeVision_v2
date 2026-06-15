/* ============================================================
   patterns.js — Moteur de détection de patterns.

   ARCHITECTURE EN COUCHES (cf. spec <detection_engine>) :
   1. Extraction de swings (indicators.findSwings)
   2. Contexte : ATR, tendance, volume
   3. Scoring géométrique par pattern
   4. Ajustement contextuel (tendance, volume, proximité du niveau clé)
   5. Confirmation de cassure EN CLÔTURE uniquement + re-test + invalidation
   6. Seuil de bruit

   CONTRAT ANTI-LOOKAHEAD (INV-1) :
   `detectAllPatterns(candles)` ne lit QUE le tableau reçu.
   En replay, l'appelant passe le slice tronqué [0..t].
   Aucun accès global, aucun index au-delà de candles.length-1.

   Chaque détection retourne :
   { key, name, direction, confidence, keyLevel, target,
     windowSize, startIndex, endIndex, lines: [...], kind }
   - key : identifiant stable (type + indices des pivots) pour
     l'hystérésis du scanner
   - lines : segments structurels pour l'overlay
     [{ t1, p1, t2, p2, role: 'neckline'|'support'|'resistance'|'target' }]
   ============================================================ */

import { computeATR, computeTrend, computeVolumeRatio, findSwings } from './indicators.js';
import { mean, linearRegression, clamp } from './utils.js';

// Seuil de bruit de base. TUNING: 0.45 de base, durci à 0.52 en
// haute volatilité (ATR > 2.5% du prix) car le bruit y génère
// des structures fortuites.
const NOISE_FLOOR_BASE = 0.45;
const NOISE_FLOOR_HIGH_VOL = 0.52;

/**
 * Point d'entrée : détecte tous les patterns sur la fenêtre donnée.
 * @param {Array} candles - slice de bougies (en replay : tronqué à t)
 * @param {number} windowSize - taille de fenêtre analysée (les
 *   `windowSize` dernières bougies du slice)
 */
export function detectAllPatterns(candles, windowSize) {
  if (candles.length < 15) return [];
  const win = candles.slice(-Math.min(windowSize, candles.length));
  const offset = candles.length - win.length; // index absolu = offset + index local

  // --- Couche 2 : contexte ---
  const ctx = {
    atr: computeATR(candles, 14),
    trend: computeTrend(candles, Math.min(50, candles.length)),
    volRatio: computeVolumeRatio(candles),
    lastClose: candles[candles.length - 1].close,
    lastCandle: candles[candles.length - 1],
    candles,           // slice complet reçu (≤ t en replay) — utilisé pour la confirmation de clôture
    win,
    offset,
    windowSize: win.length,
  };
  if (ctx.atr === 0 || ctx.lastClose === 0) return [];
  ctx.atrPct = ctx.atr / ctx.lastClose;
  ctx.noiseFloor = ctx.atrPct > 0.025 ? NOISE_FLOOR_HIGH_VOL : NOISE_FLOOR_BASE;

  // --- Couche 1 : swings sur la fenêtre ---
  const { swings } = findSwings(win, 2);
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');

  const out = [];
  const push = (p) => { if (p && p.confidence >= ctx.noiseFloor) out.push(p); };

  push(detectDoubleTop(highs, lows, ctx));
  push(detectDoubleBottom(highs, lows, ctx));
  push(detectTripleTop(highs, lows, ctx));
  push(detectTripleBottom(highs, lows, ctx));
  push(detectHeadShoulders(highs, lows, ctx, false));
  push(detectHeadShoulders(lows, highs, ctx, true));
  push(...detectTrianglesWedges(highs, lows, ctx));
  push(detectFlag(ctx, 'bull'));
  push(detectFlag(ctx, 'bear'));

  // Patterns de bougies — intégrés au consensus avec une confiance
  // plafonnée (jamais des signaux forts isolés, cf. spec).
  out.push(...detectCandlePatterns(ctx));

  return out;
}

/* ============================================================
   HELPERS DE SCORING
   ============================================================ */

/**
 * Couche 4 : ajustement contextuel commun.
 * @param {number} base - score géométrique [0..1]
 * @param {object} opts - { isReversal, direction, keyLevel, ctx }
 */
function contextAdjust(base, { isReversal, direction, keyLevel, ctx }) {
  let conf = base;
  const t = ctx.trend.direction;

  // Tendance : un retournement bearish a plus de valeur après une
  // tendance haussière (il la "casse"), et inversement.
  if (isReversal) {
    const against = (direction === 'bearish' && t === 'up') || (direction === 'bullish' && t === 'down');
    const withTrend = (direction === 'bearish' && t === 'down') || (direction === 'bullish' && t === 'up');
    if (against) conf += 0.08;
    if (withTrend) conf -= 0.10;
  } else {
    // Continuation : gagne dans le sens de la tendance
    const withTrend = (direction === 'bullish' && t === 'up') || (direction === 'bearish' && t === 'down');
    const against = (direction === 'bullish' && t === 'down') || (direction === 'bearish' && t === 'up');
    if (withTrend) conf += 0.08;
    if (against) conf -= 0.12;
  }

  // Volume : expansion = conviction, anémie = méfiance
  if (ctx.volRatio > 1.3) conf += 0.05;
  else if (ctx.volRatio < 0.6) conf -= 0.06;

  // Proximité du niveau clé : un pattern dont le prix s'est éloigné
  // du niveau de cassure est moins actionnable.
  if (keyLevel != null) {
    const dist = Math.abs(ctx.lastClose - keyLevel) / ctx.atr;
    if (dist < 1.0) conf += 0.05;
    else if (dist > 4.0) conf -= 0.12;
    else if (dist > 2.5) conf -= 0.06;
  }

  return clamp(conf, 0, 1);
}

// Fenêtres d'actionnabilité d'un pattern (en bougies depuis la cassure).
// Au-delà, le pattern a « vécu » : son edge a disparu (cf. recherche : entrer
// tard après un mouvement étendu sous-performe).
const ACTION_BARS = 6;   // cassure fraîche = signal pleinement actionnable
const STALE_BARS = 14;   // au-delà : cassure trop ancienne → pattern périmé
const SPENT_PROGRESS = 0.8; // ≥80% du mouvement mesuré atteint → « déjà joué »

/**
 * Couche 5 : confirmation de cassure EN CLÔTURE + détection de péremption.
 * - breakout confirmé : une bougie CLOSE a clôturé au-delà du niveau.
 *   NOTE INV-5 : on ne lit que des closes de bougies déjà émises.
 * - SPENT (« déjà joué ») : depuis la cassure, le prix a déjà parcouru ≥80%
 *   du mouvement mesuré jusqu'à la cible → la « conséquence » du pattern a eu
 *   lieu, il n'offre plus d'edge → confiance écrasée (problème signalé :
 *   « tête-épaules dont la courbe est déjà redescendue, mais encore comptée »).
 * - STALE : la cassure est trop ancienne (> STALE_BARS) → périmé.
 * - re-test respecté (cassure récente) : bonus.
 * - invalidation : clôture post-cassure réintègre franchement → nié.
 * Retourne { delta, status }.
 */
function breakoutConfirmation(ctx, keyLevel, direction, target) {
  const candles = ctx.candles;
  const n = candles.length;
  if (n < 3 || keyLevel == null) return { delta: 0, status: 'forming' };

  const beyond = (close) => (direction === 'bullish' ? close > keyLevel : close < keyLevel);
  // On cherche la cassure sur une fenêtre large (jusqu'à 40 bougies) afin de
  // pouvoir détecter une cassure ANCIENNE (pattern périmé), pas seulement récente.
  const lookback = Math.min(40, n - 1);

  let breakIdx = -1;
  for (let i = n - lookback; i < n; i++) {
    if (beyond(candles[i].close)) { breakIdx = i; break; }
  }

  if (breakIdx === -1) {
    // Pas de cassure : la confiance ne monte PAS sur simple proximité (exigence ferme).
    return { delta: 0, status: 'forming' };
  }

  // Invalidation : une clôture POST-cassure réintègre franchement (> 0.5 ATR) le niveau
  for (let i = breakIdx + 1; i < n; i++) {
    const c = candles[i].close;
    const reentry = direction === 'bullish' ? keyLevel - c : c - keyLevel;
    if (reentry > ctx.atr * 0.5) {
      return { delta: -0.5, status: 'invalidated' };
    }
  }

  // « Déjà joué » : progression du prix vers la cible mesurée depuis le niveau.
  if (target != null && isFinite(target)) {
    const span = Math.abs(target - keyLevel);
    if (span > 0) {
      const moved = direction === 'bullish' ? (ctx.lastClose - keyLevel) : (keyLevel - ctx.lastClose);
      const progress = clamp(moved / span, 0, 2);
      if (progress >= SPENT_PROGRESS) {
        // Conséquence réalisée → on écrase fortement (tombera sous le seuil de bruit).
        return { delta: -0.6, status: 'spent' };
      }
    }
  }

  const barsSince = (n - 1) - breakIdx;
  // Cassure trop ancienne → périmée.
  if (barsSince > STALE_BARS) return { delta: -0.35, status: 'stale' };

  // Cassure confirmée : bonus PLEIN si fraîche, décroissant jusqu'à ~0 vers STALE_BARS.
  let delta = barsSince <= ACTION_BARS
    ? 0.18
    : 0.18 * (1 - (barsSince - ACTION_BARS) / (STALE_BARS - ACTION_BARS));

  // Re-test respecté (uniquement si la cassure est encore fraîche).
  if (barsSince <= ACTION_BARS) {
    for (let i = breakIdx + 1; i < n; i++) {
      const c = candles[i];
      const touched = direction === 'bullish'
        ? c.low <= keyLevel + ctx.atr * 0.3
        : c.high >= keyLevel - ctx.atr * 0.3;
      if (touched && beyond(c.close)) { delta += 0.07; break; }
    }
  }
  return { delta, status: 'confirmed' };
}

/** Égalité relative de deux prix, tolérance en multiples d'ATR. */
function priceEq(a, b, ctx, atrMult = 0.8) {
  return Math.abs(a - b) <= ctx.atr * atrMult;
}

/** Construit l'objet pattern final avec sa clé stable. */
function buildPattern({ type, name, direction, kind, confidence, keyLevel, target, pivots, lines, ctx, status }) {
  const absIdx = (i) => ctx.offset + i;
  return {
    key: `${type}@${pivots.map((p) => absIdx(p.index)).join('-')}`,
    type, name, direction, kind, // kind: 'reversal' | 'continuation' | 'candle'
    confidence: Math.round(confidence * 100) / 100,
    keyLevel, target,
    windowSize: ctx.windowSize,
    startIndex: absIdx(pivots[0].index),
    endIndex: absIdx(pivots[pivots.length - 1].index),
    status: status || 'forming',
    lines: lines || [],
  };
}

/* ============================================================
   PATTERNS CHARTISTES
   ============================================================ */

// ----- Double Top -----
function detectDoubleTop(highs, lows, ctx) {
  if (highs.length < 2) return null;
  // Deux derniers sommets significatifs, séparés d'au moins 4 bougies
  for (let i = highs.length - 1; i >= 1; i--) {
    const h2 = highs[i];
    for (let j = i - 1; j >= 0; j--) {
      const h1 = highs[j];
      if (h2.index - h1.index < 4) continue;
      if (!priceEq(h1.price, h2.price, ctx, 0.9)) continue;
      // Creux intermédiaire = neckline
      const between = lows.filter((l) => l.index > h1.index && l.index < h2.index);
      if (!between.length) continue;
      const neck = between.reduce((a, b) => (a.price < b.price ? a : b));
      const height = Math.max(h1.price, h2.price) - neck.price;
      if (height < ctx.atr * 1.2) continue; // structure trop plate = bruit

      // Couche 3 : score géométrique — égalité des sommets + profondeur du creux
      const eqQuality = 1 - Math.abs(h1.price - h2.price) / (ctx.atr * 0.9);
      const depthQuality = clamp(height / (ctx.atr * 3), 0.3, 1);
      let conf = 0.35 + eqQuality * 0.15 + depthQuality * 0.1;

      conf = contextAdjust(conf, { isReversal: true, direction: 'bearish', keyLevel: neck.price, ctx });
      const bc = breakoutConfirmation(ctx, neck.price, 'bearish', neck.price - height);
      conf = clamp(conf + bc.delta, 0, 1);

      return buildPattern({
        type: 'double_top', name: 'Double Top', direction: 'bearish', kind: 'reversal',
        confidence: conf, keyLevel: neck.price, target: neck.price - height,
        pivots: [h1, neck, h2], status: bc.status, ctx,
        lines: [
          { t1: h1.time, p1: h1.price, t2: h2.time, p2: h2.price, role: 'resistance' },
          { t1: h1.time, p1: neck.price, t2: h2.time, p2: neck.price, role: 'neckline' },
          { t1: h2.time, p1: neck.price - height, t2: h2.time, p2: neck.price - height, role: 'target' },
        ],
      });
    }
  }
  return null;
}

// ----- Double Bottom (miroir) -----
function detectDoubleBottom(highs, lows, ctx) {
  if (lows.length < 2) return null;
  for (let i = lows.length - 1; i >= 1; i--) {
    const l2 = lows[i];
    for (let j = i - 1; j >= 0; j--) {
      const l1 = lows[j];
      if (l2.index - l1.index < 4) continue;
      if (!priceEq(l1.price, l2.price, ctx, 0.9)) continue;
      const between = highs.filter((h) => h.index > l1.index && h.index < l2.index);
      if (!between.length) continue;
      const neck = between.reduce((a, b) => (a.price > b.price ? a : b));
      const height = neck.price - Math.min(l1.price, l2.price);
      if (height < ctx.atr * 1.2) continue;

      const eqQuality = 1 - Math.abs(l1.price - l2.price) / (ctx.atr * 0.9);
      const depthQuality = clamp(height / (ctx.atr * 3), 0.3, 1);
      let conf = 0.35 + eqQuality * 0.15 + depthQuality * 0.1;

      conf = contextAdjust(conf, { isReversal: true, direction: 'bullish', keyLevel: neck.price, ctx });
      const bc = breakoutConfirmation(ctx, neck.price, 'bullish', neck.price + height);
      conf = clamp(conf + bc.delta, 0, 1);

      return buildPattern({
        type: 'double_bottom', name: 'Double Bottom', direction: 'bullish', kind: 'reversal',
        confidence: conf, keyLevel: neck.price, target: neck.price + height,
        pivots: [l1, neck, l2], status: bc.status, ctx,
        lines: [
          { t1: l1.time, p1: l1.price, t2: l2.time, p2: l2.price, role: 'support' },
          { t1: l1.time, p1: neck.price, t2: l2.time, p2: neck.price, role: 'neckline' },
          { t1: l2.time, p1: neck.price + height, t2: l2.time, p2: neck.price + height, role: 'target' },
        ],
      });
    }
  }
  return null;
}

// ----- Triple Top / Bottom -----
function detectTripleTop(highs, lows, ctx) {
  return detectTriple(highs, lows, ctx, false);
}
function detectTripleBottom(highs, lows, ctx) {
  return detectTriple(lows, highs, ctx, true);
}

function detectTriple(primary, secondary, ctx, isBottom) {
  if (primary.length < 3) return null;
  // Trois derniers pivots ~égaux
  for (let i = primary.length - 1; i >= 2; i--) {
    const p3 = primary[i], p2 = primary[i - 1], p1 = primary[i - 2];
    if (p3.index - p1.index < 8) continue;
    if (!priceEq(p1.price, p2.price, ctx, 1.0) || !priceEq(p2.price, p3.price, ctx, 1.0) || !priceEq(p1.price, p3.price, ctx, 1.0)) continue;

    const between = secondary.filter((s) => s.index > p1.index && s.index < p3.index);
    if (between.length < 1) continue;
    const neck = isBottom
      ? between.reduce((a, b) => (a.price > b.price ? a : b))
      : between.reduce((a, b) => (a.price < b.price ? a : b));
    const height = isBottom ? neck.price - mean([p1.price, p2.price, p3.price]) : mean([p1.price, p2.price, p3.price]) - neck.price;
    if (height < ctx.atr * 1.2) continue;

    const spread = Math.max(p1.price, p2.price, p3.price) - Math.min(p1.price, p2.price, p3.price);
    const eqQuality = 1 - clamp(spread / (ctx.atr * 1.0), 0, 1);
    let conf = 0.42 + eqQuality * 0.16; // 3 touches = structure plus rare et plus fiable qu'un double

    const direction = isBottom ? 'bullish' : 'bearish';
    const target = isBottom ? neck.price + height : neck.price - height;
    conf = contextAdjust(conf, { isReversal: true, direction, keyLevel: neck.price, ctx });
    const bc = breakoutConfirmation(ctx, neck.price, direction, target);
    conf = clamp(conf + bc.delta, 0, 1);
    return buildPattern({
      type: isBottom ? 'triple_bottom' : 'triple_top',
      name: isBottom ? 'Triple Bottom' : 'Triple Top',
      direction, kind: 'reversal',
      confidence: conf, keyLevel: neck.price, target,
      pivots: [p1, p2, p3], status: bc.status, ctx,
      lines: [
        { t1: p1.time, p1: p1.price, t2: p3.time, p2: p3.price, role: isBottom ? 'support' : 'resistance' },
        { t1: p1.time, p1: neck.price, t2: p3.time, p2: neck.price, role: 'neckline' },
        { t1: p3.time, p1: target, t2: p3.time, p2: target, role: 'target' },
      ],
    });
  }
  return null;
}

// ----- Head & Shoulders (+ inversé) -----
function detectHeadShoulders(primary, secondary, ctx, inverted) {
  if (primary.length < 3) return null;
  for (let i = primary.length - 1; i >= 2; i--) {
    const rs = primary[i], head = primary[i - 1], ls = primary[i - 2];
    if (rs.index - ls.index < 8) continue;

    // La tête doit dominer les deux épaules d'au moins 0.6 ATR
    const headDominance = inverted
      ? Math.min(ls.price, rs.price) - head.price
      : head.price - Math.max(ls.price, rs.price);
    if (headDominance < ctx.atr * 0.6) continue;
    // Épaules approximativement symétriques
    if (!priceEq(ls.price, rs.price, ctx, 1.4)) continue;

    // Neckline = droite entre les deux creux (ou sommets si inversé) autour de la tête
    const necks = secondary.filter((s) => s.index > ls.index && s.index < rs.index);
    if (necks.length < 2) continue;
    const n1 = necks[0], n2 = necks[necks.length - 1];
    const neckAvg = (n1.price + n2.price) / 2;
    const height = Math.abs(head.price - neckAvg);
    if (height < ctx.atr * 1.5) continue;

    // Couche 3 : dominance de la tête + symétrie des épaules + horizontalité de la neckline
    const domQ = clamp(headDominance / (ctx.atr * 2), 0.3, 1);
    const symQ = 1 - clamp(Math.abs(ls.price - rs.price) / (ctx.atr * 1.4), 0, 1);
    const neckQ = 1 - clamp(Math.abs(n1.price - n2.price) / (ctx.atr * 1.5), 0, 1);
    let conf = 0.34 + domQ * 0.12 + symQ * 0.1 + neckQ * 0.08;

    const direction = inverted ? 'bullish' : 'bearish';
    const target = inverted ? neckAvg + height : neckAvg - height;
    conf = contextAdjust(conf, { isReversal: true, direction, keyLevel: neckAvg, ctx });
    const bc = breakoutConfirmation(ctx, neckAvg, direction, target);
    conf = clamp(conf + bc.delta, 0, 1);
    return buildPattern({
      type: inverted ? 'ihs' : 'hs',
      name: inverted ? 'Tête-Épaules Inversé' : 'Tête-Épaules',
      direction, kind: 'reversal',
      confidence: conf, keyLevel: neckAvg, target,
      pivots: [ls, head, rs], status: bc.status, ctx,
      lines: [
        { t1: n1.time, p1: n1.price, t2: n2.time, p2: n2.price, role: 'neckline' },
        { t1: ls.time, p1: ls.price, t2: head.time, p2: head.price, role: inverted ? 'support' : 'resistance' },
        { t1: head.time, p1: head.price, t2: rs.time, p2: rs.price, role: inverted ? 'support' : 'resistance' },
        { t1: rs.time, p1: target, t2: rs.time, p2: target, role: 'target' },
      ],
    });
  }
  return null;
}

// ----- Triangles & Wedges (via régression sur les pivots) -----
function detectTrianglesWedges(highs, lows, ctx) {
  if (highs.length < 3 || lows.length < 3) return [];
  // Utilise les 3-5 derniers pivots de chaque côté
  const hs = highs.slice(-5);
  const ls = lows.slice(-5);
  if (hs.length < 3 || ls.length < 3) return [];

  const hReg = linearRegression(hs.map((h) => h.price));
  const lReg = linearRegression(ls.map((l) => l.price));
  // Qualité d'alignement minimale des deux droites
  if (hReg.r2 < 0.5 || lReg.r2 < 0.5) return [];

  // Pentes normalisées en ATR par pivot (échelle comparable entre actifs)
  const hSlope = hReg.slope / ctx.atr;
  const lSlope = lReg.slope / ctx.atr;
  const FLAT = 0.15; // |pente| < 0.15 ATR/pivot ≈ horizontale

  let type = null, name = null, direction = null, kind = 'continuation';

  if (Math.abs(hSlope) < FLAT && lSlope > FLAT) {
    type = 'asc_triangle'; name = 'Triangle Ascendant'; direction = 'bullish';
  } else if (Math.abs(lSlope) < FLAT && hSlope < -FLAT) {
    type = 'desc_triangle'; name = 'Triangle Descendant'; direction = 'bearish';
  } else if (hSlope < -FLAT && lSlope > FLAT) {
    type = 'sym_triangle'; name = 'Triangle Symétrique'; direction = 'neutral';
  } else if (hSlope > FLAT && lSlope > FLAT && lSlope > hSlope) {
    // Rising wedge : les deux montent mais convergent → bearish (retournement)
    type = 'rising_wedge'; name = 'Biseau Ascendant'; direction = 'bearish'; kind = 'reversal';
  } else if (hSlope < -FLAT && lSlope < -FLAT && hSlope < lSlope) {
    type = 'falling_wedge'; name = 'Biseau Descendant'; direction = 'bullish'; kind = 'reversal';
  }
  if (!type) return [];

  // Convergence requise : l'écart entre droites se réduit
  const spreadStart = (hReg.intercept) - (lReg.intercept);
  const lastX = Math.max(hs.length, ls.length) - 1;
  const spreadEnd = (hReg.slope * lastX + hReg.intercept) - (lReg.slope * lastX + lReg.intercept);
  if (spreadEnd <= 0 || spreadEnd >= spreadStart * 0.98) return []; // pas de convergence réelle

  // Couche 3 : qualité = alignement des droites + degré de convergence
  const convergeQ = clamp(1 - spreadEnd / spreadStart, 0.1, 1);
  let conf = 0.32 + ((hReg.r2 + lReg.r2) / 2) * 0.16 + convergeQ * 0.1;

  // Niveau clé = borne dans le sens attendu (résistance pour bullish, support pour bearish)
  const hLast = hReg.slope * (hs.length - 1) + hReg.intercept;
  const lLast = lReg.slope * (ls.length - 1) + lReg.intercept;
  let keyLevel = null;
  if (direction === 'bullish') keyLevel = hLast;
  else if (direction === 'bearish') keyLevel = lLast;
  else keyLevel = (hLast + lLast) / 2;

  const height = spreadStart;
  const target = direction === 'bullish' ? keyLevel + height * 0.7
    : direction === 'bearish' ? keyLevel - height * 0.7
    : null;

  conf = contextAdjust(conf, { isReversal: kind === 'reversal', direction, keyLevel, ctx });
  let status = 'forming';
  if (direction !== 'neutral') {
    const bc = breakoutConfirmation(ctx, keyLevel, direction, target);
    conf = clamp(conf + bc.delta, 0, 1);
    status = bc.status;
  }

  const pat = buildPattern({
    type, name, direction, kind,
    confidence: conf, keyLevel, target,
    pivots: [hs[0], ls[0], hs[hs.length - 1], ls[ls.length - 1]].sort((a, b) => a.index - b.index),
    status, ctx,
    lines: [
      { t1: hs[0].time, p1: hReg.intercept, t2: hs[hs.length - 1].time, p2: hReg.slope * (hs.length - 1) + hReg.intercept, role: 'resistance' },
      { t1: ls[0].time, p1: lReg.intercept, t2: ls[ls.length - 1].time, p2: lReg.slope * (ls.length - 1) + lReg.intercept, role: 'support' },
      ...(target != null ? [{ t1: ctx.lastCandle.time, p1: target, t2: ctx.lastCandle.time, p2: target, role: 'target' }] : []),
    ],
  });
  return [pat];
}

// ----- Flags (bull / bear) -----
function detectFlag(ctx, side) {
  const win = ctx.win;
  if (win.length < 20) return null;
  // Mât : impulsion forte sur le premier tiers ; drapeau : consolidation
  // en contre-pente douce sur le dernier tiers.
  const third = Math.floor(win.length / 3);
  const pole = win.slice(0, third + 1);
  const flag = win.slice(-third);

  const poleMove = pole[pole.length - 1].close - pole[0].close;
  const poleStrength = Math.abs(poleMove) / (ctx.atr * pole.length);
  // Le mât doit être une vraie impulsion (≥ 0.45 ATR / bougie en moyenne)
  if (poleStrength < 0.45) return null;
  if (side === 'bull' && poleMove <= 0) return null;
  if (side === 'bear' && poleMove >= 0) return null;

  const flagReg = linearRegression(flag.map((c) => c.close));
  const flagSlopeAtr = flagReg.slope / ctx.atr;
  // Drapeau : pente douce CONTRE le mât, et bien alignée
  const counterOk = side === 'bull'
    ? (flagSlopeAtr <= 0.05 && flagSlopeAtr > -0.5)
    : (flagSlopeAtr >= -0.05 && flagSlopeAtr < 0.5);
  if (!counterOk || flagReg.r2 < 0.3) return null;

  // L'amplitude du drapeau doit rester < 50% du mât (sinon ce n'est plus une consolidation)
  const flagRange = Math.max(...flag.map((c) => c.high)) - Math.min(...flag.map((c) => c.low));
  if (flagRange > Math.abs(poleMove) * 0.5) return null;

  const direction = side === 'bull' ? 'bullish' : 'bearish';
  const keyLevel = side === 'bull'
    ? Math.max(...flag.map((c) => c.high))
    : Math.min(...flag.map((c) => c.low));

  const target = side === 'bull' ? keyLevel + Math.abs(poleMove) * 0.8 : keyLevel - Math.abs(poleMove) * 0.8;

  let conf = 0.34 + clamp(poleStrength / 1.5, 0, 1) * 0.14 + flagReg.r2 * 0.08;
  conf = contextAdjust(conf, { isReversal: false, direction, keyLevel, ctx });
  const bc = breakoutConfirmation(ctx, keyLevel, direction, target);
  conf = clamp(conf + bc.delta, 0, 1);
  const fStart = flag[0], fEnd = flag[flag.length - 1];
  return buildPattern({
    type: `${side}_flag`, name: side === 'bull' ? 'Drapeau Haussier' : 'Drapeau Baissier',
    direction, kind: 'continuation',
    confidence: conf, keyLevel, target,
    pivots: [
      { index: ctx.win.indexOf(pole[0]), time: pole[0].time, price: pole[0].close },
      { index: ctx.win.indexOf(fEnd), time: fEnd.time, price: fEnd.close },
    ],
    status: bc.status, ctx,
    lines: [
      { t1: pole[0].time, p1: pole[0].close, t2: pole[pole.length - 1].time, p2: pole[pole.length - 1].close, role: side === 'bull' ? 'support' : 'resistance' },
      { t1: fStart.time, p1: keyLevel, t2: fEnd.time, p2: keyLevel, role: 'neckline' },
      { t1: fEnd.time, p1: target, t2: fEnd.time, p2: target, role: 'target' },
    ],
  });
}

/* ============================================================
   PATTERNS DE BOUGIES
   Confiance PLAFONNÉE à 0.62 : ce sont des signaux d'appoint
   pour le consensus, jamais des signaux forts isolés (spec).
   Clé stable basée sur le time de la bougie → l'hystérésis du
   scanner les fait expirer naturellement quand elles vieillissent.
   ============================================================ */

const CANDLE_CONF_CAP = 0.62;

function detectCandlePatterns(ctx) {
  const candles = ctx.candles;
  const n = candles.length;
  if (n < 3) return [];
  const out = [];
  const c = candles[n - 1];      // dernière bougie du slice
  const p = candles[n - 2];      // précédente
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return [];
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const t = ctx.trend.direction;

  const mk = (type, name, direction, baseConf) => {
    let conf = baseConf;
    // Les bougies de retournement valent surtout à contre-tendance
    const counterTrend = (direction === 'bullish' && t === 'down') || (direction === 'bearish' && t === 'up');
    if (counterTrend) conf += 0.08; else conf -= 0.06;
    if (ctx.volRatio > 1.3) conf += 0.04;
    conf = clamp(conf, 0, CANDLE_CONF_CAP);
    if (conf < ctx.noiseFloor) return;
    out.push({
      key: `${type}@${c.time}`,
      type, name, direction, kind: 'candle',
      confidence: Math.round(conf * 100) / 100,
      keyLevel: direction === 'bullish' ? c.low : c.high,
      target: null,
      windowSize: ctx.windowSize,
      startIndex: n - 2, endIndex: n - 1,
      status: 'confirmed', // une bougie close est par nature confirmée
      lines: [],
    });
  };

  // Engulfing : le corps englobe entièrement le corps précédent
  const pBody = Math.abs(p.close - p.open);
  if (pBody > 0 && body > pBody * 1.1 && body > ctx.atr * 0.5) {
    if (c.close > c.open && p.close < p.open && c.close >= p.open && c.open <= p.close) {
      mk('bull_engulfing', 'Avalement Haussier', 'bullish', 0.5);
    } else if (c.close < c.open && p.close > p.open && c.close <= p.open && c.open >= p.close) {
      mk('bear_engulfing', 'Avalement Baissier', 'bearish', 0.5);
    }
  }
  // Hammer : mèche basse ≥ 2x corps, mèche haute minime
  if (body > 0 && lowerWick >= body * 2 && upperWick <= body * 0.5 && range > ctx.atr * 0.6) {
    mk('hammer', 'Marteau', 'bullish', 0.46);
  }
  // Shooting star : miroir du hammer
  if (body > 0 && upperWick >= body * 2 && lowerWick <= body * 0.5 && range > ctx.atr * 0.6) {
    mk('shooting_star', 'Étoile Filante', 'bearish', 0.46);
  }
  // Doji : corps < 10% du range — signal d'indécision, neutre
  if (body <= range * 0.1 && range > ctx.atr * 0.5) {
    out.push({
      key: `doji@${c.time}`,
      type: 'doji', name: 'Doji', direction: 'neutral', kind: 'candle',
      confidence: 0.46,
      keyLevel: null, target: null,
      windowSize: ctx.windowSize,
      startIndex: n - 1, endIndex: n - 1,
      status: 'confirmed', lines: [],
    });
  }
  return out;
}
