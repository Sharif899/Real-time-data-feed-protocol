// src/types.ts
// Shared types for the feed protocol.

/** One event as produced by any data source. */
export interface FeedEvent {
  /** Feed identifier, e.g. "BTC-USD" or "sensor/factory-a/temp" */
  feed_id: string;
  /** Unix epoch milliseconds */
  ts: number;
  /** Arbitrary payload — must be JSON-serialisable */
  payload: unknown;
}

/** Metadata record written to the index after a chunk is uploaded. */
export interface ChunkRecord {
  id: string;            // nanoid
  feed_id: string;
  seq: number;           // monotonically increasing per feed
  blob_path: string;     // Shelby blob path
  blob_account: string;  // Aptos account that owns the blob
  event_count: number;
  window_start: number;  // ms epoch
  window_end: number;    // ms epoch
  schema_hash: string;   // sha256 of first event's keys
  format: "jsonl";       // extensible: "arrow" | "parquet" in future
  created_at: string;    // ISO
}

/** Redis channel name for a feed */
export function feedChannel(feedId: string): string {
  return `feed:${feedId}:chunks`;
}

/** Canonical Shelby blob name for a chunk */
export function chunkBlobName(feedId: string, windowStart: number, seq: number): string {
  // e.g. feeds/BTC-USD/1735000000000-seq-0042.jsonl
  const safeId = feedId.replace(/[^a-zA-Z0-9_\-./]/g, "_");
  const seqPadded = String(seq).padStart(6, "0");
  return `feeds/${safeId}/${windowStart}-seq-${seqPadded}.jsonl`;
}
