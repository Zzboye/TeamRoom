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

test.each([
  ["null action", (room: Record<string, unknown>) => { room.actions = [null] }],
  ["incomplete usage", (room: Record<string, unknown>) => { room.usage = {} }],
  ["missing activeRun", (room: Record<string, unknown>) => { delete room.activeRun }],
  ["malformed activeRun", (room: Record<string, unknown>) => { room.activeRun = { id: "run-1" } }],
  ["malformed member", (room: Record<string, unknown>) => { room.members = [{ id: "lead" }] }],
  ["malformed message", (room: Record<string, unknown>) => { room.messages = [null] }],
  ["malformed memory", (room: Record<string, unknown>) => { room.memory = [{ confidence: 0.5 }] }],
  ["malformed budget", (room: Record<string, unknown>) => { room.budget = { maxTokens: "many" } }],
  ["malformed candidate", (room: Record<string, unknown>) => { room.candidate = { checklist: [null] } }],
  ["malformed link", (room: Record<string, unknown>) => { room.messageLinks = [{ messageId: "message-1", link: { type: "mention" } }] }],
  ["malformed evaluation cursor", (room: Record<string, unknown>) => { room.pendingEvaluation = { roundId: "round-1", outcomes: [null] } }],
  ["malformed approval identity", (room: Record<string, unknown>) => { room.pendingApprovalActionId = 7 }],
  ["missing nullable field", (room: Record<string, unknown>) => { delete room.completedAt }],
] as const)("complete snapshot validation rejects %s even with a matching checksum", async (_label, corrupt) => {
  const { db, events, repository, room } = await fixture();
  const invalid = structuredClone(room) as unknown as Record<string, unknown>;
  corrupt(invalid);
  const json = JSON.stringify({ schemaVersion: 1, roomId, sequence: 20, room: invalid });
  db.prepare("UPDATE room_snapshots SET snapshot_json = ?, checksum = ?").run(json, createHash("sha256").update(json).digest("hex"));
  const load = vi.spyOn(events, "load");
  const restored = await repository.load(roomId);
  expect(restored.streamVersion).toBe(22);
  expect(restored.messages).toHaveLength(21);
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

test("snapshot lookup reads descending rows lazily and stops at the first valid one", async () => {
  const { db, snapshots, repository } = await fixture();
  const newest = await repository.load(roomId);
  await snapshots.save({ schemaVersion: 1, roomId, sequence: 22, room: newest });
  const prepare = db.prepare.bind(db);
  let visited = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!sql.includes("FROM room_snapshots")) return statement;
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "all").mockImplementation(() => { throw new Error("Snapshot rows must not be materialized eagerly") });
    vi.spyOn(statement, "iterate").mockImplementation(function* (...args: unknown[]) {
      for (const row of iterate(...args)) { visited++; yield row }
    });
    return statement;
  });
  try {
    expect((await snapshots.load(roomId))?.sequence).toBe(22);
    expect(visited).toBe(1);
  } finally { spy.mockRestore() }
});

test("legacy approval snapshots replay the exact request before admitting decisions", async () => {
  const db = openTeamRoomDatabase(":memory:"); databases.push(db);
  const events = new SqliteEventStore(db);
  const initial = startedActions();
  const startIndex = initial.findIndex(event => event.type === "ActionStarted");
  const planned = initial.slice(0, startIndex);
  const action = initial.find(event => event.type === "RoundPlanned")!.actions[0]!;
  const committed = await events.append(roomId, 0, [...planned, { type: "ApprovalRequested", actionId: action.id }]);
  const current = committed.reduce<Room | null>(reduceRoom, null)!;
  const legacy = structuredClone(current) as unknown as Record<string, unknown>;
  delete legacy.pendingApprovalActionId;
  delete legacy.pendingEvaluation;
  const json = JSON.stringify({ schemaVersion: 1, roomId, sequence: current.streamVersion, room: legacy });
  db.prepare("INSERT INTO room_snapshots VALUES (?, ?, 1, ?, ?)").run(roomId, current.streamVersion, json, createHash("sha256").update(json).digest("hex"));
  const repository = RoomRepository.sqlite(db);
  expect(await repository.load(roomId)).toMatchObject({ pendingApprovalActionId: action.id });
  const room = await repository.execute({ type: "ApproveAction", commandId: domainId.command("real-approval"), roomId, expectedVersion: current.streamVersion, actor: "user", actionId: action.id });
  expect(room).toMatchObject({ pendingApprovalActionId: null, status: "running" });
  expect((await events.load(roomId)).at(-1)?.causationId).toBe("real-approval");
});
