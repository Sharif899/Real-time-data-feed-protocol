// src/index/server.ts
// HTTP query server for subscribers.
//
// GET  /feeds                         — list all registered feeds
// GET  /feeds/:id/chunks              — paginated chunk list (with ?since_seq=N&limit=N)
// GET  /feeds/:id/chunks/:seq/stream  — proxy the chunk blob from Shelby RPC
// GET  /feeds/:id/latest              — shortcut for the latest chunk record
// GET  /feeds/:id/subscribe           — SSE stream: pushes ChunkRecord JSON as new chunks land

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db, bootstrapSchema } from "../db.js";
import { redis, redisSub } from "../redis.js";
import { SHELBY_RPC_URL } from "../shelby-client.js";
import { feedChannel, type ChunkRecord } from "../types.js";
import "dotenv/config";

const app = new Hono();

// ── Feed list ─────────────────────────────────────────────────────

app.get("/feeds", async (c) => {
  const rows = await db.query("SELECT * FROM feeds ORDER BY created_at DESC");
  return c.json({ feeds: rows.rows });
});

// ── Chunk list (paginated, time-range aware) ──────────────────────

app.get("/feeds/:id/chunks", async (c) => {
  const { id } = c.req.param();
  const sinceSeq = parseInt(c.req.query("since_seq") ?? "-1", 10);
  const limit    = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const since_ts = c.req.query("since_ts"); // ms epoch — filter by window_start

  let query = `
    SELECT * FROM chunks
    WHERE feed_id = $1 AND seq > $2
  `;
  const params: unknown[] = [id, sinceSeq];

  if (since_ts) {
    params.push(parseInt(since_ts, 10));
    query += ` AND window_start >= $${params.length}`;
  }

  params.push(limit);
  query += ` ORDER BY seq ASC LIMIT $${params.length}`;

  const rows = await db.query(query, params);
  return c.json({ chunks: rows.rows });
});

// ── Latest chunk ──────────────────────────────────────────────────

app.get("/feeds/:id/latest", async (c) => {
  const { id } = c.req.param();
  const row = await db.query(
    "SELECT * FROM chunks WHERE feed_id = $1 ORDER BY seq DESC LIMIT 1",
    [id]
  );
  if (!row.rowCount || row.rowCount === 0) return c.json({ error: "No chunks yet" }, 404);
  return c.json(row.rows[0]);
});

// ── Blob proxy — stream a chunk from Shelby RPC ──────────────────

app.get("/feeds/:id/chunks/:seq/stream", async (c) => {
  const { id, seq } = c.req.param();

  const row = await db.query(
    "SELECT blob_path, blob_account FROM chunks WHERE feed_id = $1 AND seq = $2",
    [id, parseInt(seq, 10)]
  );
  if (!row.rowCount || row.rowCount === 0) return c.json({ error: "Chunk not found" }, 404);

  const { blob_path, blob_account } = row.rows[0] as { blob_path: string; blob_account: string };
  const upstream = await fetch(`${SHELBY_RPC_URL}/shelby/v1/blobs/${blob_account}/${blob_path}`);

  if (!upstream.ok) {
    return c.json({ error: `Shelby RPC error ${upstream.status}` }, upstream.status as 500);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "X-Feed-Id":    id,
      "X-Chunk-Seq":  seq,
    },
  });
});

// ── SSE subscription — push new ChunkRecords as they land ────────
// Each event is a JSON-stringified ChunkRecord on the "chunk" SSE event.

app.get("/feeds/:id/subscribe", (c) => {
  const { id } = c.req.param();
  const channel = feedChannel(id);

  return streamSSE(c, async (stream) => {
    // Subscriber gets its own dedicated Redis sub connection via a local handler
    const handler = async (_channel: string, message: string) => {
      await stream.writeSSE({ event: "chunk", data: message });
    };

    await redisSub.subscribe(channel);
    redisSub.on("message", handler);

    // Keep alive every 15s
    const hb = setInterval(async () => {
      await stream.writeSSE({ event: "heartbeat", data: String(Date.now()) });
    }, 15_000);

    // Clean up when the client disconnects
    stream.onAbort(() => {
      clearInterval(hb);
      redisSub.off("message", handler);
      redisSub.unsubscribe(channel).catch(() => {});
    });

    // Block until the client closes
    await new Promise<void>((resolve) => stream.onAbort(resolve));
  });
});

app.get("/health", (c) => c.json({ status: "ok" }));

// ── Boot ──────────────────────────────────────────────────────────

async function main() {
  await bootstrapSchema();
  await redis.connect();
  await redisSub.connect();

  const port = parseInt(process.env.INDEX_PORT ?? "3101", 10);
  serve({ fetch: app.fetch, port });
  console.log(`✓ Index service on http://localhost:${port}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
