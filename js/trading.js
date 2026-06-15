/* ============================================================
 * trading.js — Moteur d'auto-trading simulé (replay uniquement)
 *
 * STRATÉGIE — SUIVI DE TENDANCE PAR CONFLUENCE (générale, multi-actifs).
 *
 * Fondée sur un benchmark out-of-sample des 8 stratégies standard
 * (256 backtests : crypto/forex/actions × {1d, 1h}, moteur leak-free
 * avec commission + slippage). Conclusions GÉNÉRALES, NON spécifiques
 * à un symbole :
 *   - Seule la famille SUIVI DE TENDANCE généralise positivement :
 *     EMA crossover (PF≈2.70), breakout (Donchian), momentum (ROC).
 *     La gestion du risque (stop/target) AMÉLIORE ces stratégies.
 *   - La famille CONTRE-TENDANCE (RSI, MACD, Bollinger, mean-reversion)
 *     perd quasi partout MÊME avec stop/target (PF<0.85) : taux de
 *     réussite ~48-50% mais pertes > gains → espérance négative.
 *   - Le suivi de tendance marche bien mieux en VRAI trend qu'en range
 *     (breakout 1d : 69% profitables vs 1h haché : 25%).
 *
 * On NE FADE donc JAMAIS. On entre uniquement DANS le sens de la tendance
 * quand une CONFLUENCE de signaux robustes (EMA + momentum + breakout,
 * calculée dans indicators.js) est alignée, ET que le marché trend
 * réellement (filtre de régime via r² de régression). Sinon : abstention.
 *
 * INVARIANTS (replay_contract) :
 *  - INV-1 : onBar() reçoit UNIQUEMENT le slice tronqué [0..t].
 *  - INV-4 : résolution intra-bougie conservatrice (SL-first), symétrique.
 *  - INV-5 : on n'utilise jamais le close courant pour deviner le chemin
 *            intra-bougie.
 * ============================================================ */

import { uid, formatPrice } from "./utils.js";

// ---- Money management constants ------------------------------------------
const START_WALLET = 10000;
const MAX_OPEN_POSITIONS = 3; // plafond positions simultanées
const MAX_TOTAL_EXPOSURE = 0.45; // 45% du wallet max engagé

// Le consensus de patterns n'est PLUS directionnel (la direction vient de la
// confluence de tendance). Il sert seulement de VETO : on refuse d'entrer si
// le consensus pointe FORTEMENT à contre-tendance (retournement crédible).
const STRONG_OPPOSE = 0.45;

const MAX_HOLD_BARS = 80; // détention max (suivi de tendance : laisser courir)

// ---- Géométrie SL/TP : RR > 1, on laisse courir les gagnants -------------
// Le taux de réussite du suivi de tendance est structurellement ~40-45% ;
// l'espérance est positive car les tendances capturées >> stops.
const MIN_RR = 1.2; // RR plancher (rejet en deçà)
const RR_TARGET = 1.8; // RR visé : TP dérivé du risque réel (stop possiblement élargi)

// ANTI-WHIPSAW (cf. recherche : stops volatilité placés HORS du bruit, pas de
// break-even prématuré, confirmation en CLÔTURE) :
//  - BREAK_EVEN_R relevé 1.0 → 1.4 : on ne verrouille pas trop tôt (un break-even
//    prématuré se fait sortir par un simple repli normal puis le prix repart).
//  - STOP_GRACE : bande de bruit. Une mèche qui perce le SL de < STOP_GRACE×ATR
//    MAIS dont la bougie CLÔTURE du bon côté n'est PAS un stop (mèche de bruit
//    de 1-3 bougies qui se résorbe). Une cassure franche (> grace) ou une
//    clôture au-delà du SL exécute le stop. C'est l'option « accepter le petit
//    repli » demandée, bornée à grace×ATR (risque supplémentaire maîtrisé).
const BREAK_EVEN_R = 1.4;
const TRAIL_R = 1.6; // trailing dès +1.6R (capturer les grandes tendances)
const TRAIL_ATR = 1.1; // distance de trailing (ATR) — assez large pour respirer
const STOP_GRACE = 0.4; // tolérance de bruit sous/au-dessus du SL (× ATR d'entrée)

