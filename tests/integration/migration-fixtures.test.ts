import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { openTeamRoomDatabase, RoomRepository, SqliteEventStore } from "../../packages/sqlite-store/src/index.js";
import { assertStream, createRoom, roomId, temporaryDirectory } from "./acceptance-support.js";

test("a fresh migration reproduces the released schema-v1 fixture", () => {
  const generated = join(temporaryDirectory(), "schema-v1-empty.sqlite");
  const db = openTeamRoomDatabase(generated);
  try {
    // Fix only migration metadata so regeneration does not depend on wall-clock time.
    db.prepare("UPDATE schema_migrations SET applied_at = ?").run("2026-11-02T00:00:00.000Z");
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_streams").get()).toEqual({ count: 0 });
  } finally { db.close() }
  const fixture = resolve("tests/fixtures/schema-v1-empty.sqlite");
  if (process.env.TEAMROOM_WRITE_MIGRATION_FIXTURE === "1") copyFileSync(generated, fixture);
  // Compare read-only copies; normal verification never opens the committed file for writing.
  const released = join(temporaryDirectory(), "released.sqlite");
  copyFileSync(fixture, released);
  const fresh = openTeamRoomDatabase(generated);
  const previous = openTeamRoomDatabase(released);
  try {
    const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name";
    expect(previous.prepare(schema).all()).toEqual(fresh.prepare(schema).all());
    expect(previous.prepare("SELECT * FROM schema_migrations").all()).toEqual(fresh.prepare("SELECT * FROM schema_migrations").all());
    for (const row of fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'schema_migrations'").all() as { name: string }[]) {
      expect(previous.prepare(`SELECT COUNT(*) AS count FROM ${row.name}`).get()).toEqual({ count: 0 });
    }
  } finally { fresh.close(); previous.close() }
});

test("the released empty schema-v1 fixture migrates as a no-op and accepts a new room", async () => {
  const path = join(temporaryDirectory(), "migrated.sqlite");
  const fixture = resolve("tests/fixtures/schema-v1-empty.sqlite");
  expect(existsSync(fixture), "Commit the generated schema-v1 empty database fixture").toBe(true);
  copyFileSync(fixture, path);
  const db = openTeamRoomDatabase(path);
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.prepare("SELECT version, applied_at FROM schema_migrations").all()).toEqual([{ version: 1, applied_at: "2026-11-02T00:00:00.000Z" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_events").get()).toEqual({ count: 0 });
    const service = RoomRepository.sqlite(db);
    const room = await createRoom(service);
    expect(room).toMatchObject({ id: roomId, status: "draft", streamVersion: 1 });
    expect((await assertStream(service, new SqliteEventStore(db))).map(item => item.event.type)).toEqual(["RoomCreated"]);
  } finally { db.close() }
  const reopened = openTeamRoomDatabase(path);
  try {
    expect((await RoomRepository.sqlite(reopened).load(roomId)).streamVersion).toBe(1);
    expect(reopened.prepare("SELECT version, applied_at FROM schema_migrations").all()).toEqual([{ version: 1, applied_at: "2026-11-02T00:00:00.000Z" }]);
  } finally { reopened.close() }
});
