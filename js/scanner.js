/* ============================================================
   scanner.js — Scanner multi-fenêtres + stabilisation + consensus.

   - Scanne plusieurs fenêtres (15..120 bougies), agrège,
     bonus de confirmation multi-fenêtres.
   - STABILISATION anti-clignotement :
       * hystérésis : vu SEEN_N scans consécutifs avant d'apparaître,
         absent GONE_M scans avant de disparaître ;
       * EMA de la confiance affichée (alpha 0.4) ;
       * hash de l'ensemble stable → pas de re-render inutile,
         et signal d'entrée pour le trading (anti-spam).
   - Consensus pondéré par confiance → direction nette + force
     + raisons + contradictions.

   CONTRAT ANTI-LOOKAHEAD (INV-1) :
   `scan(candles)` ne lit QUE le tableau reçu. En replay,
   l'appelant passe le slice tronqué. Le scanner conserve un état
   d'hystérésis (passé des scans), ce qui est légitime : c'est de
   la mémoire du passé, pas un accès au futur. `reset()` est appelé
   à chaque entrée/seek de replay pour purger cet état.
   ============================================================ */

import { detectAllPatterns } from './patterns.js';
import { computeTrend } from './indicators.js';
import { hashString, clamp } from './utils.js';

const WINDOWS = [15, 22, 30, 45, 60, 80, 120];
const SEEN_N = 2;   // scans consécutifs requis pour apparaître
const GONE_M = 3;   // scans consécutifs absents requis pour disparaître
const EMA_ALPHA = 0.4;

export function createScanner() {
  // état d'hystérésis : key -> { pattern, seenCount, goneCount, emaConf, visible }
  let tracked = new Map();
  let lastStableHash = 0;
  // TUNING: bootstrap — le 1er scan après reset rend les patterns
  // visibles immédiatement (l'historique initial est une donnée
  // établie, pas un flux instable). L'hystérésis SEEN_N s'applique
  // ensuite aux NOUVEAUX patterns, qui eux peuvent clignoter.
  let firstScan = true;

  function reset() {
    tracked = new Map();
    lastStableHash = 0;
    firstScan = true;
  }

  /**
   * Lance un scan complet sur le slice fourni.
   * Retourne { patterns, consensus, stableHash, changed }.
   */
  function scan(candles) {
    // --- 1. Détection brute sur toutes les fenêtres ---
    const raw = new Map(); // key -> meilleure occurrence
    for (const w of WINDOWS) {
      if (candles.length < Math.min(w, 15)) continue;
      for (const p of detectAllPatterns(candles, w)) {
        const prev = raw.get(p.key);
        if (!prev) {
          raw.set(p.key, { ...p, windowsSeen: 1 });
        } else {
          // Même structure vue sur plusieurs fenêtres → garde la
          // meilleure confiance + compte les fenêtres
          prev.windowsSeen += 1;
          if (p.confidence > prev.confidence) {
            raw.set(p.key, { ...p, windowsSeen: prev.windowsSeen });
          }
        }
      }
    }

    // --- 2. Bonus multi-fenêtres ---
    // TUNING: +0.04 par fenêtre supplémentaire, plafonné à +0.10.
    // Une structure visible sur 3+ fenêtres est nettement plus fiable.
    for (const p of raw.values()) {
      if (p.windowsSeen > 1) {
        p.confidence = clamp(p.confidence + Math.min((p.windowsSeen - 1) * 0.04, 0.10), 0, 1);
      }
    }

    // --- 3. Hystérésis + EMA ---
    const seenKeys = new Set(raw.keys());
    // Mise à jour des patterns vus
    for (const [key, p] of raw) {
      const t = tracked.get(key);
      if (!t) {
        // Bootstrap : au 1er scan (historique établi), visible direct.
        // Ensuite, l'hystérésis SEEN_N s'applique aux nouveaux venus.
        tracked.set(key, { pattern: p, seenCount: 1, goneCount: 0, emaConf: p.confidence, visible: firstScan });
      } else {
        t.pattern = p; // structure rafraîchie (status / confiance brute à jour)
        t.seenCount += 1;
        t.goneCount = 0;
        t.emaConf = EMA_ALPHA * p.confidence + (1 - EMA_ALPHA) * t.emaConf;
        if (!t.visible && t.seenCount >= SEEN_N) t.visible = true;
      }
    }
    // Statuts de PÉREMPTION = disparition immédiate (le pattern a « vécu »).
    const isDead = (status) => status === 'invalidated' || status === 'spent' || status === 'stale';
    // Mise à jour des absents
    for (const [key, t] of tracked) {
      if (!seenKeys.has(key)) {
        t.goneCount += 1;
        t.seenCount = 0;
        // Périmé explicitement = disparition immédiate (pas d'attente M scans)
        if (isDead(t.pattern.status) || t.goneCount >= GONE_M) {
          tracked.delete(key);
        }
      } else if (isDead(t.pattern.status)) {
        tracked.delete(key);
      }
    }

    firstScan = false;

    // --- 4. Ensemble stable visible ---
    const visible = [];
    for (const t of tracked.values()) {
      if (t.visible) {
        visible.push({ ...t.pattern, confidence: Math.round(t.emaConf * 100) / 100 });
      }
    }
    visible.sort((a, b) => b.confidence - a.confidence);

    // --- 5. Hash de l'ensemble stable (anti re-render / anti-spam trading) ---
    const stableHash = hashString(visible.map((p) => `${p.key}:${p.direction}:${p.status}`).join('|'));
    const changed = stableHash !== lastStableHash;
    lastStableHash = stableHash;

    // TUNING: hash STRUCTUREL séparé pour l'anti-spam trading.
    // Les patterns de bougies ont une clé horodatée (`hammer@t`) : chaque
    // nouvelle bougie mute le hash global, ce qui contournait l'anti-spam
    // (mesuré : 42 entrées sur ~350 bougies). L'anti-spam d'entrée ne
    // doit réagir qu'aux changements de structure CHARTISTE — les bougies
    // restent intégrées au consensus (pondération), pas déclencheurs.
    const structuralHash = hashString(
      visible.filter((p) => p.kind !== 'candle').map((p) => `${p.key}:${p.direction}:${p.status}`).join('|')
    );

    // --- 6. Consensus ---
    const consensus = computeConsensus(visible, candles);

    return { patterns: visible, consensus, stableHash, structuralHash, changed };
  }

  return { scan, reset };
}

