import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTeamRoomDatabase } from "../src/database.js";

test("initial migration enables WAL and foreign keys and is idempotent on reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "teamroom-migration-"));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openTeamRoomDatabase(join(directory, "room.sqlite"));
      try {
        expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
        expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(db.pragma("user_version", { simple: true })).toBe(1);
        expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => (row as { name: string }).name);
        expect(tables).toEqual(expect.arrayContaining(["schema_migrations", "room_streams", "room_events", "room_snapshots", "persona_templates", "team_templates", "rooms", "room_members", "messages", "message_links", "memory_items", "runs", "actions", "candidate_results", "handoffs"]));
      } finally { db.close() }
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
});
