/* ============================================================
   utils.js — Fonctions pures partagées.
   Aucune dépendance, aucune lecture d'état global.
   ============================================================ */

/** Clamp une valeur dans [min, max]. */
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/** Moyenne arithmétique d'un tableau. */
export function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

/**
 * Régression linéaire simple sur des y (x implicite = index).
 * Retourne { slope, intercept, r2 }.
 */
export function linearRegression(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += ys[i]; sumXY += i * ys[i]; sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: mean(ys), r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // r2
  const yMean = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * i + intercept;
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

/** Formate un prix avec un nombre de décimales adapté à sa magnitude. */
export function formatPrice(p) {
  if (p == null || !isFinite(p)) return '—';
  if (p >= 10000) return p.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(5);
  return p.toPrecision(4);
}

/** Formate un montant en dollars. */
export function formatUsd(v) {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

/** Formate un pourcentage signé. */
export function formatPct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/**
 * Hash djb2 d'une chaîne — utilisé pour le hash de l'ensemble
 * stable de patterns (anti re-render et anti-spam de trades).
 */
export function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** Debounce simple. */
export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Génère un identifiant court unique (pour les trades). */
let _idCounter = 0;
export function uid(prefix = 'id') {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}