/**
 * Consensus pondéré par confiance.
 * La prédiction ne repose JAMAIS sur un pattern unique : la force
 * est amortie quand il y a peu de signaux directionnels.
 * Retourne { direction, strength [0..1], bullPct, reasons, contradictions }.
 */
function computeConsensus(patterns, candles) {
  let bull = 0, bear = 0;
  const bullPats = [], bearPats = [];

  for (const p of patterns) {
    // Les bougies pèsent moitié moins que les patterns chartistes
    const w = p.kind === 'candle' ? p.confidence * 0.5 : p.confidence;
    if (p.direction === 'bullish') { bull += w; bullPats.push(p); }
    else if (p.direction === 'bearish') { bear += w; bearPats.push(p); }
  }

  // La tendance de fond pèse comme un signal modéré
  const trend = candles.length >= 20 ? computeTrend(candles, 50) : { direction: 'flat', slopePct: 0 };
  if (trend.direction === 'up') bull += 0.35;
  else if (trend.direction === 'down') bear += 0.35;

  const total = bull + bear;
  const bullPct = total === 0 ? 50 : (bull / total) * 100;

  const net = bull - bear;
  const dirSignalCount = bullPats.length + bearPats.length;
  // Amortissement : avec 0-1 signal directionnel, la force est divisée
  // (jamais de prédiction forte sur un pattern unique)
  const damping = dirSignalCount >= 3 ? 1 : dirSignalCount === 2 ? 0.8 : dirSignalCount === 1 ? 0.55 : 0.3;
  const strength = clamp((Math.abs(net) / Math.max(total, 1)) * damping, 0, 1);

  let direction = 'neutral';
  if (strength > 0.18 && net > 0) direction = 'bullish';
  else if (strength > 0.18 && net < 0) direction = 'bearish';

  // Raisons principales (top patterns du côté dominant) + contradictions
  const reasons = [];
  const contradictions = [];
  const domPats = direction === 'bullish' ? bullPats : direction === 'bearish' ? bearPats : [];
  const oppPats = direction === 'bullish' ? bearPats : direction === 'bearish' ? bullPats : [];

  for (const p of domPats.slice(0, 3)) {
    reasons.push(`${p.name} (conf. ${(p.confidence * 100).toFixed(0)}%${p.status === 'confirmed' ? ', cassure confirmée' : ''})`);
  }
  if (trend.direction !== 'flat') {
    const aligned = (trend.direction === 'up' && direction === 'bullish') || (trend.direction === 'down' && direction === 'bearish');
    if (aligned) reasons.push(`Tendance de fond ${trend.direction === 'up' ? 'haussière' : 'baissière'} alignée`);
  }
  for (const p of oppPats.slice(0, 2)) {
    contradictions.push(`${p.name} en sens opposé (conf. ${(p.confidence * 100).toFixed(0)}%)`);
  }

  // ---- Métriques de QUALITÉ d'entrée (toutes calculées sur le slice
  //      passé — aucune lecture du futur) consommées par le trading. ----

  // Un pattern du côté dominant a-t-il une cassure CONFIRMÉE en clôture ?
  // (couche 5 du moteur : la confiance ne monte fortement que sur cassure)
  const domConfirmed = domPats.some((p) => p.status === 'confirmed');

  // Meilleure confiance du côté dominant (hors bougies, qui sont faibles).
  const bestDomConf = domPats
    .filter((p) => p.kind !== 'candle')
    .reduce((m, p) => Math.max(m, p.confidence), 0);

  // Ratio de contestation = poids des patterns OPPOSÉS / poids dominants.
  // Proche de 0 = signal net ; proche de 1 = marché indécis (à éviter).
  const wOf = (arr) => arr.reduce((s, p) => s + (p.kind === 'candle' ? p.confidence * 0.5 : p.confidence), 0);
  const domW = wOf(domPats);
  const oppW = wOf(oppPats);
  const contestRatio = domW > 0 ? oppW / domW : 1;

  // Le signal dominant est-il aligné avec la tendance de fond ?
  const alignedWithTrend =
    (trend.direction === 'up' && direction === 'bullish') ||
    (trend.direction === 'down' && direction === 'bearish');

  // Conservé pour compat. : signal de qualité « minimal ».
  const hasQualitySignal = domConfirmed || bestDomConf >= 0.62;

  return {
    direction,
    strength: Math.round(strength * 100) / 100,
    bullPct: Math.round(bullPct),
    reasons,
    contradictions,
    trend,
    hasQualitySignal,
    domConfirmed,
    bestDomConf: Math.round(bestDomConf * 100) / 100,
    contestRatio: Math.round(contestRatio * 100) / 100,
    alignedWithTrend,
  };
}
