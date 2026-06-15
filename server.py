#!/usr/bin/env python3
# ============================================================
#  server.py — Equivalent Python de server.js (Termux-friendly).
#
#  Sert les fichiers statiques + expose le proxy Yahoo Finance :
#      GET /api/yahoo?symbol=<SYM>&interval=<I>&range=<R>
#
#  Pourquoi un proxy ? Le navigateur ne peut PAS appeler Yahoo
#  directement (CORS bloque + User-Agent requis). On appelle donc
#  Yahoo cote serveur, on normalise en bougies OHLCV, on renvoie
#  du JSON propre.
#
#  Zero dependance : uniquement la lib standard Python 3.
#  Lancement : python server.py   (ou PORT=8080 python server.py)
# ============================================================

import json
import os
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "3000"))
ROOT = os.path.dirname(os.path.abspath(__file__))
YAHOO_HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".map": "application/json; charset=utf-8",
}


def fetch_yahoo(symbol, interval, rng):
    """Appelle Yahoo (avec fallback host) et normalise la reponse."""
    enc = urllib.parse.quote(symbol, safe="")
    qs = urllib.parse.urlencode({"interval": interval, "range": rng})
    last_err = None
    for base in YAHOO_HOSTS:
        url = f"{base}/{enc}?{qs}"
        try:
            req = urllib.request.Request(
                url,
                headers={
                    # Sans User-Agent, Yahoo renvoie souvent 403/429.
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=9) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            result = (payload.get("chart") or {}).get("result") or []
            r = result[0] if result else None
            if not r or not r.get("timestamp"):
                raise ValueError("Reponse Yahoo vide")
            return normalize(r)
        except Exception as err:  # noqa: BLE001
            last_err = err
    raise last_err or RuntimeError("Yahoo injoignable")


def normalize(r):
    """Transforme la reponse Yahoo en { meta, candles[] } interne."""
    ts = r["timestamp"]
    q = (((r.get("indicators") or {}).get("quote") or [{}])[0]) or {}
    opens, highs = q.get("open", []), q.get("high", [])
    lows, closes = q.get("low", []), q.get("close", [])
    vols = q.get("volume", [])
    candles = []
    for i in range(len(ts)):
        o = opens[i] if i < len(opens) else None
        h = highs[i] if i < len(highs) else None
        l = lows[i] if i < len(lows) else None
        c = closes[i] if i < len(closes) else None
        # Yahoo insere des trous (null) : on les saute.
        if o is None or h is None or l is None or c is None:
            continue
        candles.append({
            "time": ts[i],
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": (vols[i] if i < len(vols) and vols[i] is not None else 0),
        })
    meta = r.get("meta") or {}
    return {
        "meta": {
            "symbol": meta.get("symbol"),
            "price": meta.get("regularMarketPrice"),
            "prevClose": meta.get("chartPreviousClose", meta.get("previousClose")),
            "currency": meta.get("currency"),
            "time": meta.get("regularMarketTime"),
            "timezone": meta.get("exchangeTimezoneName"),
        },
        "candles": candles,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silence des logs verbeux
        pass

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, url_path):
        if url_path == "/":
            url_path = "/index.html"
        rel = urllib.parse.unquote(url_path).lstrip("/")
        file_path = os.path.normpath(os.path.join(ROOT, rel))
        # Anti path-traversal : on reste sous ROOT.
        if not file_path.startswith(ROOT):
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b"Forbidden")
            return
        if not os.path.isfile(file_path):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"404 Not Found")
            return
        with open(file_path, "rb") as f:
            data = f.read()
        ext = os.path.splitext(file_path)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/yahoo":
            params = urllib.parse.parse_qs(parsed.query)
            symbol = (params.get("symbol") or [None])[0]
            interval = (params.get("interval") or ["15m"])[0]
            rng = (params.get("range") or ["1mo"])[0]
            if not symbol:
                return self._send_json(400, {"error": "symbol requis"})
            try:
                data = fetch_yahoo(symbol, interval, rng)
                data["ts"] = int(time.time() * 1000)
                return self._send_json(200, data)
            except Exception as err:  # noqa: BLE001
                return self._send_json(502, {"error": str(err)})
        self._serve_static(parsed.path)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"TradeVision V3 — http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
