/* ============================================================
   app.js — Orchestrateur.

   Responsabilités :
   - cycle de vie données (REST + WS + démo)
   - tick d'analyse (scanner → consensus → UI/overlay)
   - mode replay : SEUL endroit où le contrôleur détient le
     dataset complet ; tout le reste reçoit le slice tronqué
   - auto-trading (replay uniquement)
   - événements UI

   ANTI-LOOKAHEAD : voir runAnalysis(slice) — unique point
   d'entrée de la logique de décision, qui ne reçoit JAMAIS
   autre chose que les bougies autorisées.
   ============================================================ */

import { SYMBOLS, TIMEFRAMES, findSymbol, fetchKlines, openKlineStream, openYahooStream } from './data.js';
import { createChartManager } from './chart.js';
import { computeSRLevels, nearestSRAlert, computeATR, computeTrend, computeConfluence } from './indicators.js';
import { createScanner } from './scanner.js';
import { createOverlay } from './overlay.js';
import { recognizeShape, createDrawController } from './drawing.js';
import { ReplayController } from './replay.js';
import { TradingEngine } from './trading.js';
import * as UI from './ui.js';
import { clamp, debounce } from './utils.js';

const $ = (id) => document.getElementById(id);

/* ---------------- État global ---------------- */
const state = {
  symbolId: 'BTCUSDT',
  tfId: '1h',
  candles: [],          // données live (mode normal)
  stream: null,
  chartMgr: null,
  overlay: null,
  scanner: createScanner(),
  trading: new TradingEngine(),
  autoTrade: false,
  replay: null,         // ReplayController (null hors replay)
  selectedPatternKey: null,
  lastPatterns: [],
  lastLevels: [],
  drawCtl: null,
  drawMode: false,
};

/* ============================================================
   ANALYSE — unique point d'entrée de la logique de décision.
   @param {Array} slice — bougies autorisées :
     - mode live : tout l'historique connu (le présent)
     - mode replay : slice tronqué [0..t] fourni par le contrôleur
   Tout ce qui décide (S/R, scan, consensus, trading) part d'ici
   et ne voit QUE ce slice. (INV-1)
   ============================================================ */
