/* ============================================================
 * replay.js — Contrôleur de replay honnête
 *
 * INVARIANTS (replay_contract) :
 *  - INV-1 : à l'instant t, TOUTE logique de décision reçoit le
 *            slice tronqué this.data.slice(0, t+1). Les fonctions
 *            de décision ne reçoivent JAMAIS (dataset, index).
 *  - INV-2 : le dataset complet (this.data) n'est lu que par CE
 *            contrôleur (avancement) et la barre de progression UI
 *            (via progress()). Aucun autre module n'y a accès.
 *  - INV-3 : les projections graphiques futures sont du dessin pur,
 *            gérées par overlay/chart — jamais relues ici.
 * ============================================================ */

const SPEEDS = [0.5, 1, 2, 4, 8];
const MIN_WARMUP = 60; // bougies minimum avant la 1re décision (indicateurs fiables)

export class ReplayController {
  /**
   * @param {Array} fullData  dataset complet (propriété privée du contrôleur)
   * @param {Function} onTick (slice) => void — reçoit UNIQUEMENT le slice tronqué
   * @param {Function} onEnd  (lastBar) => void
   */
  constructor(fullData, onTick, onEnd) {
    this.data = fullData; // INV-2 : seul ce contrôleur lit le dataset complet
    this.onTick = onTick;
    this.onEnd = onEnd;
    this.cursor = Math.min(MIN_WARMUP, Math.max(0, fullData.length - 1));
    this.playing = false;
    this.speedIdx = 1;
    this._timer = null;
  }

  get speed() {
    return SPEEDS[this.speedIdx];
  }

  cycleSpeed() {
    this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
    if (this.playing) {
      this._stopTimer();
      this._startTimer();
    }
    return this.speed;
  }

  /* Barre de progression UI — INV-2 : seule lecture autorisée du total */
  progress() {
    return { current: this.cursor + 1, total: this.data.length };
  }

  currentBar() {
    return this.data[this.cursor];
  }

  /* Émet le slice tronqué [0..cursor] — INV-1 */
  _emit() {
    this.onTick(this.data.slice(0, this.cursor + 1));
  }

  start() {
    this._emit();
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._startTimer();
  }

  pause() {
    this.playing = false;
    this._stopTimer();
  }

  step() {
    this.pause();
    this._advance();
  }

  /** Seek : repositionne le curseur. Le moteur de trading doit être
   *  réinitialisé par l'appelant (sinon trades incohérents). */
  seek(ratio) {
    this.pause();
    const idx = Math.round(ratio * (this.data.length - 1));
    this.cursor = Math.max(MIN_WARMUP, Math.min(idx, this.data.length - 1));
    this._emit();
  }

  _startTimer() {
    const interval = Math.max(40, 600 / this.speed);
    this._timer = setInterval(() => this._advance(), interval);
  }

  _stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _advance() {
    if (this.cursor >= this.data.length - 1) {
      this.pause();
      // Fin de replay : fermeture forcée des trades (raison "End")
      this.onEnd(this.data[this.data.length - 1]);
      return;
    }
    this.cursor++;
    this._emit();
  }

  destroy() {
    this._stopTimer();
    this.data = null;
  }
}