// ---- Profils par classe d'actif ------------------------------------------
// minTrendR2 = FILTRE DE RÉGIME : qualité minimale de tendance (r² de la
//   régression linéaire). En marché haché (r² faible) le suivi de tendance
//   se fait whipsawer → abstention. Plus élevé pour forex/actions, qui
//   « hachent » davantage en intraday (mesuré : EURUSD/AAPL @1h).
// minVotes = nombre de signaux de confluence (sur 3) requis. La crypto trende
//   proprement → 2/3 suffit. Forex/actions intraday → unanimité (3/3).
// slMult = multiplicateur ATR du stop initial (avant ancrage sur la structure).
// maxExtAtr = ANTI-CHASING : distance max prix↔EMA lente (en ATR) tolérée pour
//   entrer. Au-delà, le mouvement est déjà étendu → on n'entre pas (on attend un
//   repli). Plus large en crypto (tendances explosives), plus serré ailleurs.
const ASSET_PROFILES = {
  crypto: { slMult: 2.0, baseRisk: 0.015, cooldown: 6, minTrendR2: 0.30, minVotes: 2, maxExtAtr: 4.0 },
  forex:  { slMult: 1.6, baseRisk: 0.020, cooldown: 8, minTrendR2: 0.65, minVotes: 3, maxExtAtr: 3.2 },
  stocks: { slMult: 1.8, baseRisk: 0.020, cooldown: 8, minTrendR2: 0.55, minVotes: 3, maxExtAtr: 3.5 },
};
function profileFor(category) {
  return ASSET_PROFILES[category] || ASSET_PROFILES.crypto;
}