function runAnalysis(slice, { isReplayTick = false } = {}) {
  if (slice.length < 20) return;

  // S/R sur le slice
  const levels = computeSRLevels(slice);
  state.lastLevels = levels;
  state.chartMgr.setSRLevels(levels);

  // Alerte proximité
  UI.showSRAlert(nearestSRAlert(slice, levels));

  // Scan multi-fenêtres + consensus
  const { patterns, consensus, stableHash, structuralHash, changed } = state.scanner.scan(slice);
  state.lastPatterns = patterns;

  // UI (re-render seulement si l'ensemble stable a changé, ou 1er rendu)
  if (changed || !state._renderedOnce) {
    state._renderedOnce = true;
    UI.renderPatternsList(patterns, onSelectPattern, state.selectedPatternKey);
    // Si le pattern sélectionné a disparu, on nettoie l'overlay
    if (state.selectedPatternKey && !patterns.find((p) => p.key === state.selectedPatternKey)) {
      state.selectedPatternKey = null;
      state.overlay.selectPattern(null);
    } else if (state.selectedPatternKey) {
      const sel = patterns.find((p) => p.key === state.selectedPatternKey);
      if (sel) state.overlay.selectPattern(sel);
    }
  }
  UI.renderConsensusPanel(consensus);
  UI.updateConsensusBadge(consensus, !!state.replay);
  UI.renderSRList(levels, slice[slice.length - 1].close);

  // Auto-trading : UNIQUEMENT en replay (backtest honnête)
  if (isReplayTick && state.autoTrade) {
    const trend = computeTrend(slice, 30);
    const atr = computeATR(slice, 14);
    // Confluence de suivi de tendance (EMA + momentum + breakout) — filtre
    // directionnel principal, issu du backtesting multi-actifs. INV-1 : slice.
    const confluence = computeConfluence(slice);
    // Extension du prix par rapport à l'EMA lente, en unités d'ATR (anti-chasing).
    // Mesure « à quel point le mouvement est déjà fait » : sert au filtre
    // d'over-extension du moteur (on n'entre pas après un mouvement étendu).
    const lastClose0 = slice[slice.length - 1].close;
    const extAtr = (confluence.emaSlowVal != null && atr > 0)
      ? Math.abs(lastClose0 - confluence.emaSlowVal) / atr
      : null;
    state.trading.onBar(slice, {
      consensus,
      atr,
      extAtr,
      levels,
      // Classe d'actif (crypto / forex / stocks) → profil de géométrie/régime
      category: findSymbol(state.symbolId)?.category || 'crypto',
      // Confluence directionnelle (dir, votes 0..3)
      confluence,
      // Qualité de tendance (r2, slopePct, direction) → filtre de régime :
      // on n'entre en suivi de tendance que si le marché TREND vraiment.
      trend,
      // Anti-spam : hash STRUCTUREL (patterns chartistes seulement) —
      // les bougies horodatées muteraient le hash à chaque barre.
      stableHash: structuralHash,
      // Pente courte normalisée dans [-1, 1] pour le filtre de tendance.
      // TUNING: diviseur 0.15 → 0.35, et pondération par r2.
      // Avec 0.15, une pente de 0.09%/bougie saturait déjà la norme à
      // ±0.6 : le filtre de tendance bloquait TOUT signal de retournement
      // (mesuré en replay : 5/5 rejets à -1.00/-0.98/-0.86). Avec 0.35,
      // ±0.6 correspond à ~0.21%/bougie — une vraie tendance violente.
      // La pondération par r2 évite de bloquer sur du bruit sans
      // structure linéaire (r2 faible = pas de tendance fiable).
      trendSlope: clamp(trend.slopePct / 0.35, -1, 1) * Math.min(1, trend.r2 / 0.4),
    });
    const summary = state.trading.summary();
    const lastClose = slice[slice.length - 1].close;
    UI.renderTradingDashboard(summary, lastClose);
    // Visualisation directe sur la courbe (zones gain/perte + flèches) et
    // valeur du compte virtuel évoluant en direct dans le header.
    state.overlay.setTrades(summary);
    UI.updateReplayEquity(summary, lastClose);
  }
}

function onSelectPattern(p) {
  state.selectedPatternKey = p.key;
  state.overlay.selectPattern(p);
  UI.renderPatternsList(state.lastPatterns, onSelectPattern, p.key);
  UI.closeAllSheets();
  UI.toast(`${p.name} affiché sur le graphique`, 'info', 2200);
}

/* ============================================================
   CHARGEMENT DONNÉES (mode live)
   ============================================================ */
async function loadMarket() {
  closeStream();
  state.scanner.reset();
  state.selectedPatternKey = null;
  state.overlay?.clearAll();
  showEmpty('Chargement des données…', false);

  $('symbol-name').textContent = findSymbol(state.symbolId)?.label ?? state.symbolId;

  try {
    const { candles, provider, delayed } = await fetchKlines(state.symbolId, state.tfId, 500);
    state.candles = candles;
    hideEmpty();
    state.chartMgr.setData(candles);
    state.chartMgr.fitContent();

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    UI.updatePriceHeader(last.close, prev?.close);
    UI.setConnStatus('connected');
    if (delayed) UI.toast('Cotations Yahoo en temps réel différé (~1–15 min)', 'info', 2600);

    runAnalysis(candles);
    openStream(provider);
  } catch (err) {
    console.error('loadMarket failed:', err);
    showEmpty('Impossible de charger les données pour ce symbole.', true);
    UI.setConnStatus('reconnecting');
  }
}

