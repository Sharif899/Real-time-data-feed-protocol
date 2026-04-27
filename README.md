# shelby-feed-protocol

Real-time data feed protocol built on [Shelby Protocol](https://shelby.xyz).

Any stream of events — financial ticks, IoT sensors, social signals, webhooks — is automatically windowed into time-bounded chunks, uploaded as Shelby blobs, indexed, and served to AI subscribers at low latency.

---

## How it works

```
Producer → POST /ingest → [Window Buffer] → shelbyClient.upload()
                                                    │
                                             Shelby blob (JSONL)
                                                    │
                                       Redis pub/sub + Postgres index
                                                    │
Subscriber ←── SSE /subscribe ←─────── ChunkRecord notification
           ←── GET /chunks/:seq/stream ← blob proxy from Shelby RPC
```

**The key idea**: events are buffered for `CHUNK_WINDOW_SECONDS` (default 5s), then serialised to JSONL and uploaded as a single Shelby blob. The blob path encodes the feed ID, window timestamp, and sequence number. Subscribers receive a `ChunkRecord` via SSE the moment a chunk lands, then pull the blob directly through the index server's proxy.

---

## Project structure

```
src/
├── types.ts                    Shared types, blob naming, Redis channel helpers
├── shelby-client.ts            Shelby + Aptos singleton
├── db.ts                       Postgres pool + schema bootstrap
├── redis.ts                    Redis clients (pub + sub)
├── writer/
│   ├── chunk-writer.ts         Core: windowing, upload, notification
│   └── server.ts               HTTP ingest server (producers POST here)
├── index/
│   └── server.ts               HTTP query server (subscribers read here)
└── subscriber-sdk/
    └── index.ts                Typed client for AI pipelines
scripts/
└── simulate-producer.ts        Synthetic producer for local testing
```

---

## Requirements

- Node.js 22+
- PostgreSQL 14+
- Redis 7+
- Shelby CLI + Aptos CLI — [setup guide](https://docs.shelby.xyz/tools/cli)
- A funded Aptos testnet account (APT + ShelbyUSD)

---

## Setup

```bash
git clone https://github.com/YOUR_ORG/shelby-feed-protocol.git
cd shelby-feed-protocol
npm install
cp .env.example .env
# Fill in: APTOS_PRIVATE_KEY, SHELBY_API_KEY, DATABASE_URL, REDIS_URL
```

Start dependencies:
```bash
docker run -d --name pg    -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=shelby_feed -p 5432:5432 postgres:16
docker run -d --name redis -p 6379:6379 redis:7
```

Start both services (in separate terminals):
```bash
npm run dev:writer   # http://localhost:3100
npm run dev:index    # http://localhost:3101
```

Run the producer simulator to send synthetic events:
```bash
npm run simulate
```

---

## API reference

### Writer service (port 3100)

#### Register a feed
```bash
curl -X POST http://localhost:3100/feeds \
  -H "Content-Type: application/json" \
  -d '{"id": "BTC-USD", "name": "Bitcoin ticks"}'
```

#### Ingest a single event
```bash
curl -X POST http://localhost:3100/ingest \
  -H "Content-Type: application/json" \
  -d '{"feed_id": "BTC-USD", "payload": {"price": 65432.10, "volume": 0.5}}'
```

#### Ingest a batch (up to 1000)
```bash
curl -X POST http://localhost:3100/ingest/batch \
  -H "Content-Type: application/json" \
  -d '[{"feed_id":"BTC-USD","payload":{"price":65000}}, ...]'
```

---

### Index service (port 3101)

#### List feeds
```bash
curl http://localhost:3101/feeds
```

#### List chunks (paginated)
```bash
curl "http://localhost:3101/feeds/BTC-USD/chunks?since_seq=10&limit=20"
curl "http://localhost:3101/feeds/BTC-USD/chunks?since_ts=1735000000000"
```

#### Get latest chunk
```bash
curl http://localhost:3101/feeds/BTC-USD/latest
```

#### Stream a chunk's blob
```bash
curl "http://localhost:3101/feeds/BTC-USD/chunks/42/stream"
```

#### Subscribe via SSE (push notification on every new chunk)
```bash
curl -N -H "Accept: text/event-stream" http://localhost:3101/feeds/BTC-USD/subscribe
```

---

## Subscriber SDK

```typescript
import { FeedClient } from "./src/subscriber-sdk/index.js";

const client = new FeedClient({ indexUrl: "http://localhost:3101" });

// --- One-shot reads ---

const latest = await client.latestChunk("BTC-USD");
const events = await client.readChunk("BTC-USD", latest.seq);
// events is FeedEvent[]

// --- Subscribe to new chunks (SSE under the hood) ---
const unsub = client.subscribe("BTC-USD", async (chunk) => {
  const events = await client.readChunk("BTC-USD", chunk.seq);
  await myModel.update(events);
});
// Later: unsub()

// --- Async generator: stream all events, live ---
for await (const event of client.stream("BTC-USD")) {
  await pipeline.process(event);
}

// --- Catch up from a specific sequence number ---
for await (const event of client.stream("BTC-USD", { sinceSeq: 100 })) {
  await pipeline.process(event);
}
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `APTOS_PRIVATE_KEY` | required | Ed25519 private key for blob uploads |
| `APTOS_NETWORK` | `testnet` | `testnet` / `devnet` / `mainnet` |
| `SHELBY_API_KEY` | required | Shelby RPC API key |
| `SHELBY_RPC_URL` | required | Shelby RPC base URL |
| `DATABASE_URL` | required | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `CHUNK_WINDOW_SECONDS` | `5` | Seconds of events per blob |
| `BLOB_TTL_DAYS` | `7` | How long blobs live on Shelby |
| `WRITER_PORT` | `3100` | Ingest server port |
| `INDEX_PORT` | `3101` | Query/subscribe server port |

---

## Tuning

- **Lower latency**: reduce `CHUNK_WINDOW_SECONDS` to 1–2s. Blobs will be smaller but more frequent.
- **Higher throughput**: increase `CHUNK_WINDOW_SECONDS` to 30–60s. Fewer uploads, larger blobs, better for training jobs.
- **Schema evolution**: the `schema_hash` field in `ChunkRecord` is derived from the first event's top-level keys. Subscribers can detect schema changes by watching for a different hash in the SSE stream.

---

## License

MIT