export class TradingEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.wallet = START_WALLET;
    this.equityPeak = START_WALLET;
    this.open = []; // positions ouvertes
    this.closed = []; // historique
    this.lastEntryIndex = -Infinity; // anti-spam temporel
    this.listeners = [];
  }

  onUpdate(fn) {
    this.listeners.push(fn);
  }

  _dbg(tag) {
    // Compteur de rejets d'entrée — diagnostic uniquement
    if (typeof window !== "undefined") {
      window.__tvRejects = window.__tvRejects || {};
      window.__tvRejects[tag] = (window.__tvRejects[tag] || 0) + 1;
    }
  }
  _emit() {
    for (const fn of this.listeners) fn(this.summary());
  }

  /* ------------------------------------------------------------------
   * Tick principal — appelé par le contrôleur de replay à CHAQUE bougie.
   * @param {Array} slice  bougies [0..t] (INV-1 : jamais le futur)
   * @param {Object} ctx   { consensus, atr, levels, category, confluence, trend }
   * ------------------------------------------------------------------ */
  onBar(slice, ctx) {
    const bar = slice[slice.length - 1];
    this._manageOpen(bar, slice.length - 1, ctx);
    this._maybeEnter(slice, ctx);
    this._emit();
  }

  /* ---------------- Gestion des positions ouvertes ------------------ */
  _manageOpen(bar, barIndex, ctx) {
    const still = [];
    for (const p of this.open) {
      const exit = this._resolveBar(p, bar);
      if (exit) {
        this._close(p, exit.price, exit.reason, bar.time);
        continue;
      }
      // Timeout de détention
      if (barIndex - p.entryIndex >= MAX_HOLD_BARS) {
        this._close(p, bar.close, "Timeout", bar.time);
        continue;
      }
      // Sortie sur RETOURNEMENT de tendance (la confluence s'inverse
      // nettement) — on coupe une position qui n'est plus dans le sens
      // de la tendance. Donnée du slice courant uniquement.
      const conf = ctx.confluence;
      if (conf && conf.dir !== "none" && conf.dir !== p.side && conf.votes >= 2) {
        this._close(p, bar.close, "Reversal", bar.time);
        continue;
      }
      this._updateStops(p, bar);
      still.push(p);
    }
    this.open = still;
  }

  /* ------------------------------------------------------------------
   * INV-4 — RÈGLE CONSERVATRICE INTRA-BOUGIE (SL-first) + ANTI-WHIPSAW.
   *
   * Stop confirmé en CLÔTURE avec bande de bruit (STOP_GRACE × ATR d'entrée) :
   *  - cassure FRANCHE (mèche au-delà du SL de plus de `grace`) → stop exécuté
   *    au SL (pire cas) ;
   *  - perçage SUPERFICIEL (≤ grace) : on n'exécute le stop QUE si la bougie
   *    CLÔTURE au-delà du SL. Si elle clôture du bon côté, c'est une mèche de
   *    bruit (le repli de 1-3 bougies décrit) → on NE sort PAS, la position
   *    « accepte » le petit repli et peut repartir.
   *  - si TP et perçage superficiel coexistent dans la même bougie : on reste
   *    conservateur (SL-first, on ne sait pas l'ordre intra-bougie, INV-5).
   * On ne lit que des données de la bougie CLOSE (low/high/close) — pas de futur.
   * ------------------------------------------------------------------ */
  _resolveBar(p, bar) {
    const grace = (p.atr || 0) * STOP_GRACE;
    if (p.side === "long") {
      const hitTP = bar.high >= p.tp;
      const decisiveSL = bar.low <= p.sl - grace;     // cassure franche
      const shallowSL = bar.low <= p.sl && !decisiveSL; // perçage de bruit
      if (decisiveSL) return { price: p.sl, reason: hitTP ? "SL (both-hit, worst-case)" : "SL" };
      if (shallowSL) {
        if (hitTP) return { price: p.sl, reason: "SL (both-hit, worst-case)" };
        if (bar.close <= p.sl) return { price: p.sl, reason: "SL (close-confirmed)" };
        // sinon : mèche de bruit, clôture au-dessus du SL → on garde la position
      } else if (hitTP) {
        return { price: p.tp, reason: "TP" };
      }
    } else {
      const hitTP = bar.low <= p.tp;
      const decisiveSL = bar.high >= p.sl + grace;
      const shallowSL = bar.high >= p.sl && !decisiveSL;
      if (decisiveSL) return { price: p.sl, reason: hitTP ? "SL (both-hit, worst-case)" : "SL" };
      if (shallowSL) {
        if (hitTP) return { price: p.sl, reason: "SL (both-hit, worst-case)" };
        if (bar.close >= p.sl) return { price: p.sl, reason: "SL (close-confirmed)" };
      } else if (hitTP) {
        return { price: p.tp, reason: "TP" };
      }
    }
    return null;
  }

  _updateStops(p, bar) {
    const r = Math.abs(p.entry - p.initialSL);
    if (r <= 0) return;
    const atr = p.atr || r;
    if (p.side === "long") {
      const gainR = (bar.close - p.entry) / r;
      if (gainR >= BREAK_EVEN_R && p.sl < p.entry) p.sl = p.entry;
      if (gainR >= TRAIL_R) {
        const trail = bar.close - atr * TRAIL_ATR;
        if (trail > p.sl) p.sl = trail;
      }
    } else {
      const gainR = (p.entry - bar.close) / r;
      if (gainR >= BREAK_EVEN_R && p.sl > p.entry) p.sl = p.entry;
      if (gainR >= TRAIL_R) {
        const trail = bar.close + atr * TRAIL_ATR;
        if (trail < p.sl) p.sl = trail;
      }
    }
  }

  /* Libellés lisibles des signaux de confluence alignés. */
  _confReasons(conf) {
    const dirSign = conf.dir === "long" ? 1 : -1;
    const out = [];
    if (Math.sign(conf.ema) === dirSign) out.push("Tendance EMA");
    if (Math.sign(conf.mom) === dirSign) out.push("Momentum");
    if (Math.sign(conf.brk) === dirSign) out.push("Cassure Donchian");
    return out.slice(0, 2);
  }

  /* ---------------- Entrées par SUIVI DE TENDANCE (confluence) ------ */
  _maybeEnter(slice, ctx) {
    const prof = profileFor(ctx.category);
    const RR_MIN = MIN_RR;
    const SL_MULT = prof.slMult;

    // ---- FILTRE DIRECTIONNEL PRINCIPAL : CONFLUENCE DE TENDANCE ----
    // Direction = vote EMA + momentum + breakout. On exige au moins
    // `minVotes` signaux alignés (qualité), sinon pas d'edge.
    const conf = ctx.confluence;
    if (!conf || conf.dir === "none" || conf.votes < prof.minVotes) { this._dbg("noConfluence"); return; }
    const side = conf.dir; // "long" | "short" — on suit TOUJOURS la tendance

    // ---- FILTRE DE RÉGIME : ne trader QUE dans un vrai trend ----
    // En marché haché (r² faible), le suivi de tendance se fait whipsawer.
    const trend = ctx.trend || { r2: 0, direction: "flat" };
    if (trend.r2 < prof.minTrendR2) { this._dbg("chop"); return; }
    if ((side === "long" && trend.direction === "down") ||
        (side === "short" && trend.direction === "up")) { this._dbg("trendConflict"); return; }

    // ---- FILTRE ANTI-CHASING : ne pas entrer si le mouvement est DÉJÀ étendu ----
    // Si le prix est trop loin de l'EMA lente (en ATR), la « conséquence » a déjà
    // eu lieu : entrer ici = courir après. On s'abstient et on attend un repli
    // (cf. recherche : entrer tard après un mouvement étendu sous-performe).
    if (ctx.extAtr != null && ctx.extAtr > prof.maxExtAtr) { this._dbg("overextended"); return; }

    // ---- VETO : consensus de patterns FORTEMENT à contre-tendance ----
    const c = ctx.consensus;
    if (c && c.direction !== "neutral") {
      const consSide = c.direction === "bullish" ? "long" : "short";
      if (consSide !== side && c.strength >= STRONG_OPPOSE) { this._dbg("opposed"); return; }
    }

    // Anti-spam temporel : cooldown propre à la classe d'actif
    if (slice.length - 1 - this.lastEntryIndex < prof.cooldown) { this._dbg("cooldown"); return; }

    // Plafonds
    if (this.open.length >= MAX_OPEN_POSITIONS) { this._dbg("maxpos"); return; }
    // On n'empile pas deux positions de même sens.
    if (this.open.some((p) => p.side === side)) { this._dbg("alreadyOpen"); return; }

    const bar = slice[slice.length - 1];
    const entry = bar.close; // entrée au close de la bougie confirmée
    const atr = ctx.atr || entry * 0.01;

    // Extrême de structure récent (≈10 bougies, hors bougie courante) : on place
    // le stop AU-DELÀ de ce niveau + tampon ATR, pour qu'un repli mineur normal
    // (le petit head-and-shoulders interne décrit) ne le déclenche pas.
    const SWING_LB = 10;
    const from = Math.max(0, slice.length - 1 - SWING_LB);
    let recentLow = Infinity, recentHigh = -Infinity;
    for (let i = from; i < slice.length - 1; i++) {
      if (slice[i].low < recentLow) recentLow = slice[i].low;
      if (slice[i].high > recentHigh) recentHigh = slice[i].high;
    }
    // Plafond de risque : on élargit le stop pour respirer, mais jamais au-delà
    // de 1.7× le stop ATR de base (sinon le sizing deviendrait dérisoire).
    const maxRisk = atr * SL_MULT * 1.7;

    // SL : stop ATR de base, ÉLARGI (jamais resserré) au-delà du swing récent.
    let sl, tp;
    if (side === "long") {
      sl = entry - atr * SL_MULT;
      if (isFinite(recentLow)) sl = Math.min(sl, recentLow - atr * 0.5);
      if (entry - sl > maxRisk) sl = entry - maxRisk;
    } else {
      sl = entry + atr * SL_MULT;
      if (isFinite(recentHigh)) sl = Math.max(sl, recentHigh + atr * 0.5);
      if (sl - entry > maxRisk) sl = entry + maxRisk;
    }

    // Ratio R minimal — on refuse les trades à espérance défavorable.
    const risk = Math.abs(entry - sl);
    if (risk <= 0) { this._dbg("badRR"); return; }

    // TP dérivé du RISQUE réel (RR_TARGET) → RR stable malgré l'élargissement du
    // stop. Pris plus tôt s'il existe un S/R intermédiaire crédible (≥ RR_MIN).
    if (side === "long") {
      tp = entry + risk * RR_TARGET;
      const res = (ctx.levels || []).filter((l) => l.price > entry * 1.002).sort((a, b) => a.price - b.price)[0];
      if (res && res.price < tp && res.price - entry >= risk * RR_MIN) tp = res.price;
    } else {
      tp = entry - risk * RR_TARGET;
      const sup = (ctx.levels || []).filter((l) => l.price < entry * 0.998).sort((a, b) => b.price - a.price)[0];
      if (sup && sup.price > tp && entry - sup.price >= risk * RR_MIN) tp = sup.price;
    }

    const reward = Math.abs(tp - entry);
    if (reward / risk < RR_MIN) { this._dbg("badRR"); return; }

    // Sizing fonction de la force de la confluence (2 votes → 0.8x, 3 → 1.2x).
    const confMult = conf.votes >= 3 ? 1.2 : 0.8;
    const riskAmount = this.wallet * prof.baseRisk * confMult;
    let qty = riskAmount / risk;
    let notional = qty * entry;

    // Plafond d'exposition totale : on BORNE la quantité (jamais de rejet
    // dur, sinon un SL serré → notionnel > wallet → 0 trade).
    const exposure = this.open.reduce((s, p) => s + p.qty * p.entry, 0);
    const maxNotional = this.wallet * MAX_TOTAL_EXPOSURE - exposure;
    if (maxNotional < this.wallet * 0.05) { this._dbg("exposure"); return; }
    if (notional > maxNotional) {
      qty = maxNotional / entry;
      notional = maxNotional;
    }

    this.open.push({
      id: uid(),
      side,
      entry,
      qty,
      sl,
      initialSL: sl,
      tp,
      atr, // ATR à l'entrée — sert à la bande de bruit du stop et au trailing
      entryIndex: slice.length - 1,
      entryTime: bar.time,
      confidence: conf.votes / 3,
      reasons: this._confReasons(conf),
    });
    this.lastEntryIndex = slice.length - 1;
  }

  _close(p, price, reason, time) {
    const pnl = p.side === "long" ? (price - p.entry) * p.qty : (p.entry - price) * p.qty;
    this.wallet += pnl;
    this.equityPeak = Math.max(this.equityPeak, this.wallet);
    this.closed.push({ ...p, exit: price, exitTime: time, pnl, reason });
  }

  /* Fermeture forcée en fin de replay (raison "End") */
  closeAll(lastBar) {
    for (const p of this.open) this._close(p, lastBar.close, "End", lastBar.time);
    this.open = [];
    this._emit();
  }

  /* PnL latent par position au prix courant */
  unrealized(price) {
    return this.open.map((p) => ({
      ...p,
      uPnl: p.side === "long" ? (price - p.entry) * p.qty : (p.entry - price) * p.qty,
    }));
  }

  summary() {
    const wins = this.closed.filter((t) => t.pnl > 0).length;
    const total = this.closed.length;
    const pnl = this.wallet - START_WALLET;
    return {
      wallet: this.wallet,
      pnl,
      pnlPct: (pnl / START_WALLET) * 100,
      wins,
      total,
      accuracy: total ? (wins / total) * 100 : 0,
      openLongs: this.open.filter((p) => p.side === "long").length,
      openShorts: this.open.filter((p) => p.side === "short").length,
      open: this.open,
      closed: this.closed,
      startWallet: START_WALLET,
    };
  }
}

export function describeTrade(t) {
  return `${t.side.toUpperCase()} @ ${formatPrice(t.entry)} → ${formatPrice(t.exit ?? t.tp)}`;
}
