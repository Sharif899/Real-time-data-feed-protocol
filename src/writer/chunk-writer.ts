// src/writer/chunk-writer.ts
// The heart of the feed protocol.
//
// For each active feed_id the ChunkWriter:
//   1. Collects incoming FeedEvents in an in-memory ring buffer.
//   2. Every CHUNK_WINDOW_SECONDS flushes the buffer:
//        a. Serialises events to JSONL.
//        b. Uploads the buffer as a Shelby blob.
//        c. Inserts a ChunkRecord into Postgres.
//        d. Publishes the ChunkRecord on the Redis channel for that feed.
//   3. Resets the buffer and increments the sequence counter.

import { createHash } from "crypto";
import { nanoid } from "nanoid";
import { shelbyClient, shelbyAccount, BLOB_ACCOUNT } from "../shelby-client.js";
import { db } from "../db.js";
import { redis } from "../redis.js";
import {
  type FeedEvent,
  type ChunkRecord,
  feedChannel,
  chunkBlobName,
} from "../types.js";
import "dotenv/config";

const CHUNK_WINDOW_MS = parseInt(process.env.CHUNK_WINDOW_SECONDS ?? "5", 10) * 1000;
const BLOB_TTL_DAYS   = parseInt(process.env.BLOB_TTL_DAYS ?? "7", 10);

interface FeedBuffer {
  events: FeedEvent[];
  seq: number;
  windowStart: number;
  timer: NodeJS.Timeout | null;
}

export class ChunkWriter {
  private buffers = new Map<string, FeedBuffer>();

  /** Ingest one event. Creates a buffer + flush timer for new feed_ids automatically. */
  push(event: FeedEvent): void {
    let buf = this.buffers.get(event.feed_id);

    if (!buf) {
      buf = { events: [], seq: 0, windowStart: Date.now(), timer: null };
      this.buffers.set(event.feed_id, buf);
      buf.timer = setInterval(() => this.flush(event.feed_id), CHUNK_WINDOW_MS);
    }

    buf.events.push(event);
  }

  /** Flush all pending buffers — call on graceful shutdown. */
  async flushAll(): Promise<void> {
    const ids = [...this.buffers.keys()];
    await Promise.allSettled(ids.map((id) => this.flush(id)));
  }

  // ── private ──────────────────────────────────────────────────────

  private async flush(feedId: string): Promise<void> {
    const buf = this.buffers.get(feedId);
    if (!buf || buf.events.length === 0) return;

    const events = buf.events.splice(0); // drain atomically
    const windowStart = buf.windowStart;
    const windowEnd   = Date.now();
    const seq         = buf.seq++;
    buf.windowStart   = windowEnd;

    // Serialise to JSONL
    const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
    const blobData = Buffer.from(jsonl, "utf8");

    // Blob name encodes feed, window start, and sequence for easy time-range queries
    const blobPath = chunkBlobName(feedId, windowStart, seq);
    const expirationMicros = (Date.now() + BLOB_TTL_DAYS * 86_400_000) * 1000;

    let merkleRoot = "pending";
    try {
      const result = await shelbyClient.upload({
        account: shelbyAccount,
        blobData,
        blobName: blobPath,
        expirationMicros,
      });
      merkleRoot = result.merkleRoot ?? "pending";
    } catch (err) {
      console.error(`[ChunkWriter] Shelby upload failed for ${feedId}:`, err);
      // Re-queue events so they go into the next window
      buf.events.unshift(...events);
      return;
    }

    // Schema fingerprint from first event's top-level keys
    const schemaHash = createHash("sha256")
      .update(JSON.stringify(Object.keys(events[0]?.payload as object ?? {}).sort()))
      .digest("hex")
      .slice(0, 16);

    const record: ChunkRecord = {
      id:           nanoid(12),
      feed_id:      feedId,
      seq,
      blob_path:    blobPath,
      blob_account: BLOB_ACCOUNT,
      event_count:  events.length,
      window_start: windowStart,
      window_end:   windowEnd,
      schema_hash:  schemaHash,
      format:       "jsonl",
      created_at:   new Date().toISOString(),
    };

    // Persist to index
    await db.query(
      `INSERT INTO chunks
         (id, feed_id, seq, blob_path, blob_account, event_count,
          window_start, window_end, schema_hash, format)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (feed_id, seq) DO NOTHING`,
      [
        record.id, record.feed_id, record.seq, record.blob_path,
        record.blob_account, record.event_count, record.window_start,
        record.window_end, record.schema_hash, record.format,
      ]
    );

    // Notify subscribers
    await redis.publish(feedChannel(feedId), JSON.stringify(record));

    console.log(
      `[ChunkWriter] feed=${feedId} seq=${seq} events=${events.length} ` +
      `path=${blobPath} merkle=${merkleRoot.slice(0, 12)}…`
    );
  }

  /** Graceful shutdown — clear all timers, flush remaining events. */
  async destroy(): Promise<void> {
    for (const buf of this.buffers.values()) {
      if (buf.timer) clearInterval(buf.timer);
    }
    await this.flushAll();
  }
}
