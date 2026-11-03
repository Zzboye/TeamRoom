import { domainId, type NewRoomEvent } from "@teamroom/room-domain";
import { afterEach, expect, test } from "vitest";
import { openTeamRoomDatabase } from "../src/database.js";
import { SqliteEventStore } from "../src/event-store.js";
import { RoomRepository } from "../src/room-repository.js";
import { created, message, roomId, time, member } from "./fixtures.js";

const db = () => openTeamRoomDatabase(":memory:");
const opened: ReturnType<typeof db>[] = [];
afterEach(() => { for (const database of opened.splice(0)) database.close() });
function fixture() { const database = db(); opened.push(database); return { database, store: new SqliteEventStore(database, { clock: { now: () => time } }) } }

test("appends contiguous canonical envelopes and rejects stale versions without changes", async () => {
  const { database, store } = fixture();
  const first = await store.append(roomId, 0, [created, message(1)]);
  expect(first.map(item => item.sequence)).toEqual([1, 2]);
  expect(first[0]).toMatchObject({ roomId, occurredAt: time, schemaVersion: 1, event: created });
  expect(new Set(first.map(item => item.eventId)).size).toBe(2);
  await expect(store.append(roomId, 0, [created])).rejects.toMatchObject({ code: "conflict" });
  expect(await store.load(roomId, 1)).toEqual([first[1]]);
  expect(database.prepare("SELECT version FROM room_streams").get()).toEqual({ version: 2 });
  expect(database.prepare("SELECT count(*) AS n FROM room_events").get()).toEqual({ n: 2 });
  expect(database.prepare("SELECT sequence FROM messages").all()).toEqual([{ sequence: 1 }]);
  const row = database.prepare("SELECT event_json FROM room_events WHERE sequence = 1").get() as { event_json: string };
  expect(JSON.parse(row.event_json)).toEqual(first[0]);
  expect(row.event_json.startsWith('{"causationId":')).toBe(true);
});

test("an invalid clock cannot commit an unreadable event", async () => {
  const { database } = fixture();
  const store = new SqliteEventStore(database, { clock: { now: () => "invalid" } });
  await expect(store.append(roomId, 0, [created])).rejects.toMatchObject({ code: "validation" });
  expect(await store.load(roomId)).toEqual([]);
});

test.each([Infinity, -Infinity, NaN])("rejects non-finite numbers (%s) before append and preserves replay equality", async value => {
  const { database, store } = fixture();
  await expect(store.append(roomId, 0, [{ ...created, budget: { maxCost: value } } as NewRoomEvent])).rejects.toMatchObject({ code: "validation" });
  expect(database.prepare("SELECT count(*) AS n FROM room_events").get()).toEqual({ n: 0 });
  const repository = new RoomRepository({ events: store });
  const returned = await repository.execute({ type: "CreateRoom", roomId, expectedVersion: 0, commandId: domainId.command("create-finite"), title: "Finite", task: "Preserve numbers", requirements: [], acceptanceCriteria: [], backgroundPolicy: "pause_on_leave", budget: { maxCost: 12.5 } });
  expect(await repository.load(roomId)).toEqual(returned);
});

test("non-finite nested action positions cannot commit any part of a batch", async () => {
  const { database, store } = fixture();
  const { startedActions, action } = await import("./fixtures.js");
  await expect(store.append(roomId, 0, startedActions([{ ...action(), position: Infinity }]))).rejects.toMatchObject({ code: "validation" });
  expect(database.prepare("SELECT count(*) AS n FROM room_events").get()).toEqual({ n: 0 });
});

test("constraint failures roll back the entire batch including projections and stream version", async () => {
  const { database } = fixture();
  const store = new SqliteEventStore(database, { ids: { next: () => "duplicate" }, clock: { now: () => time } });
  await expect(store.append(roomId, 0, [created, message(1)])).rejects.toMatchObject({ code: "corrupt_data" });
  for (const table of ["room_streams", "room_events", "rooms", "messages"]) expect(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
});

test("rejects corrupt envelopes and missing stream tails", async () => {
  const { database, store } = fixture();
  await store.append(roomId, 0, [created, message(1)]);
  database.prepare("UPDATE room_events SET event_json = '{}' WHERE sequence = 1").run();
  await expect(store.load(roomId)).rejects.toMatchObject({ code: "corrupt_data" });
  database.prepare("DELETE FROM room_events WHERE sequence = 2").run();
  await expect(store.load(roomId, 1)).rejects.toMatchObject({ code: "corrupt_data" });
});

test("unknown event types cannot silently advance a room", async () => {
  const { store } = fixture();
  await expect(store.append(roomId, 0, [created, { type: "Bogus" } as unknown as NewRoomEvent])).rejects.toMatchObject({ code: "corrupt_data" });
  expect(await store.load(roomId)).toEqual([]);
});

test("memory provenance resolves only to messages or events from this room", async () => {
  const { store } = fixture();
  await store.append(roomId, 0, [created, { type: "TeamProposed", members: [member] }, message(1)]);
  const item = { id: domainId.memoryItem("memory-1"), roomId, memberId: member.id, kind: "fact" as const, content: "A fact", confidence: 1, provenance: [domainId.message("missing")], pinned: false, createdByEventId: domainId.event("ignored"), updatedByEventId: domainId.event("ignored") };
  await expect(store.append(roomId, 3, [{ type: "MemoryUpdated", memoryItemId: item.id, item }])).rejects.toMatchObject({ code: "validation" });
  await store.append(roomId, 3, [{ type: "MemoryUpdated", memoryItemId: item.id, item: { ...item, provenance: [domainId.message("message-1")] } }]);
});
