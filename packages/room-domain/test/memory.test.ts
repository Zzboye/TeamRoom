import { expect, it } from "vitest";
import { decide, domainId, reduceRoom, type MemoryItem, type RoomCommand } from "../src/index.js";
import { envelope, events, member, replay } from "./task3-fixtures.js";
const room = replay(events.slice(0, 2));
const item: MemoryItem = { id: domainId.memoryItem("memory"), roomId: room.id, memberId: member.id, kind: "fact", content: "Evidence", provenance: [domainId.event("source")], confidence: 0.8, pinned: false, createdByEventId: domainId.event("created"), updatedByEventId: domainId.event("updated") };
const base = { commandId: domainId.command("memory-command"), roomId: room.id, expectedVersion: room.streamVersion };
it("allows users and owners to edit but rejects another member", () => {
  for (const actor of ["user" as const, member.id]) expect(decide(room, { ...base, type: "EditMemoryItem", actor, item }).ok).toBe(true);
  expect(decide(room, { ...base, type: "EditMemoryItem", actor: domainId.member("other"), item }).ok).toBe(false);
});
it("supports exactly six kinds and validates content evidence and confidence", () => {
  for (const kind of ["goal", "fact", "judgment", "assumption", "task", "completed"] as const) expect(decide(room, { ...base, type: "EditMemoryItem", actor: "user", item: { ...item, kind } }).ok).toBe(true);
  for (const invalid of [{ kind: "unknown" }, { content: "  " }, ...["fact", "judgment", "assumption"].flatMap(kind => [{ kind, provenance: [] }, ...[null, -1, 1.1, NaN, Infinity].map(confidence => ({ kind, confidence }))])]) {
    expect(decide(room, { ...base, type: "EditMemoryItem", actor: "user", item: { ...item, ...invalid } } as RoomCommand).ok).toBe(false);
  }
});
it("pins protect against adapter removal while users can edit and remove", () => {
  const saved = reduceRoom(room, envelope({ type: "MemoryUpdated", memoryItemId: item.id, item }, 3));
  const metadata = { ...base, expectedVersion: saved.streamVersion };
  const pin = decide(saved, { ...metadata, type: "PinMemoryItem", actor: "user", memoryItemId: item.id, pinned: true });
  if (!pin.ok) throw pin.error;
  const pinned = reduceRoom(saved, envelope(pin.events[0]!, 4));
  const meta = { ...base, expectedVersion: pinned.streamVersion };
  expect(decide(pinned, { ...meta, type: "RemoveMemoryItem", actor: member.id, memoryItemId: item.id }).ok).toBe(false);
  expect(decide(saved, { ...metadata, type: "RemoveMemoryItem", actor: member.id, memoryItemId: item.id }).ok).toBe(true);
  expect(decide(pinned, { ...meta, type: "EditMemoryItem", actor: "user", item: { ...item, pinned: true, content: "Changed" } }).ok).toBe(true);
  expect(decide(pinned, { ...meta, type: "RemoveMemoryItem", actor: "user", memoryItemId: item.id }).ok).toBe(true);
  expect(decide(saved, { ...metadata, type: "RemoveMemoryItem", actor: domainId.member("other"), memoryItemId: item.id }).ok).toBe(false);
});

it("requires evidence for claims while permitting goals without confidence", () => {
  expect(decide(room, { ...base, type: "EditMemoryItem", actor: "user", item: { ...item, kind: "goal", confidence: null, provenance: [] } }).ok).toBe(true);
  expect(decide(room, { ...base, type: "EditMemoryItem", actor: "user", item: { ...item, provenance: [domainId.message("message-evidence")] } }).ok).toBe(true);
  for (const invalid of [{ ...item, content: "" }, { ...item, provenance: [] }, { ...item, confidence: 2 }]) {
    expect(() => reduceRoom(room, envelope({ type: "MemoryUpdated", memoryItemId: item.id, item: invalid }, 3))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
  }
});
