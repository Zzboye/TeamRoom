import { createHash } from "node:crypto";
import { domainId, reduceRoom, type Room } from "@teamroom/room-domain";
import { afterEach, expect, test, vi } from "vitest";
import { openTeamRoomDatabase } from "../src/database.js";
import { SqliteEventStore } from "../src/event-store.js";
import { SqliteSnapshotStore } from "../src/snapshot-store.js";
import { RoomRepository } from "../src/room-repository.js";
import { created, message, roomId, startedActions } from "./fixtures.js";

const databases: ReturnType<typeof openTeamRoomDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close() });
async function fixture() {
  const db = openTeamRoomDatabase(":memory:"); databases.push(db);
  const events = new SqliteEventStore(db);
  const snapshots = new SqliteSnapshotStore(db);
  const envelopes = await events.append(roomId, 0, [created, ...Array.from({ length: 19 }, (_, index) => message(index + 1))]);
  const room = envelopes.reduce<Room | null>(reduceRoom, null)!;
  await snapshots.save({ schemaVersion: 1, roomId, sequence: 20, room });
  await events.append(roomId, 20, [message(20), message(21)]);
  return { db, events, snapshots, repository: new RoomRepository({ events, snapshots }), room };
}

test("valid snapshot at 20 replays only 21–22 and survives edited projections", async () => {
  const { db, events, repository } = await fixture();
  const load = vi.spyOn(events, "load");
  db.prepare("UPDATE rooms SET room_json = '{}'").run();
  const room = await repository.load(roomId);
  expect(room.streamVersion).toBe(22);
  expect(room.messages).toHaveLength(21);
  expect(load).toHaveBeenCalledExactlyOnceWith(roomId, 20);
});

test.each(["checksum", "schema", "json", "identity", "ahead"])("invalid snapshot (%s) is disposable and replays from event 1", async mode => {
  const { db, events, repository, room } = await fixture();
  if (mode === "checksum") db.prepare("UPDATE room_snapshots SET checksum = 'bad'").run();
  if (mode === "schema") db.prepare("UPDATE room_snapshots SET schema_version = 2").run();
  if (mode === "json") db.prepare("UPDATE room_snapshots SET snapshot_json = '{'").run();
  if (mode === "ahead" || mode === "identity") {
    const json = JSON.stringify({ schemaVersion: 1, roomId, sequence: mode === "ahead" ? 999 : 20, room: mode === "identity" ? { ...room, id: domainId.room("other") } : { ...room, streamVersion: 999 } });
    db.prepare("UPDATE room_snapshots SET snapshot_json = ?, checksum = ?").run(json, createHash("sha256").update(json).digest("hex"));
  }
  const load = vi.spyOn(events, "load");
  expect((await repository.load(roomId)).streamVersion).toBe(22);
  expect(load).toHaveBeenCalledExactlyOnceWith(roomId, undefined);
});

test("saving a fabricated snapshot is rejected and cannot override the log", async () => {
  const { snapshots, room } = await fixture();
  await expect(snapshots.save({ schemaVersion: 1, roomId, sequence: 20, room: { ...room, title: "fabricated" } })).rejects.toMatchObject({ code: "corrupt_data" });
  expect((await snapshots.load(roomId))?.room.title).toBe(room.title);
});

test("a corrupt newest snapshot falls back to the newest preceding valid snapshot", async () => {
  const { db, events, snapshots, repository } = await fixture();
  const room = await repository.load(roomId);
  await snapshots.save({ schemaVersion: 1, roomId, sequence: 22, room });
  db.prepare("UPDATE room_snapshots SET checksum = 'bad' WHERE last_sequence = 22").run();
  const load = vi.spyOn(events, "load");
  expect((await repository.load(roomId)).streamVersion).toBe(22);
  expect(load).toHaveBeenCalledExactlyOnceWith(roomId, 20);
});

test("pause intent survives snapshot plus terminal-action replay", async () => {
  const db = openTeamRoomDatabase(":memory:"); databases.push(db);
  const events = new SqliteEventStore(db);
  const snapshots = new SqliteSnapshotStore(db);
  const envelopes = await events.append(roomId, 0, [...startedActions(), { type: "RunPauseRequested", reason: "leave" }]);
  const room = envelopes.reduce<Room | null>(reduceRoom, null)!;
  await snapshots.save({ schemaVersion: 1, roomId, sequence: room.streamVersion, room });
  expect((await new RoomRepository({ events, snapshots }).load(roomId)).pauseRequested).toBe(true);
  await events.append(roomId, room.streamVersion, [{ type: "ActionCompleted", actionId: room.actions[0]!.id, status: "succeeded", errorCode: null, usage: { rounds: 0, actions: 1, tokens: 0, cost: 0 } }]);
  expect((await new RoomRepository({ events, snapshots }).load(roomId)).status).toBe("paused");
});