function openStream(provider) {
  const sym = findSymbol(state.symbolId);
  const onCandle = ({ candle, isClosed }) => {
    if (state.replay) return; // en replay, le live est suspendu
    const last = state.candles[state.candles.length - 1];
    if (!last) return;
    if (candle.time === last.time) {
      state.candles[state.candles.length - 1] = candle;
    } else if (candle.time > last.time) {
      state.candles.push(candle);
    } else {
      return; // bougie obsolète ignorée
    }
    state.chartMgr.updateCandle(candle);
    UI.updatePriceHeader(candle.close, state.candles[state.candles.length - 2]?.close);
    // L'analyse ne tourne que sur bougie CLÔTURÉE (cohérent avec la
    // règle de confirmation en clôture du moteur de patterns)
    if (isClosed) runAnalysis(state.candles);
  };

  // Crypto via Binance → WebSocket ; Yahoo (forex/actions/secours) → polling.
  if (provider === 'binance') {
    state.stream = openKlineStream(state.symbolId, state.tfId, onCandle, UI.setConnStatus);
  } else {
    state.stream = openYahooStream(sym.yahoo, state.tfId, onCandle, UI.setConnStatus);
  }
}

function closeStream() {
  state.stream?.close();
  state.stream = null;
}

function showEmpty(msg, withRetry) {
  $('chart-empty-msg').textContent = msg;
  $('chart-empty').classList.remove('hidden');
  $('btn-retry').classList.toggle('hidden', !withRetry);
}
function hideEmpty() {
  $('chart-empty').classList.add('hidden');
}

/* ============================================================
   REPLAY
   ============================================================ */
function startReplay(startRatio) {
  if (state.candles.length < 100) {
    UI.toast('Pas assez de données pour un replay.', 'warn');
    return;
  }
  closeStream();
  state.scanner.reset();
  state.trading.reset();
  state.selectedPatternKey = null;
  state.overlay.clearAll();
  state.overlay.clearTrades();
  // Valeur du compte simulé affichée dans le header (bleu) pendant le replay
  UI.showReplayEquity(state.autoTrade);

  // INV-2 : le dataset complet n'est passé QU'AU contrôleur.
  const full = state.candles.slice();
  state.replay = new ReplayController(
    full,
    // onTick : reçoit le slice tronqué — INV-1
    (slice) => {
      state.chartMgr.setData(slice);
      const last = slice[slice.length - 1];
      UI.updatePriceHeader(last.close, slice[slice.length - 2]?.close);
      runAnalysis(slice, { isReplayTick: true });
      UI.updateReplayUI(state.replay.progress(), state.replay.playing, state.replay.speed);
    },
    // onEnd : fermeture forcée des trades, raison "End"
    (lastBar) => {
      if (state.autoTrade) {
        state.trading.closeAll(lastBar);
        const summary = state.trading.summary();
        UI.renderTradingDashboard(summary, lastBar.close);
        state.overlay.setTrades(summary);
        UI.updateReplayEquity(summary, lastBar.close);
        const s = summary;
        UI.toast(`Replay terminé — PnL ${s.pnl >= 0 ? '+' : ''}${s.pnlPct.toFixed(1)}% · précision ${s.accuracy.toFixed(0)}%`, s.pnl >= 0 ? 'success' : 'warn', 5000);
      } else {
        UI.toast('Replay terminé.', 'info');
      }
      UI.updateReplayUI(state.replay.progress(), false, state.replay.speed);
    }
  );

  // Position de départ choisie par l'utilisateur
  state.replay.seek(startRatio);
  $('replay-bar').classList.remove('hidden');
  UI.setConnStatus('offline'); // live suspendu pendant le replay
  UI.toast(state.autoTrade ? 'Replay démarré — auto-trading actif' : 'Replay démarré', 'info');
}

function exitReplay() {
  if (!state.replay) return;
  state.replay.destroy();
  state.replay = null;
  $('replay-bar').classList.add('hidden');
  state.scanner.reset();
  state.overlay.clearAll();
  state.overlay.clearTrades();
  UI.showReplayEquity(false);
  state.selectedPatternKey = null;
  // Retour au live : recharge tout proprement
  loadMarket();
}

/* ============================================================
   DESSIN LIBRE
   ============================================================ */
function enterDrawMode() {
  state.drawMode = true;
  $('draw-canvas').classList.remove('hidden');
  // Le canvas était masqué (0x0) au chargement : la garde anti-corruption
  // de resize() avait sauté l'init — on dimensionne maintenant qu'il est visible.
  state.drawCtl?.resize();
  UI.closeAllSheets();
  UI.toast('Dessinez une forme sur le graphique', 'info', 2500);
}
function exitDrawMode() {
  state.drawMode = false;
  $('draw-canvas').classList.add('hidden');
}

