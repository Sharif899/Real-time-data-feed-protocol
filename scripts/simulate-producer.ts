// scripts/simulate-producer.ts
// Fires synthetic events at two feeds:
//   "BTC-USD"         — fake financial tick data
//   "sensor/factory-a" — fake IoT temperature readings
//
// Usage: npx tsx scripts/simulate-producer.ts

import "dotenv/config";

const WRITER_URL = (process.env.WRITER_URL ?? "http://localhost:3100").replace(/\/$/, "");

// ── Register feeds ────────────────────────────────────────────────

async function ensureFeed(id: string, name: string) {
  await fetch(`${WRITER_URL}/feeds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
}

// ── Ingest helpers ────────────────────────────────────────────────

async function ingest(feed_id: string, payload: unknown) {
  await fetch(`${WRITER_URL}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feed_id, ts: Date.now(), payload }),
  });
}

// ── Simulators ────────────────────────────────────────────────────

let lastPrice = 65_000;

function tickBTC() {
  const change   = (Math.random() - 0.5) * 200;
  lastPrice      = parseFloat((lastPrice + change).toFixed(2));
  const volume   = parseFloat((Math.random() * 5).toFixed(4));
  return { symbol: "BTC-USD", price: lastPrice, volume, bid: lastPrice - 1, ask: lastPrice + 1 };
}

function tickSensor() {
  return {
    sensor_id: "factory-a-01",
    temperature: parseFloat((22 + Math.random() * 8).toFixed(2)),
    humidity:    parseFloat((40 + Math.random() * 20).toFixed(1)),
    unit: "celsius",
  };
}

// ── Main loop ─────────────────────────────────────────────────────

async function main() {
  await ensureFeed("BTC-USD",          "Bitcoin / USD real-time ticks");
  await ensureFeed("sensor/factory-a", "Factory A environmental sensors");

  console.log(`Simulating events → ${WRITER_URL}`);
  console.log("Press Ctrl+C to stop.\n");

  let n = 0;
  const interval = setInterval(async () => {
    await ingest("BTC-USD",          tickBTC());
    await ingest("sensor/factory-a", tickSensor());
    n++;
    if (n % 10 === 0) process.stdout.write(`  ${n} events sent\r`);
  }, 500); // 2 events every 500ms = ~4 events/sec

  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log(`\nDone — ${n * 2} events sent.`);
    process.exit(0);
  });
}

main().catch(console.error);
