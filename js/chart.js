/* ============================================================
   chart.js — Wrapper lightweight-charts 4.x.
   - Chandelier + histogramme de volume
   - OHLC au survol / toucher
   - Lignes de prix S/R
   - Conversion time/price → pixels pour l'overlay canvas
   - Redimensionnement propre (ResizeObserver)
   ============================================================ */

import { formatPrice } from './utils.js';

const LWC = window.LightweightCharts;

export function createChartManager(containerEl, chartEl, tooltipEl) {
  const chart = LWC.createChart(chartEl, {
    layout: {
      background: { type: 'solid', color: '#0b0e14' },
      textColor: '#8b93a7',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(35, 42, 59, 0.5)' },
      horzLines: { color: 'rgba(35, 42, 59, 0.5)' },
    },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: { color: 'rgba(34, 211, 238, 0.4)', labelBackgroundColor: '#1c2230' },
      horzLine: { color: 'rgba(34, 211, 238, 0.4)', labelBackgroundColor: '#1c2230' },
    },
    rightPriceScale: { borderColor: '#232a3b' },
    timeScale: {
      borderColor: '#232a3b',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
    },
    handleScroll: true,
    handleScale: true,
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#10b981',
    downColor: '#ef4444',
    borderUpColor: '#10b981',
    borderDownColor: '#ef4444',
    wickUpColor: 'rgba(16, 185, 129, 0.7)',
    wickDownColor: 'rgba(239, 68, 68, 0.7)',
  });

  const volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  });
  chart.priceScale('vol').applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 }, // volume confiné en bas, ne masque pas le prix
  });

  // ----- Redimensionnement propre -----
  const ro = new ResizeObserver(() => {
    const r = containerEl.getBoundingClientRect();
    chart.applyOptions({ width: Math.floor(r.width), height: Math.floor(r.height) });
  });
  ro.observe(containerEl);

  // ----- OHLC tooltip au survol -----
  let currentData = [];
  chart.subscribeCrosshairMove((param) => {
    if (!param || !param.time || !param.seriesData) {
      tooltipEl.classList.add('hidden');
      return;
    }
    const d = param.seriesData.get(candleSeries);
    if (!d) { tooltipEl.classList.add('hidden'); return; }
    const up = d.close >= d.open;
    const color = up ? 'var(--bull)' : 'var(--bear)';
    tooltipEl.innerHTML =
      `<span class="o">O</span> ${formatPrice(d.open)} ` +
      `<span class="o">H</span> ${formatPrice(d.high)} ` +
      `<span class="o">L</span> ${formatPrice(d.low)} ` +
      `<span class="o">C</span> <span style="color:${color};font-weight:700">${formatPrice(d.close)}</span>`;
    tooltipEl.classList.remove('hidden');
  });

  // ----- Lignes de prix S/R -----
  let srPriceLines = [];
  function setSRLevels(levels) {
    for (const line of srPriceLines) candleSeries.removePriceLine(line);
    srPriceLines = [];
    for (const lvl of levels) {
      const color = lvl.kind === 'resistance' ? 'rgba(239,68,68,0.55)'
        : lvl.kind === 'support' ? 'rgba(16,185,129,0.55)'
        : 'rgba(34,211,238,0.45)';
      srPriceLines.push(candleSeries.createPriceLine({
        price: lvl.price,
        color,
        lineWidth: 1,
        lineStyle: LWC.LineStyle.Dashed,
        axisLabelVisible: true,
        title: lvl.kind === 'round' ? '◦' : '',
      }));
    }
  }

  // ----- API publique -----
  // NB : la visualisation des trades (zones gain/perte, flèches d'entrée,
  // marqueurs de sortie) est rendue sur le canvas overlay (overlay.js), qui
  // suit nativement les DEUX axes (temps ET prix) — donc reste collée à la
  // courbe même lors d'un changement d'échelle.
  return {
    chart,
    candleSeries,

    /** Réinitialise la vue : réactive l'autoscale du prix et ajuste le temps
     *  pour englober toute la courbe ("view auto" en un clic). */
    resetView() {
      chart.priceScale('right').applyOptions({ autoScale: true });
      chart.timeScale().fitContent();
    },

    /** Remplace toutes les données (chargement initial / replay seek). */
    setData(candles) {
      currentData = candles;
      candleSeries.setData(candles);
      volumeSeries.setData(candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)',
      })));
    },

    /** Met à jour / ajoute la dernière bougie (live ou tick replay). */
    updateCandle(c) {
      candleSeries.update(c);
      volumeSeries.update({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)',
      });
    },

    setSRLevels,

    fitContent() { chart.timeScale().fitContent(); },

    scrollToRealtime() { chart.timeScale().scrollToRealTime(); },

    /**
     * Conversions time/price → pixels pour l'overlay canvas.
     * Retourne null si hors de la zone visible.
     */
    timeToX(time) {
      const x = chart.timeScale().timeToCoordinate(time);
      return x == null ? null : x;
    },
    priceToY(price) {
      const y = candleSeries.priceToCoordinate(price);
      return y == null ? null : y;
    },
    /** Pixel → index logique (pour le dessin libre). */
    xToTime(x) {
      return chart.timeScale().coordinateToTime(x);
    },
    yToPrice(y) {
      return candleSeries.coordinateToPrice(y);
    },

    /** Abonne un callback au scroll/zoom (pour redessiner l'overlay). */
    onVisibleRangeChange(cb) {
      chart.timeScale().subscribeVisibleTimeRangeChange(cb);
      chart.timeScale().subscribeVisibleLogicalRangeChange(cb);
    },

    getData() { return currentData; },

    destroy() {
      ro.disconnect();
      chart.remove();
    },
  };
}
