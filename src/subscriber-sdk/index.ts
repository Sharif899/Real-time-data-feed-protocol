// src/subscriber-sdk/index.ts
// Typed client for AI pipelines to subscribe to and consume feeds.

import type { ChunkRecord } from "../types.js";
export type { ChunkRecord, FeedEvent } from "../types.js";

export interface FeedClientOptions {
  /** Base URL of the running shelby-feed-protocol index service */
  indexUrl: string;
}

export class FeedClient {
  private base: string;

  constructor(options: FeedClientOptions) {
    this.base = options.indexUrl.replace(/\/$/, "");
  }

  // ── Discovery ────────────────────────────────────────────────────

  async listFeeds(): Promise<{ id: string; name: string; description?: string }[]> {
    const res = await fetch(`${this.base}/feeds`);
    const body = (await res.json()) as { feeds: { id: string; name: string }[] };
    return body.feeds;
  }

  async listChunks(
    feedId: string,
    options?: { sinceSeq?: number; sinceTs?: number; limit?: number }
  ): Promise<ChunkRecord[]> {
    const params = new URLSearchParams();
    if (options?.sinceSeq !== undefined) params.set("since_seq", String(options.sinceSeq));
    if (options?.sinceTs  !== undefined) params.set("since_ts",  String(options.sinceTs));
    if (options?.limit    !== undefined) params.set("limit",      String(options.limit));

    const res  = await fetch(`${this.base}/feeds/${feedId}/chunks?${params}`);
    const body = (await res.json()) as { chunks: ChunkRecord[] };
    return body.chunks;
  }

  async latestChunk(feedId: string): Promise<ChunkRecord | null> {
    const res = await fetch(`${this.base}/feeds/${feedId}/latest`);
    if (res.status === 404) return null;
    return res.json() as Promise<ChunkRecord>;
  }

  // ── One-shot reads ────────────────────────────────────────────────

  /**
   * Stream the raw JSONL bytes of a single chunk.
   */
  async streamChunk(feedId: string, seq: number): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${this.base}/feeds/${feedId}/chunks/${seq}/stream`);
    if (!res.ok) throw new Error(`Chunk stream error: ${res.status}`);
    if (!res.body) throw new Error("Empty response");
    return res.body;
  }

  /**
   * Parse a single chunk's JSONL into an array of typed objects.
   */
  async readChunk<T = unknown>(feedId: string, seq: number): Promise<T[]> {
    const stream  = await this.streamChunk(feedId, seq);
    const reader  = stream.getReader();
    const decoder = new TextDecoder();
    let buffer    = "";
    const results: T[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) results.push(JSON.parse(line) as T);
      }
    }
    if (buffer.trim()) results.push(JSON.parse(buffer.trim()) as T);
    return results;
  }

  // ── Real-time subscription ────────────────────────────────────────

  /**
   * Subscribe to new chunks via SSE. The callback receives a ChunkRecord
   * every time a new chunk lands. Returns a cleanup function.
   *
   * @example
   * const unsub = await client.subscribe("BTC-USD", async (chunk) => {
   *   const events = await client.readChunk("BTC-USD", chunk.seq);
   *   await pipeline.process(events);
   * });
   *
   * // Later:
   * unsub();
   */
  subscribe(
    feedId: string,
    onChunk: (chunk: ChunkRecord) => void | Promise<void>,
    onError?: (err: Error) => void
  ): () => void {
    const url = `${this.base}/feeds/${feedId}/subscribe`;
    const controller = new AbortController();

    const connect = async () => {
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`);
        }

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer    = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json) continue;
            try {
              const record = JSON.parse(json) as ChunkRecord;
              await onChunk(record);
            } catch {
              // skip malformed SSE frames
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
        // Auto-reconnect after 2s
        if (!controller.signal.aborted) {
          setTimeout(connect, 2000);
        }
      }
    };

    connect().catch(() => {});
    return () => controller.abort();
  }

  // ── Async generator interface ─────────────────────────────────────

  /**
   * Async-iterate over all events from a feed, starting from `sinceSeq`
   * and blocking for new chunks as they arrive (using SSE under the hood).
   *
   * Each yielded item is a parsed event from the feed.
   *
   * @example
   * for await (const event of client.stream("BTC-USD")) {
   *   await model.update(event);
   * }
   */
  async *stream<T = unknown>(
    feedId: string,
    options?: { sinceSeq?: number }
  ): AsyncGenerator<T> {
    // First catch up with any historical chunks
    let nextSeq = options?.sinceSeq ?? -1;
    const historical = await this.listChunks(feedId, { sinceSeq: nextSeq });

    for (const chunk of historical) {
      const events = await this.readChunk<T>(feedId, chunk.seq);
      for (const event of events) yield event;
      nextSeq = chunk.seq;
    }

    // Then subscribe to new chunks via SSE
    let pending: ChunkRecord[] = [];
    let resolve: (() => void) | null = null;

    const unsub = this.subscribe(feedId, (chunk) => {
      if (chunk.seq > nextSeq) {
        pending.push(chunk);
        resolve?.();
        resolve = null;
      }
    });

    try {
      while (true) {
        if (pending.length === 0) {
          await new Promise<void>((r) => { resolve = r; });
        }
        const chunk = pending.shift()!;
        const events = await this.readChunk<T>(feedId, chunk.seq);
        for (const event of events) yield event;
        nextSeq = chunk.seq;
      }
    } finally {
      unsub();
    }
  }
}
