/* ============================================================
   drawing.js — Dessin libre tactile + reconnaissance de forme.

   Pipeline :
   1. Capture pointer events sur le canvas de dessin.
   2. Normalisation : rééchantillonnage à 64 points équidistants,
     mise à l'échelle dans une boîte unitaire [0,1]x[0,1].
   3. Extraction d'extrema locaux du tracé normalisé.
   4. Classification heuristique → pattern correspondant.
   5. Projection visuelle (renvoyée à l'appelant, dessin pur).
   ============================================================ */

/** Rééchantillonne un tracé en `n` points équidistants (le long de la courbe). */
function resample(points, n = 64) {
  if (points.length < 2) return points.slice();
  let totalLen = 0;
  for (let i = 1; i < points.length; i++) {
    totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (totalLen === 0) return points.slice(0, 1);
  const step = totalLen / (n - 1);
  const out = [points[0]];
  let acc = 0;
  let i = 1;
  let prev = points[0];
  while (i < points.length && out.length < n) {
    const d = Math.hypot(points[i].x - prev.x, points[i].y - prev.y);
    if (acc + d >= step) {
      const t = (step - acc) / d;
      const nx = prev.x + t * (points[i].x - prev.x);
      const ny = prev.y + t * (points[i].y - prev.y);
      out.push({ x: nx, y: ny });
      prev = { x: nx, y: ny };
      acc = 0;
    } else {
      acc += d;
      prev = points[i];
      i++;
    }
  }
  while (out.length < n) out.push(points[points.length - 1]);
  return out;
}

/** Normalise dans une boîte [0,1]² ; y inversé (1 = haut prix). */
function normalize(points) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
  return points.map((p) => ({
    x: (p.x - minX) / w,
    y: 1 - (p.y - minY) / h, // inversé : 1 = haut de l'écran = prix haut
  }));
}

/** Extrema locaux (peaks/valleys) sur le tracé normalisé, avec proéminence min. */
function findExtrema(pts, minProm = 0.12) {
  const ex = [];
  for (let i = 2; i < pts.length - 2; i++) {
    const y = pts[i].y;
    const isPeak = y > pts[i - 1].y && y > pts[i + 1].y && y >= pts[i - 2].y && y >= pts[i + 2].y;
    const isValley = y < pts[i - 1].y && y < pts[i + 1].y && y <= pts[i - 2].y && y <= pts[i + 2].y;
    if (isPeak || isValley) {
      const last = ex[ex.length - 1];
      // Fusionne les extrema trop proches / de faible proéminence
      if (last && Math.abs(last.y - y) < minProm && last.kind === (isPeak ? 'peak' : 'valley')) continue;
      ex.push({ i, x: pts[i].x, y, kind: isPeak ? 'peak' : 'valley' });
    }
  }
  return ex;
}

/**
 * Classifie le tracé normalisé. Retourne
 * { type, name, direction, confidence } ou null.
 */
