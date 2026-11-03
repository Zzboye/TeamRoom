import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { domainId, type NewRoomEvent } from "../../packages/room-domain/src/index.js";
import { RoomRecovery, type RoomEventStore } from "../../packages/room-engine/src/index.js";
import { createDeterministicAdapters } from "../../packages/test-adapters/src/index.js";
import { assertStream, databaseFixture, execute, failure, happyRunner, roomId, startRoom, time } from "./acceptance-support.js";

const terminated = new Error("Injected process termination after durable checkpoint");
const checkpoints = ["event append", "snapshot write", "action start", "simulated tool intent", "action completion", "candidate submission"] as const;

test.each(checkpoints)("reconstruction after %s preserves committed state and recovery is idempotent", async checkpoint => {
  let armed = false;
  let reached = false;
  let toolIntent = false;
  const target: Partial<Record<typeof checkpoints[number], NewRoomEvent["type"]>> = {
    "event append": "MessagePosted", "action start": "ActionStarted",
    "action completion": "ActionCompleted", "candidate submission": "CandidateProduced",
  };
  const context = databaseFixture({
    events: (events): RoomEventStore => ({
      load: (id, cursor) => events.load(id, cursor),
      append: async (id, version, batch) => {
        // The adapter has dispatched its simulated intent, but no terminal event may commit.
        if (armed && checkpoint === "simulated tool intent" && toolIntent && batch.some(event => event.type === "ActionCompleted")) {
          reached = true;
          throw terminated;
        }
        const committed = await events.append(id, version, batch);
        if (armed && batch.some(event => event.type === target[checkpoint])) { reached = true; throw terminated }
        return committed;
      },
    }),
  });
  await startRoom(context.service);
  armed = true;
  if (checkpoint === "event append") {
    await expect(execute(context.service, { type: "PostMessage", actor: "user", message: {
      id: domainId.message("durable-user"), roomId,
      authorType: "user", authorId: "user", type: "user", content: "Survives the crash", sequence: 1, createdAt: time,
    } })).rejects.toBe(terminated);
  } else if (checkpoint === "snapshot write") {
    await happyRunner(context.service).step(roomId);
    const room = await context.service.load(roomId);
    expect(room.messages).toHaveLength(1);
    expect(room.memory).toHaveLength(1);
    await context.snapshots.save({ schemaVersion: 1, roomId, sequence: room.streamVersion, room });
    reached = true; // Reconstruct immediately after the public snapshot write returns.
  } else {
    const adapters = createDeterministicAdapters(failure);
    const runner = happyRunner(context.service, checkpoint === "simulated tool intent" ? { persona: { act: async input => {
      // A durable test journal models dispatch intent; no actual external effect is performed.
      writeFileSync(join(context.directory, "tool-intent.json"), JSON.stringify({ actionId: input.action.id, idempotencyKey: input.action.idempotencyKey }));
      const response = await adapters.tool.execute({ roomId, actionId: input.action.id, idempotencyKey: input.action.idempotencyKey, callKey: "unknown", tool: "mock", input: "simulated intent" });
      expect(response.status).toBe("status_unknown");
      toolIntent = true;
      throw terminated;
    } } } : {});
    if (checkpoint === "candidate submission") await runner.step(roomId);
    await expect(runner.step(roomId)).rejects.toBe(terminated);
  }
  expect(reached).toBe(true);
  const before = await context.service.load(roomId);
  const priorEvents = await context.events.load(roomId);
  const completed = priorEvents.filter(event => event.event.type === "ActionCompleted");
  armed = false;
  const reopened = context.reopen();
  expect(await reopened.service.load(roomId)).toEqual(before);
  if (checkpoint === "snapshot write") expect((await reopened.snapshots.load(roomId))?.room).toEqual(before);
  const reconcile = vi.fn(async () => ({ status: "status_unknown" as const, reason: "Completion cannot be proven" }));
  const dispatch = vi.fn();
  if (checkpoint === "simulated tool intent") {
    const journal = JSON.parse(readFileSync(join(context.directory, "tool-intent.json"), "utf8"));
    expect(journal).toMatchObject({ actionId: before.actions[0]!.id, idempotencyKey: before.actions[0]!.idempotencyKey });
  }
  const recovery = new RoomRecovery({ service: reopened.service, tool: { execute: dispatch, reconcile } });
  const recovered = await recovery.recoverRoom(roomId);
  const once = await reopened.events.load(roomId);
  expect(await recovery.recoverRoom(roomId)).toEqual(recovered);
  expect(await reopened.events.load(roomId)).toEqual(once);
  expect(dispatch).not.toHaveBeenCalled();
  expect(recovered.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(once.slice(0, priorEvents.length)).toEqual(priorEvents);
  if (checkpoint === "action start" || checkpoint === "simulated tool intent") {
    expect(recovered.status).toBe("paused");
    expect(recovered.actions[0]?.status).toBe("status_unknown");
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(before.actions[0]!.id, before.actions[0]!.idempotencyKey);
  } else {
    expect(recovered).toEqual(before);
    expect(reconcile).not.toHaveBeenCalled();
  }
  if (checkpoint === "candidate submission") {
    expect(recovered.status).toBe("awaiting_acceptance");
    expect(recovered.candidate?.id).toBe("candidate-1");
  }
  for (const envelope of completed) {
    if (envelope.event.type !== "ActionCompleted") continue;
    const id = envelope.event.actionId;
    expect(once.filter(item => item.event.type === "ActionCompleted" && item.event.actionId === id)).toHaveLength(1);
  }
  for (const action of recovered.actions.filter(action => !["planned", "started"].includes(action.status))) {
    expect(once.filter(item => item.event.type === "ActionCompleted" && item.event.actionId === action.id)).toHaveLength(1);
  }
  await assertStream(reopened.service, reopened.events);
});
