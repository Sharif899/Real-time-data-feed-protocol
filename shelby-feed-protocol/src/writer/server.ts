// src/writer/server.ts
// HTTP ingest server for producers.
//
// POST /ingest              — single event
// POST /ingest/batch        — array of events (up to 1000)
// POST /feeds               — register a new feed
// GET  /feeds/:id/status    — show buffer depth + last seq for a feed

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { db, bootstrapSchema } from "../db.js";
import { redis } from "../redis.js";
import { ChunkWriter } from "./chunk-writer.js";
import { nanoid } from "nanoid";
import "dotenv/config";

const app    = new Hono();
const writer = new ChunkWriter();

// ── Feed registration ────────────────────────────────────────────

app.post("/feeds", async (c) => {
  const body = await c.req.json<{ id?: string; name: string; description?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);

  const id = body.id ?? nanoid(10);

  // Ensure the feed exists in Postgres (upsert)
  await db.query(
    `INSERT INTO feeds (id, name, description) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, body.name, body.description ?? null]
  );

  return c.json({ id, name: body.name }, 201);
});

// ── Single event ingest ───────────────────────────────────────────

const EventSchema = z.object({
  feed_id: z.string().min(1).max(200),
  ts:      z.number().int().optional(),
  payload: z.unknown(),
});

app.post("/ingest", async (c) => {
  const body = await c.req.json();
  const parsed = EventSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 422);

  writer.push({
    feed_id: parsed.data.feed_id,
    ts:      parsed.data.ts ?? Date.now(),
    payload: parsed.data.payload,
  });

  return c.json({ ok: true }, 202);
});

// ── Batch ingest ──────────────────────────────────────────────────

app.post("/ingest/batch", async (c) => {
  const body = await c.req.json<unknown[]>();
  if (!Array.isArray(body) || body.length === 0) {
    return c.json({ error: "body must be a non-empty array" }, 400);
  }
  if (body.length > 1000) {
    return c.json({ error: "batch size limit is 1000" }, 400);
  }

  let accepted = 0;
  for (const item of body) {
    const parsed = EventSchema.safeParse(item);
    if (!parsed.success) continue;
    writer.push({
      feed_id: parsed.data.feed_id,
      ts:      parsed.data.ts ?? Date.now(),
      payload: parsed.data.payload,
    });
    accepted++;
  }

  return c.json({ accepted, total: body.length }, 202);
});

// ── Feed status ───────────────────────────────────────────────────

app.get("/feeds/:id/status", async (c) => {
  const { id } = c.req.param();

  const feed = await db.query("SELECT * FROM feeds WHERE id = $1", [id]);
  if (!feed.rowCount || feed.rowCount === 0) return c.json({ error: "Feed not found" }, 404);

  const latest = await db.query(
    "SELECT seq, event_count, window_end FROM chunks WHERE feed_id = $1 ORDER BY seq DESC LIMIT 1",
    [id]
  );

  return c.json({
    feed: feed.rows[0],
    latest_chunk: latest.rows[0] ?? null,
  });
});

app.get("/health", (c) => c.json({ status: "ok" }));

// ── Boot ──────────────────────────────────────────────────────────

async function main() {
  await bootstrapSchema();
  await redis.connect();

  const port = parseInt(process.env.WRITER_PORT ?? "3100", 10);
  serve({ fetch: app.fetch, port });

  console.log(`✓ Writer service on http://localhost:${port}`);
  console.log(`  Chunk window: ${process.env.CHUNK_WINDOW_SECONDS ?? 5}s`);

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("Flushing remaining chunks…");
    await writer.destroy();
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