export function recognizeShape(rawPoints) {
  if (rawPoints.length < 10) return null;
  const pts = normalize(resample(rawPoints, 64));
  const ex = findExtrema(pts);
  const peaks = ex.filter((e) => e.kind === 'peak');
  const valleys = ex.filter((e) => e.kind === 'valley');
  const startY = pts[0].y, endY = pts[pts.length - 1].y;
  const eq = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;

  // --- Head & Shoulders : 3 pics, celui du milieu domine ---
  if (peaks.length === 3) {
    const [l, h, r] = peaks;
    if (h.y > l.y + 0.12 && h.y > r.y + 0.12 && eq(l.y, r.y, 0.2)) {
      return { type: 'hs', name: 'Tête-Épaules', direction: 'bearish', confidence: 0.8 };
    }
  }
  if (valleys.length === 3) {
    const [l, h, r] = valleys;
    if (h.y < l.y - 0.12 && h.y < r.y - 0.12 && eq(l.y, r.y, 0.2)) {
      return { type: 'ihs', name: 'Tête-Épaules Inversé', direction: 'bullish', confidence: 0.8 };
    }
  }
  // --- Triple top/bottom ---
  if (peaks.length >= 3 && eq(peaks[0].y, peaks[1].y, 0.13) && eq(peaks[1].y, peaks[2].y, 0.13)) {
    return { type: 'triple_top', name: 'Triple Top', direction: 'bearish', confidence: 0.75 };
  }
  if (valleys.length >= 3 && eq(valleys[0].y, valleys[1].y, 0.13) && eq(valleys[1].y, valleys[2].y, 0.13)) {
    return { type: 'triple_bottom', name: 'Triple Bottom', direction: 'bullish', confidence: 0.75 };
  }
  // --- Double top / bottom : M ou W ---
  if (peaks.length === 2 && eq(peaks[0].y, peaks[1].y, 0.16) && peaks[0].y > startY + 0.2 && peaks[1].y > endY + 0.1) {
    return { type: 'double_top', name: 'Double Top', direction: 'bearish', confidence: 0.78 };
  }
  if (valleys.length === 2 && eq(valleys[0].y, valleys[1].y, 0.16) && valleys[0].y < startY - 0.2 && valleys[1].y < endY - 0.1) {
    return { type: 'double_bottom', name: 'Double Bottom', direction: 'bullish', confidence: 0.78 };
  }

  // --- Triangles / wedges : enveloppe convergente ---
  // Régression sur enveloppes haute et basse du tracé (par buckets x)
  const buckets = 8;
  const hi = [], lo = [];
  for (let b = 0; b < buckets; b++) {
    const seg = pts.filter((p) => p.x >= b / buckets && p.x < (b + 1) / buckets);
    if (!seg.length) continue;
    hi.push(Math.max(...seg.map((p) => p.y)));
    lo.push(Math.min(...seg.map((p) => p.y)));
  }
  if (hi.length >= 5) {
    const slope = (arr) => {
      const n = arr.length;
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let i = 0; i < n; i++) { sx += i; sy += arr[i]; sxy += i * arr[i]; sxx += i * i; }
      const d = n * sxx - sx * sx;
      return d === 0 ? 0 : (n * sxy - sx * sy) / d;
    };
    const hs = slope(hi), ls = slope(lo);
    const spreadStart = hi[0] - lo[0];
    const spreadEnd = hi[hi.length - 1] - lo[lo.length - 1];
    const converging = spreadEnd < spreadStart * 0.6;
    const FLAT = 0.012;
    if (converging) {
      if (Math.abs(hs) < FLAT && ls > FLAT) return { type: 'asc_triangle', name: 'Triangle Ascendant', direction: 'bullish', confidence: 0.7 };
      if (Math.abs(ls) < FLAT && hs < -FLAT) return { type: 'desc_triangle', name: 'Triangle Descendant', direction: 'bearish', confidence: 0.7 };
      if (hs < -FLAT && ls > FLAT) return { type: 'sym_triangle', name: 'Triangle Symétrique', direction: 'neutral', confidence: 0.65 };
      if (hs > FLAT && ls > FLAT) return { type: 'rising_wedge', name: 'Biseau Ascendant', direction: 'bearish', confidence: 0.65 };
      if (hs < -FLAT && ls < -FLAT) return { type: 'falling_wedge', name: 'Biseau Descendant', direction: 'bullish', confidence: 0.65 };
    }
  }

  // --- Flag : forte pente puis consolidation ---
  const half1 = pts.slice(0, 32), half2 = pts.slice(32);
  const rise1 = half1[half1.length - 1].y - half1[0].y;
  const rise2 = half2[half2.length - 1].y - half2[0].y;
  if (Math.abs(rise1) > 0.45 && Math.abs(rise2) < 0.2) {
    return rise1 > 0
      ? { type: 'bull_flag', name: 'Drapeau Haussier', direction: 'bullish', confidence: 0.62 }
      : { type: 'bear_flag', name: 'Drapeau Baissier', direction: 'bearish', confidence: 0.62 };
  }

  // --- Ligne de tendance simple ---
  if (ex.length <= 1) {
    const rise = endY - startY;
    if (rise > 0.3) return { type: 'trendline_up', name: 'Ligne de Tendance Haussière', direction: 'bullish', confidence: 0.55 };
    if (rise < -0.3) return { type: 'trendline_down', name: 'Ligne de Tendance Baissière', direction: 'bearish', confidence: 0.55 };
  }
  return null;
}

/**
 * Gestionnaire de dessin sur canvas : capture le tracé, le rend en
 * temps réel, et appelle onComplete(points) au relâchement.
 */
export function createDrawController(canvas, onComplete) {
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let points = [];
  let dpr = 1;

  function resize() {
    // Mêmes gardes que overlay.js : DPR plafonné (mémoire bornée),
    // pas d'écriture si la taille CSS n'a pas changé (anti-boucle),
    // pas de corruption du backing store si le canvas est masqué (0x0).
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const r = canvas.getBoundingClientRect();
    const w = Math.floor(r.width * dpr);
    const h = Math.floor(r.height * dpr);
    if (w <= 0 || h <= 0) return;
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function render() {
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    if (points.length < 2) return;
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  function localPos(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function onDown(ev) {
    ev.preventDefault();
    drawing = true;
    points = [localPos(ev)];
    canvas.setPointerCapture?.(ev.pointerId);
  }
  function onMove(ev) {
    if (!drawing) return;
    ev.preventDefault();
    points.push(localPos(ev));
    render();
  }
  function onUp(ev) {
    if (!drawing) return;
    drawing = false;
    if (points.length >= 10) onComplete(points.slice());
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  window.addEventListener('resize', resize);
  resize();

  return {
    clear() { points = []; render(); },
    resize,
    destroy() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      window.removeEventListener('resize', resize);
    },
  };
}