function onDrawComplete(points) {
  const result = recognizeShape(points);
  exitDrawMode();
  const resEl = $('draw-result');
  if (!result) {
    resEl.innerHTML = '<p class="muted">Forme non reconnue. Essayez un tracé plus net (M, W, triangle…).</p>';
    resEl.classList.remove('hidden');
    UI.openSheet('sheet-draw');
    UI.toast('Forme non reconnue', 'warn');
    return;
  }
  // Conversion pixels → time/price via le chart (projection VISUELLE
  // uniquement — INV-3 : aucune logique de décision ne lit ceci)
  const proj = [];
  for (const p of points.filter((_, i) => i % 4 === 0)) {
    const time = state.chartMgr.xToTime(p.x);
    const price = state.chartMgr.yToPrice(p.y);
    if (time != null && price != null) proj.push({ time, price });
  }
  if (proj.length >= 2) {
    state.overlay.setProjection({ points: proj, label: result.name });
  }
  const dirLabel = result.direction === 'bullish' ? 'haussier' : result.direction === 'bearish' ? 'baissier' : 'neutre';
  resEl.innerHTML = `<div class="draw-result-card"><strong>${result.name}</strong><span class="${result.direction === 'bullish' ? 'text-bull' : result.direction === 'bearish' ? 'text-bear' : 'muted'}">Biais ${dirLabel} · similarité ${(result.confidence * 100).toFixed(0)}%</span></div>`;
  resEl.classList.remove('hidden');
  UI.toast(`${result.name} reconnu`, 'success');
}

/* ============================================================
   ÉVÉNEMENTS UI
   ============================================================ */
