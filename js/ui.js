/* ============================================================
   ui.js — Composants UI : toasts, sheets, panels, modales,
   rendu des listes (patterns, S/R, trades) et du dashboard.
   Aucune logique de marché ici : uniquement du rendu DOM.
   ============================================================ */

import { formatPrice, formatUsd, formatPct } from './utils.js';

const $ = (id) => document.getElementById(id);

/* ---------------- Toasts (en bas, non-invasifs) ----------------
   Semi-transparents (50% via CSS) et BALAYABLES : on peut les écarter
   d'un glissement latéral avant l'expiration automatique. */
export function toast(msg, type = 'info', ms = 3200) {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'status');
  el.textContent = msg;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-in'));

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.classList.remove('toast-in');
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  };
  let timer = setTimeout(remove, ms);

  // ----- Balayage latéral pour écarter (pointer = tactile + souris) -----
  let startX = 0, dx = 0, dragging = false;
  el.addEventListener('pointerdown', (e) => {
    dragging = true; startX = e.clientX; dx = 0;
    el.style.transition = 'none';
    el.setPointerCapture?.(e.pointerId);
    clearTimeout(timer);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 160));
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    el.style.transition = '';
    if (Math.abs(dx) > 70) {
      el.style.transform = `translateX(${dx > 0 ? 420 : -420}px)`;
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 240);
    } else {
      el.style.transform = '';
      el.style.opacity = '';
      timer = setTimeout(remove, ms);
    }
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

/* ---------------- Sheets / panels / modales ---------------- */
export function openSheet(id) {
  const el = $(id);
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('sheet-open'));
}
export function closeSheet(id) {
  const el = $(id);
  el.classList.remove('sheet-open');
  setTimeout(() => el.classList.add('hidden'), 250);
}
export function closeAllSheets() {
  for (const el of document.querySelectorAll('.sheet, .side-panel, .modal')) {
    if (!el.classList.contains('hidden')) {
      el.classList.remove('sheet-open');
      setTimeout(() => el.classList.add('hidden'), 250);
    }
  }
}

/** Branche tous les éléments [data-close] pour fermer leur cible. */
export function wireCloseButtons() {
  document.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-close]');
    if (target) closeSheet(target.dataset.close);
  });
}

/* ---------------- Bottom sheets : glisser vers le bas pour fermer ----------------
   Tout panneau muni d'une barre (.sheet-handle) peut être tiré vers le bas
   pour se fermer. Le drag démarre depuis la barre / le titre, ou depuis le
   haut du contenu lorsqu'il n'est pas scrollé — sans gêner le scroll interne. */
export function initDraggableSheets() {
  document.querySelectorAll('.sheet').forEach((sheet) => {
    const panel = sheet.querySelector('.sheet-panel');
    if (!panel) return;
    const backdrop = sheet.querySelector('.sheet-backdrop');
    const id = sheet.id;
    let startY = 0, dy = 0, dragging = false;

    const canStart = (e) => {
      if (e.target.closest('.sheet-handle, .sheet-title')) return true;
      return panel.scrollTop <= 0;
    };

    panel.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      if (!canStart(e)) return;
      dragging = true; startY = e.clientY; dy = 0;
      panel.style.transition = 'none';
    });
    panel.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dy = e.clientY - startY;
      if (dy <= 0) { panel.style.transform = ''; if (backdrop) backdrop.style.opacity = ''; return; }
      panel.style.transform = `translate(var(--sx, 0px), ${dy}px)`;
      if (backdrop) backdrop.style.opacity = String(Math.max(0, 0.55 * (1 - dy / 420)));
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = '';
      if (dy > 100) {
        panel.style.transform = `translate(var(--sx, 0px), 100%)`;
        closeSheet(id);
      } else {
        panel.style.transform = '';
      }
      if (backdrop) backdrop.style.opacity = '';
      setTimeout(() => { panel.style.transform = ''; }, 300);
      dy = 0;
    };
    panel.addEventListener('pointerup', end);
    panel.addEventListener('pointercancel', end);
  });
}

/* ---------------- Header prix ---------------- */
export function updatePriceHeader(price, prevClose) {
  $('live-price').textContent = formatPrice(price);
  const el = $('price-change');
  if (prevClose && prevClose > 0) {
    const pct = ((price - prevClose) / prevClose) * 100;
    el.textContent = formatPct(pct);
    el.className = `price-change ${pct >= 0 ? 'text-bull' : 'text-bear'}`;
  } else {
    el.textContent = '—';
  }
}

export function setConnStatus(status) {
  const dot = $('conn-status');
  dot.className = 'conn-dot ' + (status === 'connected' ? 'conn-on' : status === 'reconnecting' ? 'conn-warn' : 'conn-off');
  dot.title = status === 'connected' ? 'Connecté (temps réel)' : status === 'reconnecting' ? 'Reconnexion…' : 'Hors ligne (replay)';
}

