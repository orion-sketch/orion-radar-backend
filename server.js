const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use("/assets", express.static(path.join(__dirname, "assets")));

const SIGNALS_FILE = path.join(__dirname, "signals.live.json");

const MOCK_SIGNALS = [
  {
    id: "sig_001",
    symbol: "XAUUSD",
    tf: "H1",
    side: "SELL",
    score: 88,
    setup: "OB + FVG + Trend Alignment",
    status: "Continuation",
    entry: "2045.80",
    sl: "2051.20",
    tp: "2036.40",
    ts: "2026-03-20T12:05:00Z",
    filters: ["OB", "FVG"]
  },
  {
    id: "sig_002",
    symbol: "EURUSD",
    tf: "M15",
    side: "BUY",
    score: 84,
    setup: "BOS + Retest",
    status: "Confirmed",
    entry: "1.08420",
    sl: "1.08280",
    tp: "1.08750",
    ts: "2026-03-20T12:10:00Z",
    filters: ["BOS"]
  }
];

function normalizeSignal(row, idx = 0) {
  return {
    id: row.id || `sig_${idx + 1}`,
    symbol: String(row.symbol || "").toUpperCase(),
    tf: String(row.tf || "M15").toUpperCase(),
    side: String(row.side || "BUY").toUpperCase(),
    score: Number(row.score || 80),
    setup: row.setup || "Signal",
    status: row.status || "Live",
    entry: String(row.entry || "-"),
    sl: String(row.sl || "-"),
    tp: String(row.tp || "-"),
    ts: row.ts || new Date().toISOString(),
    filters: Array.isArray(row.filters) ? row.filters : []
  };
}

function loadSignals() {
  try {
    if (fs.existsSync(SIGNALS_FILE)) {
      const raw = fs.readFileSync(SIGNALS_FILE, "utf8");
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.signals) ? parsed.signals : [];
      return rows.map(normalizeSignal);
    }
  } catch (err) {
    console.error("Erro lendo signals.live.json:", err.message);
  }
  return MOCK_SIGNALS.map(normalizeSignal);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "orion-radar-pro",
    now: new Date().toISOString()
  });
});

app.get("/api/signals", (_req, res) => {
  const signals = loadSignals();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    count: signals.length,
    signals
  });
});

app.get(["/", "/dashboard", "/reset-password"], (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log("ORION RADAR PRO rodando em http://localhost:" + PORT);
});