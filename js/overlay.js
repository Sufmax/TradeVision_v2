/* ============================================================
   overlay.js — Canvas de dessin des lignes structurelles.

   DESSIN PUR (INV-3) : ce module ne fait que convertir des
   coordonnées time/price en pixels via l'API du chart et dessiner.
   Aucune variable de décision, aucun PnL, aucun module de logique
   ne lit quoi que ce soit d'ici. Les projections vers le futur
   (cibles, prolongements) restent purement visuelles.
   ============================================================ */

import { formatPrice } from './utils.js';

const ROLE_COLORS = {
  resistance: 'rgba(239, 68, 68, 0.85)',
  support: 'rgba(16, 185, 129, 0.85)',
  neckline: 'rgba(34, 211, 238, 0.9)',
  target: 'rgba(245, 158, 11, 0.9)',
  structure: 'rgba(139, 147, 167, 0.7)',
};

// Couleurs des zones de trade (style "position tool" des plateformes pros)
const TRADE = {
  win: '#10b981',
  loss: '#ef4444',
  winFill: 'rgba(16, 185, 129, 0.14)',
  lossFill: 'rgba(239, 68, 68, 0.14)',
  winFillClosed: 'rgba(16, 185, 129, 0.09)',
  lossFillClosed: 'rgba(239, 68, 68, 0.09)',
};