/* ---------------- Badge consensus flottant ---------------- */
export function updateConsensusBadge(consensus, replayMode) {
  const el = $('consensus-badge');
  if (!consensus) { el.classList.add('hidden'); return; }
  const { direction, strength, bullPct } = consensus;
  const label = direction === 'bullish' ? 'Haussier' : direction === 'bearish' ? 'Baissier' : 'Neutre';
  const cls = direction === 'bullish' ? 'badge-bull' : direction === 'bearish' ? 'badge-bear' : 'badge-neutral';
  el.className = `consensus-badge ${cls}`;
  el.innerHTML = `<span class="badge-dot"></span>${label} ${direction !== 'neutral' ? `· ${(strength * 100).toFixed(0)}%` : ''}${replayMode ? ' <span class="badge-replay">REPLAY</span>' : ''}`;
  el.classList.remove('hidden');
}

/* ---------------- Alerte S/R ---------------- */
let srAlertTimer = null;
export function showSRAlert(alert) {
  const el = $('sr-alert');
  if (!alert) { el.classList.add('hidden'); return; }
  const kind = alert.level.kind === 'resistance' ? 'résistance' : alert.level.kind === 'support' ? 'support' : 'niveau rond';
  el.textContent = `Proche ${kind} ${formatPrice(alert.level.price)}`;
  el.classList.remove('hidden');
  clearTimeout(srAlertTimer);
  srAlertTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

/* ---------------- Panneau patterns + consensus ---------------- */
export function renderConsensusPanel(consensus) {
  if (!consensus) return;
  $('consensus-bull').style.width = `${consensus.bullPct}%`;
  const verdict = $('consensus-verdict');
  verdict.textContent = consensus.direction === 'bullish' ? `Haussier ${(consensus.strength * 100).toFixed(0)}%`
    : consensus.direction === 'bearish' ? `Baissier ${(consensus.strength * 100).toFixed(0)}%` : 'Neutre';
  verdict.className = 'consensus-verdict ' + (consensus.direction === 'bullish' ? 'text-bull' : consensus.direction === 'bearish' ? 'text-bear' : '');

  const reasons = $('consensus-reasons');
  let html = '';
  for (const r of consensus.reasons) html += `<div class="reason-item">+ ${esc(r)}</div>`;
  for (const c of consensus.contradictions) html += `<div class="reason-item reason-contra">! ${esc(c)}</div>`;
  if (!html) html = '<div class="reason-item muted">Pas assez de signaux directionnels.</div>';
  reasons.innerHTML = html;
}

export function renderPatternsList(patterns, onSelect, selectedKey) {
  const list = $('patterns-list');
  const badge = $('patterns-count-badge');
  const count = $('patterns-count');
  count.textContent = patterns.length ? `(${patterns.length})` : '';
  if (patterns.length) {
    badge.textContent = String(patterns.length);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
  if (!patterns.length) {
    list.innerHTML = '<p class="empty-state">Aucun pattern détecté pour le moment.<br/><span class="muted">Le scanner analyse automatiquement plusieurs fenêtres temporelles.</span></p>';
    return;
  }
  list.innerHTML = '';
  for (const p of patterns) {
    const item = document.createElement('button');
    item.className = 'pattern-item' + (p.key === selectedKey ? ' pattern-selected' : '');
    const dirCls = p.direction === 'bullish' ? 'text-bull' : p.direction === 'bearish' ? 'text-bear' : 'muted';
    const dirLabel = p.direction === 'bullish' ? 'Haussier' : p.direction === 'bearish' ? 'Baissier' : 'Neutre';
    item.innerHTML = `
      <div class="pattern-item-top">
        <span class="pattern-name">${esc(p.name)}</span>
        <span class="pattern-conf">${(p.confidence * 100).toFixed(0)}%</span>
      </div>
      <div class="pattern-item-bottom">
        <span class="${dirCls}">${dirLabel}</span>
        <span class="muted small">${p.status === 'confirmed' ? 'Cassure confirmée' : p.status === 'forming' ? 'En formation' : ''} · fen. ${p.windowSize}</span>
      </div>
      <div class="conf-track"><div class="conf-fill ${p.direction === 'bearish' ? 'conf-bear' : ''}" style="width:${(p.confidence * 100).toFixed(0)}%"></div></div>
    `;
    item.addEventListener('click', () => onSelect(p));
    list.appendChild(item);
  }
}

export function renderSRList(levels, currentPrice) {
  const list = $('sr-list');
  if (!levels.length) {
    list.innerHTML = '<p class="empty-state small">Pas de niveaux significatifs détectés.</p>';
    return;
  }
  list.innerHTML = '';
  for (const l of [...levels].reverse()) {
    const row = document.createElement('div');
    row.className = 'sr-row';
    const kindLabel = l.kind === 'resistance' ? 'Résistance' : l.kind === 'support' ? 'Support' : 'Niveau rond';
    const kindCls = l.kind === 'resistance' ? 'text-bear' : l.kind === 'support' ? 'text-bull' : 'text-accent';
    const distPct = currentPrice > 0 ? ((l.price - currentPrice) / currentPrice) * 100 : 0;
    row.innerHTML = `
      <span class="${kindCls}">${kindLabel}</span>
      <span class="sr-price">${formatPrice(l.price)}</span>
      <span class="muted small">${formatPct(distPct)}</span>
      <span class="muted small">${l.touches > 0 ? `${l.touches} touche${l.touches > 1 ? 's' : ''}` : '—'}</span>
    `;
    list.appendChild(row);
  }
}

/* ---------------- Dashboard trading ---------------- */
export function renderTradingDashboard(summary, currentPrice) {
  $('td-wallet').textContent = formatUsd(summary.wallet);
  const pnlEl = $('td-pnl');
  pnlEl.textContent = `${formatUsd(summary.pnl)} (${formatPct(summary.pnlPct)})`;
  pnlEl.className = 'wallet-pnl ' + (summary.pnl >= 0 ? 'text-bull' : 'text-bear');
  $('td-accuracy').textContent = summary.total ? `${summary.accuracy.toFixed(0)}% (${summary.wins}/${summary.total})` : '—';
  $('td-trades').textContent = String(summary.total);
  $('td-open').textContent = `${summary.openLongs}L / ${summary.openShorts}S`;
  const exposure = summary.open.reduce((s, p) => s + p.qty * p.entry, 0);
  $('td-exposure').textContent = `${((exposure / summary.wallet) * 100).toFixed(0)}%`;

  // Positions ouvertes avec PnL latent
  const posEl = $('td-positions');
  if (!summary.open.length) {
    posEl.innerHTML = '<p class="empty-state small">Aucune position ouverte.</p>';
  } else {
    posEl.innerHTML = '';
    for (const p of summary.open) {
      const uPnl = currentPrice ? (p.side === 'long' ? (currentPrice - p.entry) * p.qty : (p.entry - currentPrice) * p.qty) : 0;
      const row = document.createElement('div');
      row.className = 'trade-row';
      row.innerHTML = `
        <div class="trade-row-top">
          <span class="trade-side ${p.side === 'long' ? 'side-long' : 'side-short'}">${p.side.toUpperCase()}</span>
          <span class="${uPnl >= 0 ? 'text-bull' : 'text-bear'}">${formatUsd(uPnl)}</span>
        </div>
        <div class="trade-row-bottom muted small">
          Entrée ${formatPrice(p.entry)} · SL ${formatPrice(p.sl)} · TP ${formatPrice(p.tp)} · conf. ${(p.confidence * 100).toFixed(0)}%
        </div>
      `;
      posEl.appendChild(row);
    }
  }

  // Historique
  const histEl = $('td-history');
  if (!summary.closed.length) {
    histEl.innerHTML = '<p class="empty-state small">Aucun trade clos. Lancez un replay avec l\u2019auto-trading activé.</p>';
  } else {
    histEl.innerHTML = '';
    for (const t of [...summary.closed].reverse().slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'trade-row';
      row.innerHTML = `
        <div class="trade-row-top">
          <span class="trade-side ${t.side === 'long' ? 'side-long' : 'side-short'}">${t.side.toUpperCase()}</span>
          <span class="${t.pnl >= 0 ? 'text-bull' : 'text-bear'}">${formatUsd(t.pnl)}</span>
        </div>
        <div class="trade-row-bottom muted small">
          ${formatPrice(t.entry)} → ${formatPrice(t.exit)} · <span class="trade-reason">${esc(t.reason)}</span>
        </div>
      `;
      histEl.appendChild(row);
    }
  }
}

/* ---------------- Compte simulé (header, replay) ----------------
   En replay, la valeur du compte virtuel s'affiche en bleu tout en haut
   à droite (juste à gauche du point de statut). Cliquable → panneau trading. */
/** Affiche/masque la valeur du compte dans le header. */
export function showReplayEquity(show) {
  $('equity-readout').classList.toggle('hidden', !show);
}

/** Met à jour la valeur avec l'équité LIVE (wallet réalisé + PnL latent),
 *  pour voir l'argent évoluer à chaque bougie même position ouverte. */
export function updateReplayEquity(summary, price) {
  const uPnl = summary.open.reduce(
    (s, p) => s + (p.side === 'long' ? (price - p.entry) : (p.entry - price)) * p.qty, 0,
  );
  const equity = summary.wallet + uPnl;
  const pnlPct = ((equity - summary.startWallet) / summary.startWallet) * 100;
  $('equity-val').textContent = formatUsd(equity);
  $('equity-readout').title = `Compte simulé : ${formatUsd(equity)} (${formatPct(pnlPct)}) · ${summary.total} trade${summary.total > 1 ? 's' : ''} · ouvrir le panneau trading`;
}

/* ---------------- Replay UI ---------------- */
export function updateReplayUI(progress, playing, speed) {
  $('replay-counter').textContent = `${progress.current} / ${progress.total}`;
  const seek = $('replay-seek');
  if (!seek.matches(':active')) {
    seek.value = String(Math.round((progress.current / progress.total) * 100));
  }
  $('replay-play-icon').innerHTML = playing
    ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
  $('replay-speed').textContent = `x${speed}`;
}

/* ---------------- Helpers ---------------- */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
