// src/db.ts
import pg from "pg";
import "dotenv/config";

const { Pool } = pg;
export const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

export async function bootstrapSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id          TEXT PRIMARY KEY,            -- nanoid or user-supplied
      name        TEXT NOT NULL,
      description TEXT,
      format      TEXT NOT NULL DEFAULT 'jsonl',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id           TEXT PRIMARY KEY,
      feed_id      TEXT NOT NULL REFERENCES feeds(id),
      seq          BIGINT NOT NULL,
      blob_path    TEXT NOT NULL,
      blob_account TEXT NOT NULL,
      event_count  INT NOT NULL,
      window_start BIGINT NOT NULL,            -- ms epoch
      window_end   BIGINT NOT NULL,
      schema_hash  TEXT NOT NULL,
      format       TEXT NOT NULL DEFAULT 'jsonl',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(feed_id, seq)
    );

    CREATE INDEX IF NOT EXISTS chunks_feed_seq ON chunks (feed_id, seq DESC);
  `);
}