function wireUI() {
  UI.wireCloseButtons();

  // --- Timeframes ---
  const tfList = $('tf-list');
  for (const tf of TIMEFRAMES) {
    const b = document.createElement('button');
    b.className = 'tf-btn' + (tf.id === state.tfId ? ' tf-active' : '');
    b.textContent = tf.label;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      if (state.replay) { UI.toast('Quittez le replay pour changer de timeframe', 'warn'); return; }
      state.tfId = tf.id;
      for (const el of tfList.children) el.classList.remove('tf-active');
      b.classList.add('tf-active');
      loadMarket();
    });
    tfList.appendChild(b);
  }

  // --- Sélecteur de symboles ---
  $('btn-symbol').addEventListener('click', () => {
    renderSymbolList('crypto');
    UI.openSheet('sheet-symbols');
  });
  $('symbol-categories').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-cat]');
    if (!btn) return;
    for (const el of $('symbol-categories').children) el.classList.remove('seg-active');
    btn.classList.add('seg-active');
    renderSymbolList(btn.dataset.cat);
  });

  function renderSymbolList(cat) {
    const list = $('symbol-list');
    list.innerHTML = '';
    for (const s of SYMBOLS[cat]) {
      const b = document.createElement('button');
      b.className = 'symbol-item' + (s.id === state.symbolId ? ' symbol-item-active' : '');
      b.setAttribute('role', 'option');
      b.innerHTML = `<span class="symbol-item-label">${s.label}</span><span class="muted small">${s.desc}</span>`;
      b.addEventListener('click', () => {
        if (state.replay) exitReplay();
        state.symbolId = s.id;
        UI.closeAllSheets();
        loadMarket();
      });
      list.appendChild(b);
    }
  }

  // --- Bottom nav ---
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nav = btn.dataset.nav;
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('nav-active'));
      btn.classList.add('nav-active');
      UI.closeAllSheets();
      exitDrawMode();
      if (nav === 'patterns') UI.openSheet('sheet-patterns');
      else if (nav === 'draw') UI.openSheet('sheet-draw');
      else if (nav === 'replay') {
        if (state.replay) UI.toast('Replay déjà en cours', 'info');
        else UI.openSheet('modal-replay');
      } else if (nav === 'trading') {
        UI.renderTradingDashboard(state.trading.summary(), currentPrice());
        UI.openSheet('panel-trading');
      }
    });
  });

  // --- Dessin ---
  $('btn-draw-start').addEventListener('click', enterDrawMode);
  $('btn-draw-clear').addEventListener('click', () => {
    state.overlay.setProjection(null);
    state.drawCtl?.clear();
    $('draw-result').classList.add('hidden');
  });

  // --- Replay config ---
  const startPct = $('replay-start-pct');
  startPct.addEventListener('input', () => {
    $('replay-start-label').textContent = `${startPct.value}%`;
  });
  $('btn-replay-start').addEventListener('click', () => {
    UI.closeAllSheets();
    startReplay(parseInt(startPct.value, 10) / 100);
  });

  // --- Contrôles replay ---
  $('replay-play').addEventListener('click', () => {
    if (!state.replay) return;
    if (state.replay.playing) state.replay.pause();
    else state.replay.play();
    UI.updateReplayUI(state.replay.progress(), state.replay.playing, state.replay.speed);
  });
  $('replay-step').addEventListener('click', () => state.replay?.step());
  $('replay-step-back').addEventListener('click', () => {
    // Step back = seek arrière → reset trading/scanner (cohérence)
    if (!state.replay) return;
    const prog = state.replay.progress();
    const ratio = Math.max(0, (prog.current - 2) / prog.total);
    state.scanner.reset();
    state.trading.reset();
    state.replay.seek(ratio);
  });
  $('replay-speed').addEventListener('click', () => {
    if (!state.replay) return;
    const sp = state.replay.cycleSpeed();
    UI.updateReplayUI(state.replay.progress(), state.replay.playing, sp);
  });
  $('replay-seek').addEventListener('change', (ev) => {
    if (!state.replay) return;
    // Seek manuel : reset du trading + scanner (sinon état incohérent)
    state.scanner.reset();
    state.trading.reset();
    state.replay.seek(parseInt(ev.target.value, 10) / 100);
    UI.toast('Position modifiée — trading réinitialisé', 'info', 2000);
  });
  $('replay-exit').addEventListener('click', exitReplay);

  // --- Toggle auto-trading ---
  $('td-toggle').addEventListener('click', () => {
    state.autoTrade = !state.autoTrade;
    const t = $('td-toggle');
    t.classList.toggle('toggle-on', state.autoTrade);
    t.setAttribute('aria-checked', String(state.autoTrade));
    // En replay, refléter immédiatement l'état : valeur du compte dans le
    // header + visuels de trades apparaissent/disparaissent en conséquence.
    if (state.replay) {
      UI.showReplayEquity(state.autoTrade);
      if (!state.autoTrade) state.overlay.clearTrades();
    }
    UI.toast(state.autoTrade ? 'Auto-trading activé (effectif en replay)' : 'Auto-trading désactivé', 'info');
  });

  // --- Réinitialiser la vue (fit auto en un clic) ---
  $('btn-reset-view').addEventListener('click', () => {
    state.chartMgr?.resetView();
    state.overlay?.render();
  });

  // --- Clic sur la valeur du compte (header) → panneau trading ---
  $('equity-readout').addEventListener('click', () => {
    UI.renderTradingDashboard(state.trading.summary(), currentPrice());
    UI.openSheet('panel-trading');
  });

  // --- Retry réseau ---
  $('btn-retry').addEventListener('click', loadMarket);
}

function currentPrice() {
  if (state.replay) return state.replay.currentBar()?.close ?? 0;
  return state.candles[state.candles.length - 1]?.close ?? 0;
}

/* ============================================================
   BOOT
   ============================================================ */
function boot() {
  if (!window.LightweightCharts) {
    showEmpty('Librairie de graphique introuvable (CDN bloqué ?).', true);
    return;
  }
  state.chartMgr = createChartManager($('chart-container'), $('chart'), $('ohlc-tooltip'));
  state.overlay = createOverlay($('pattern-overlay'), state.chartMgr);
  state.drawCtl = createDrawController($('draw-canvas'), onDrawComplete);

  wireUI();
  UI.initDraggableSheets();
  loadMarket();

  // Redessin overlay sur resize global (debounced)
  window.addEventListener('resize', debounce(() => state.overlay.render(), 150));
}

boot();
