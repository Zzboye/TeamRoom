import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTeamRoomDatabase, SqliteEventStore } from "../../packages/sqlite-store/src/index.js";
import { created, roomId } from "../../packages/sqlite-store/test/fixtures.js";

test("two connections cannot win the same expected stream version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "teamroom-concurrency-"));
  const first = openTeamRoomDatabase(join(directory, "room.sqlite"));
  const second = openTeamRoomDatabase(join(directory, "room.sqlite"));
  try {
    first.exec("BEGIN IMMEDIATE");
    second.pragma("busy_timeout = 0");
    await expect(new SqliteEventStore(second).append(roomId, 0, [created])).rejects.toMatchObject({ code: "conflict" });
    first.exec("ROLLBACK");
    expect(await new SqliteEventStore(second).load(roomId)).toEqual([]);
    const results = await Promise.allSettled([new SqliteEventStore(first).append(roomId, 0, [created]), new SqliteEventStore(second).append(roomId, 0, [created])]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect(await new SqliteEventStore(first).load(roomId)).toHaveLength(1);
    expect(second.prepare("SELECT version FROM room_streams").get()).toEqual({ version: 1 });
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }) }
});