export function createOverlay(canvas, chartMgr) {
  const ctx = canvas.getContext('2d');
  let selectedPattern = null; // pattern dont on trace les lignes
  let drawnProjection = null; // projection issue du dessin libre
  let trades = null;          // { open:[], closed:[] } — visualisation replay
  let dpr = 1;

  function resize() {
    // Garde anti-boucle (défense en profondeur, en plus du fix CSS
    // width/height:100%) : on ne touche au backing store que si la
    // taille CSS a réellement changé. Écrire canvas.width à l'identique
    // resterait coûteux (reset du contexte) et, sans le fix CSS, chaque
    // écriture re-déclenchait le ResizeObserver → croissance
    // exponentielle → canvas hors limite → image cassée sur mobile.
    dpr = Math.min(window.devicePixelRatio || 1, 3); // plafond DPR : qualité suffisante, mémoire bornée
    const r = canvas.getBoundingClientRect();
    const w = Math.floor(r.width * dpr);
    const h = Math.floor(r.height * dpr);
    if (w <= 0 || h <= 0) return; // conteneur masqué : ne pas corrompre le canvas
    if (canvas.width === w && canvas.height === h) return; // aucune vraie variation
    canvas.width = w;
    canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function clear() {
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
  }

  function drawLine(t1, p1, t2, p2, role, label) {
    const x1 = chartMgr.timeToX(t1);
    const y1 = chartMgr.priceToY(p1);
    const x2 = chartMgr.timeToX(t2);
    const y2 = chartMgr.priceToY(p2);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return;
    ctx.strokeStyle = ROLE_COLORS[role] || ROLE_COLORS.structure;
    ctx.lineWidth = role === 'neckline' ? 2 : 1.5;
    ctx.setLineDash(role === 'target' ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (label) {
      ctx.fillStyle = ROLE_COLORS[role] || ROLE_COLORS.structure;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText(label, Math.min(x1, x2) + 4, Math.min(y1, y2) - 5);
    }
  }

  /* ----- Visualisation des trades (style plateforme pro) -----
     Pour chaque trade : une zone GAIN (entrée→TP, verte) et une zone PERTE
     (entrée→SL, rouge), bornées en X de la flèche d'entrée jusqu'à la
     dernière bougie (trade ouvert) ou jusqu'à la sortie (trade clos, figé).
     Plus une flèche d'entrée dans un rond coloré et un marqueur de sortie
     ✓/✕ pour les trades clos. */
  function drawZone(t, isOpen, lastTime, rectW) {
    const xEntry = chartMgr.timeToX(t.entryTime);
    const x1 = xEntry == null ? 0 : xEntry; // entrée hors-écran à gauche → bord
    const endTime = isOpen ? lastTime : t.exitTime;
    let x2 = endTime == null ? null : chartMgr.timeToX(endTime);
    if (x2 == null) x2 = isOpen ? rectW : (xEntry == null ? 0 : rectW);
    const yEntry = chartMgr.priceToY(t.entry);
    const yTP = chartMgr.priceToY(t.tp);
    const ySL = chartMgr.priceToY(t.sl);
    if (yEntry == null || yTP == null || ySL == null) return;
    const left = Math.min(x1, x2);
    const w = Math.max(1, Math.abs(x2 - x1));

    // Zones remplies
    ctx.fillStyle = isOpen ? TRADE.winFill : TRADE.winFillClosed;
    ctx.fillRect(left, Math.min(yEntry, yTP), w, Math.abs(yTP - yEntry));
    ctx.fillStyle = isOpen ? TRADE.lossFill : TRADE.lossFillClosed;
    ctx.fillRect(left, Math.min(yEntry, ySL), w, Math.abs(ySL - yEntry));

    // Bords TP (haut) / SL (bas) + ligne d'entrée
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = TRADE.win;
    line(left, yTP, left + w, yTP);
    ctx.strokeStyle = TRADE.loss;
    line(left, ySL, left + w, ySL);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(139, 147, 167, 0.85)';
    line(left, yEntry, left + w, yEntry);

    // Étiquettes de prix (TP/SL) au bord droit — uniquement pour la position
    // ouverte, afin d'éviter de surcharger l'historique.
    if (isOpen) {
      tag(left + w, yTP, `TP ${formatPrice(t.tp)}`, TRADE.win);
      tag(left + w, ySL, `SL ${formatPrice(t.sl)}`, TRADE.loss);
    }
  }

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Petite étiquette de prix alignée à droite d'un bord de zone
  function tag(xRight, y, text, color) {
    ctx.font = '700 9px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 8;
    const r = canvas.getBoundingClientRect();
    const x = Math.min(xRight, r.width - w - 2);
    ctx.fillStyle = 'rgba(11, 14, 20, 0.82)';
    ctx.fillRect(x, y - 7, w, 14);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 4, y + 1);
    ctx.textBaseline = 'alphabetic';
  }

  // Flèche d'entrée diagonale dans un rond (vert = achat/long, rouge = vente/short)
  function drawEntryArrow(t) {
    const x = chartMgr.timeToX(t.entryTime);
    const y = chartMgr.priceToY(t.entry);
    if (x == null || y == null) return;
    const long = t.side === 'long';
    const col = long ? TRADE.win : TRADE.loss;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(11, 14, 20, 0.9)';
    ctx.stroke();
    // flèche ↗ (long) ou ↘ (short)
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const a = 3.4;
    ctx.beginPath();
    if (long) {
      ctx.moveTo(x - a, y + a); ctx.lineTo(x + a, y - a);
      ctx.lineTo(x + a - 3.4, y - a);
      ctx.moveTo(x + a, y - a); ctx.lineTo(x + a, y - a + 3.4);
    } else {
      ctx.moveTo(x - a, y - a); ctx.lineTo(x + a, y + a);
      ctx.lineTo(x + a - 3.4, y + a);
      ctx.moveTo(x + a, y + a); ctx.lineTo(x + a, y + a - 3.4);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // Marqueur de sortie : rond ✓ (gagnant) ou ✕ (perdant), conserve l'info TP/SL
  function drawExitMarker(t) {
    const x = chartMgr.timeToX(t.exitTime);
    const y = chartMgr.priceToY(t.exit);
    if (x == null || y == null) return;
    const win = t.pnl >= 0;
    const col = win ? TRADE.win : TRADE.loss;
    ctx.beginPath();
    ctx.arc(x, y, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(11, 14, 20, 0.92)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (win) {
      ctx.moveTo(x - 3, y); ctx.lineTo(x - 0.6, y + 2.8); ctx.lineTo(x + 3.4, y - 3);
    } else {
      ctx.moveTo(x - 2.7, y - 2.7); ctx.lineTo(x + 2.7, y + 2.7);
      ctx.moveTo(x + 2.7, y - 2.7); ctx.lineTo(x - 2.7, y + 2.7);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  function drawTrades() {
    if (!trades) return;
    const data = chartMgr.getData();
    const lastTime = data.length ? data[data.length - 1].time : null;
    const rectW = canvas.getBoundingClientRect().width;
    // Zones d'abord (clos puis ouverts), marqueurs ensuite (au-dessus)
    for (const t of trades.closed) drawZone(t, false, lastTime, rectW);
    for (const p of trades.open) drawZone(p, true, lastTime, rectW);
    for (const t of trades.closed) { drawEntryArrow(t); drawExitMarker(t); }
    for (const p of trades.open) drawEntryArrow(p);
  }

  function render() {
    clear();
    drawTrades();
    if (selectedPattern?.lines) {
      for (const l of selectedPattern.lines) {
        drawLine(l.t1, l.p1, l.t2, l.p2, l.role, l.role === 'target' ? `Cible ${formatPrice(l.p2)}` : l.role);
      }
    }
    if (drawnProjection) {
      // Projection du dessin libre : polyline stylisée + zone cible
      const pts = drawnProjection.points;
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const x = chartMgr.timeToX(p.time);
        const y = chartMgr.priceToY(p.price);
        if (x == null || y == null) continue;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (drawnProjection.label) {
        const first = pts[0];
        const x = chartMgr.timeToX(first.time);
        const y = chartMgr.priceToY(first.price);
        if (x != null && y != null) {
          ctx.fillStyle = 'rgba(34, 211, 238, 1)';
          ctx.font = '700 11px system-ui, sans-serif';
          ctx.fillText(drawnProjection.label, x + 6, y - 8);
        }
      }
    }
  }

  // ----- Boucle de suivi (rAF) -----
  // PROBLÈME : lightweight-charts n'émet d'événement QUE pour l'axe TEMPS
  // (subscribeVisibleTimeRangeChange / LogicalRange). Quand l'utilisateur
  // change l'ÉCHELLE DE PRIX (glissement sur l'axe de droite), aucun
  // événement n'est émis → les lignes du pattern ne suivaient plus la courbe.
  // SOLUTION : une boucle rAF active uniquement tant qu'il y a du contenu à
  // dessiner. Elle ne redessine que si la transformation a réellement changé
  // (signature pixel d'un point d'ancrage), donc coût quasi nul au repos.
  let rafId = null;
  let lastSig = '';

  function tradesHaveContent() {
    return !!(trades && (trades.open.length || trades.closed.length));
  }

  function hasContent() {
    return !!((selectedPattern && selectedPattern.lines && selectedPattern.lines.length) || drawnProjection || tradesHaveContent());
  }

  // Signature = position pixel d'un point d'ancrage → capte les DEUX axes.
  function transformSig() {
    let t, p;
    if (selectedPattern?.lines?.length) { t = selectedPattern.lines[0].t1; p = selectedPattern.lines[0].p1; }
    else if (drawnProjection?.points?.length) { t = drawnProjection.points[0].time; p = drawnProjection.points[0].price; }
    else if (tradesHaveContent()) {
      const a = trades.open[0] || trades.closed[0];
      t = a.entryTime; p = a.entry;
    }
    else return '';
    const x = chartMgr.timeToX(t);
    const y = chartMgr.priceToY(p);
    return `${x}:${y}`;
  }

  function loop() {
    const sig = transformSig();
    if (sig !== lastSig) { lastSig = sig; render(); }
    rafId = hasContent() ? requestAnimationFrame(loop) : null;
  }

  function ensureLoop() {
    lastSig = ''; // force un premier rendu
    render();
    if (hasContent() && rafId == null) rafId = requestAnimationFrame(loop);
  }

  // Redessine sur zoom / scroll du chart (axe temps)
  chartMgr.onVisibleRangeChange(() => render());
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  return {
    /** Sélectionne un pattern → trace ses lignes structurelles. */
    selectPattern(p) { selectedPattern = p; ensureLoop(); },
    /** Projection issue du dessin libre (points {time, price}). */
    setProjection(proj) { drawnProjection = proj; ensureLoop(); },
    /** Trades du replay à visualiser ({ open, closed }). */
    setTrades(summary) { trades = { open: summary.open, closed: summary.closed }; ensureLoop(); },
    clearTrades() { trades = null; render(); },
    clearAll() { selectedPattern = null; drawnProjection = null; render(); },
    render,
    destroy() { ro.disconnect(); if (rafId != null) cancelAnimationFrame(rafId); },
  };
}
