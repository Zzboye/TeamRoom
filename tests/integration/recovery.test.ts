import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainId, DomainError, type Action, type ActionId, type EventEnvelope, type NewRoomEvent, type Room } from "../../packages/room-domain/src/index.js";
import { RoomRecovery, RoomService } from "../../packages/room-engine/src/index.js";
import type { ToolPort, ToolReconciliation } from "../../packages/runtime-ports/src/index.js";
import { openTeamRoomDatabase, SqliteEventStore, SqliteSnapshotStore } from "../../packages/sqlite-store/src/index.js";
import { action, roomId, startedActions, time } from "../../packages/sqlite-store/test/fixtures.js";
import { afterEach, expect, test, vi } from "vitest";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close() });
async function fixture(actions = [action()], startAll = true) {
  const directory = mkdtempSync(join(tmpdir(), "teamroom-recovery-"));
  const path = join(directory, "room.sqlite");
  let db = openTeamRoomDatabase(path);
  cleanup.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }) });
  await new SqliteEventStore(db).append(roomId, 0, startedActions(actions).filter(event => startAll || event.type !== "ActionStarted" || event.actionId === actions[0]!.id));
  db.close(); db = openTeamRoomDatabase(path); // simulate process exit after durable intent, before completion
  const events = new SqliteEventStore(db);
  const service = new RoomService({ events, snapshots: new SqliteSnapshotStore(db) });
  return { db, events, service };
}
const candidate = { id: domainId.candidate("legacy-candidate"), roomId, deliverable: "Previously accepted", checklist: [], decisions: [], unresolvedIssues: [], messageIds: [], artifactIds: [], sourceIds: [], createdAt: time, acceptedAt: null };
const stablePaths = {
  awaiting_input: [{ type: "InputRequested", prompt: "More input" }],
  awaiting_approval: [{ type: "ApprovalRequested", actionId: action("planned").id }],
  awaiting_acceptance: [{ type: "ConvergenceChecked", converged: true }, { type: "CandidateProduced", actor: "facilitator", candidate }],
  completed: [{ type: "ConvergenceChecked", converged: true }, { type: "CandidateProduced", actor: "facilitator", candidate }, { type: "CandidateAccepted", candidateId: candidate.id }],
} as const satisfies Record<string, readonly NewRoomEvent[]>;
/** Simulate v1 streams admitted before the new safe-boundary rule. */
async function appendLegacy(context: Awaited<ReturnType<typeof fixture>>, events: readonly NewRoomEvent[]) {
  let sequence = (await context.service.load(roomId)).streamVersion;
  for (const event of events) {
    const envelope: EventEnvelope = { event, roomId, sequence: ++sequence, schemaVersion: 1, occurredAt: time, eventId: domainId.event(`legacy-${sequence}`), causationId: domainId.command("legacy") };
    context.db.prepare("INSERT INTO room_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(roomId, sequence, envelope.eventId, event.type, time, envelope.causationId, 1, JSON.stringify(envelope));
  }
  context.db.prepare("UPDATE room_streams SET version = ? WHERE room_id = ?").run(sequence, roomId);
}
const success = { status: "succeeded", output: "Recovered result", artifactIds: [domainId.artifact("artifact-1")], usage: { tokens: 12, cost: 0.1 } } as const;
function tool(response: ToolReconciliation = success) {
  return { execute: vi.fn(async () => success), reconcile: vi.fn(async (_id: ActionId, _key: string): Promise<ToolReconciliation> => response) } satisfies ToolPort;
}

test.each(Object.keys(stablePaths) as (keyof typeof stablePaths)[])("legacy %s streams drain known success without changing their stable state", async status => {
  const context = await fixture([action(), action("planned")], false);
  await appendLegacy(context, stablePaths[status]);
  expect((await context.service.load(roomId)).status).toBe(status); // historical replay remains compatible
  const recovery = new RoomRecovery({ service: context.service, tool: tool() });
  const room = await recovery.recoverRoom(roomId);
  expect(room.status).toBe(status);
  expect(room.actions[0]?.status).toBe("succeeded");
  expect(room.usage.actions).toBe(1);
  expect(await recovery.recoverRoom(roomId)).toEqual(room);
});

test.each(Object.keys(stablePaths) as (keyof typeof stablePaths)[])("legacy %s streams drain unknown work to paused and retain completion history", async status => {
  const context = await fixture([action(), action("planned")], false);
  await appendLegacy(context, stablePaths[status]);
  const before = await context.service.load(roomId);
  const recovery = new RoomRecovery({ service: context.service, tool: tool({ status: "status_unknown", reason: "Unproven" }) });
  const room = await recovery.recoverRoom(roomId);
  expect(room.status).toBe("paused");
  expect(room.actions[0]?.status).toBe("status_unknown");
  expect(room.pauseRequested).toBe(false);
  expect(room.completedAt).toBe(before.completedAt);
  expect(room.candidate).toEqual(before.candidate);
  expect(room.activeRun?.completedAt).toBe(before.activeRun?.completedAt);
  expect(room.activeRun?.status).toBe("paused");
  expect(await recovery.recoverRoom(roomId)).toEqual(room);
});

test("new input, approval and convergence events cannot strand started actions", async () => {
  const { service, events } = await fixture([action(), action("planned")], false);
  const room = await service.load(roomId);
  for (const event of [stablePaths.awaiting_input[0], stablePaths.awaiting_approval[0], stablePaths.awaiting_acceptance[0]]) {
    await expect(events.append(roomId, room.streamVersion, [event])).rejects.toMatchObject({ code: "validation" });
  }
  expect((await service.load(roomId)).streamVersion).toBe(room.streamVersion);
});

test("new candidate production and acceptance are blocked on legacy in-flight rooms", async () => {
  const context = await fixture();
  await appendLegacy(context, [stablePaths.awaiting_acceptance[0]]);
  let room = await context.service.load(roomId);
  await expect(context.events.append(roomId, room.streamVersion, [stablePaths.awaiting_acceptance[1]])).rejects.toMatchObject({ code: "validation" });
  await appendLegacy(context, [stablePaths.awaiting_acceptance[1]]);
  room = await context.service.load(roomId);
  await expect(context.events.append(roomId, room.streamVersion, [{ type: "CandidateAccepted", candidateId: candidate.id }])).rejects.toMatchObject({ code: "validation" });
  await expect(context.service.execute({ type: "AcceptCandidate", actor: "user", commandId: domainId.command("accept-inflight"), roomId, expectedVersion: room.streamVersion, candidateId: candidate.id })).rejects.toMatchObject({ code: "validation" });
});

test.each([
  ["awaiting_input", { type: "InputProvided", message: { id: domainId.message("input"), roomId, authorType: "user", authorId: "user", content: "More input", type: "user", sequence: 1, createdAt: time } }],
  ["awaiting_approval", { type: "ActionApproved", actionId: action("planned").id }],
  ["awaiting_approval", { type: "ActionRejected", actionId: action("planned").id, reason: "decline" }],
  ["awaiting_acceptance", { type: "CandidateRejected", candidateId: candidate.id, reason: "revise" }],
] as const)("legacy %s cannot leave its stable state until started actions drain (%j)", async (status, event) => {
  const context = await fixture([action(), action("planned")], false);
  await appendLegacy(context, stablePaths[status]);
  const before = await context.service.load(roomId);
  await expect(context.events.append(roomId, before.streamVersion, [event])).rejects.toMatchObject({ code: "validation" });
  expect(await context.service.load(roomId)).toEqual(before);
});

test("legacy stable rooms drain all started actions before the unknown-result pause settles", async () => {
  const actions = [action("first"), { ...action("second"), position: 1 }];
  const context = await fixture(actions);
  await appendLegacy(context, stablePaths.awaiting_input);
  const adapter = tool();
  adapter.reconcile.mockImplementation(async id => id === actions[0]!.id ? { status: "status_unknown", reason: "Unproven" } : success);
  const room = await new RoomRecovery({ service: context.service, tool: adapter }).recoverRoom(roomId);
  expect(room.status).toBe("paused");
  expect(room.actions.map(item => item.status)).toEqual(["status_unknown", "succeeded"]);
  expect(room.pauseRequested).toBe(false);
  expect(room.usage.actions).toBe(2);
});

test("recovery reconciles durable started intent and commits known success exactly once", async () => {
  const { events, service } = await fixture();
  const adapter = tool();
  const recovery = new RoomRecovery({ service, tool: adapter });
  const room = await recovery.recoverRoom(roomId);
  expect(adapter.reconcile).toHaveBeenCalledExactlyOnceWith(action().id, action().idempotencyKey);
  expect(adapter.execute).not.toHaveBeenCalled();
  expect(room.actions[0]?.status).toBe("succeeded");
  expect(room.usage).toMatchObject({ actions: 1, tokens: 12, cost: 0.1 });
  expect(JSON.parse(room.messages[0]!.content)).toMatchObject({ output: success.output, artifactIds: success.artifactIds });
  await recovery.recoverRoom(roomId);
  expect(adapter.reconcile).toHaveBeenCalledTimes(1);
  expect((await events.load(roomId)).filter(item => item.event.type === "ActionCompleted")).toHaveLength(1);
});

test.each(["not_started", "failed", "status_unknown"] as const)("%s cannot trigger blind external execution and pauses for review", async status => {
  const { service } = await fixture();
  const adapter = tool({ status, reason: "Completion unproven" });
  const room = await new RoomRecovery({ service, tool: adapter }).recoverRoom(roomId);
  expect(adapter.execute).not.toHaveBeenCalled();
  expect(room.actions[0]?.status).toBe(status === "failed" ? "failed" : "status_unknown");
  expect(room.status).toBe("paused");
});

test("only explicitly safe deterministic work resumes after not_started reconciliation", async () => {
  const { service } = await fixture();
  const adapter = tool({ status: "not_started", reason: "No dispatch recorded" });
  const resume = vi.fn(async (_room: Room, _action: Action) => success);
  const room = await new RoomRecovery({ service, tool: adapter, safeDeterministic: { canResume: () => true, resume } }).recoverRoom(roomId);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0]?.[1]).toMatchObject({ id: action().id, idempotencyKey: action().idempotencyKey });
  expect(room.actions[0]?.status).toBe("succeeded");
  expect(room.status).toBe("running");
});

test("declaration does not permit retry of an unknown result", async () => {
  const { service } = await fixture();
  const resume = vi.fn(async () => success);
  const room = await new RoomRecovery({ service, tool: tool({ status: "status_unknown", reason: "uncertain" }), safeDeterministic: { canResume: () => true, resume } }).recoverRoom(roomId);
  expect(resume).not.toHaveBeenCalled();
  expect(room.status).toBe("paused");
});

test("pause intent blocks deterministic resume and survives recovery", async () => {
  const { events, service } = await fixture();
  const before = await service.load(roomId);
  await service.execute({ type: "PauseRun", commandId: domainId.command("pause"), roomId, expectedVersion: before.streamVersion, actor: "user", reason: "leave" });
  const resume = vi.fn(async () => success);
  const room = await new RoomRecovery({ service, tool: tool({ status: "not_started", reason: "safe but paused" }), safeDeterministic: { canResume: () => true, resume } }).recoverRoom(roomId);
  expect(resume).not.toHaveBeenCalled();
  expect(room.status).toBe("paused");
  expect((await events.load(roomId)).some(item => item.event.type === "RunResumed")).toBe(false);
});

test("adapter throws become unknown and pause", async () => {
  const { service } = await fixture();
  const adapter = tool();
  adapter.reconcile.mockRejectedValue(new Error("adapter lost status"));
  const room = await new RoomRecovery({ service, tool: adapter }).recoverRoom(roomId);
  expect(room.actions[0]).toMatchObject({ status: "status_unknown", errorCode: "status_unknown" });
  expect(room.status).toBe("paused");
});

test("malformed adapter success cannot prove completion", async () => {
  const { service } = await fixture();
  const adapter = tool({ ...success, usage: { tokens: -1 } });
  const room = await new RoomRecovery({ service, tool: adapter }).recoverRoom(roomId);
  expect(room.actions[0]?.status).toBe("status_unknown");
  expect(room.status).toBe("paused");
});

test("a completion append conflict retries only persistence of the obtained result", async () => {
  const { service, events } = await fixture();
  const adapter = tool({ status: "not_started", reason: "No execution" });
  const resume = vi.fn(async () => success);
  vi.spyOn(events, "append").mockRejectedValueOnce(new DomainError("conflict", "Concurrent command"));
  const room = await new RoomRecovery({ service, tool: adapter, safeDeterministic: { canResume: () => true, resume } }).recoverRoom(roomId);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(adapter.reconcile).toHaveBeenCalledTimes(1);
  expect(room.actions[0]?.status).toBe("succeeded");
  expect(room.usage.actions).toBe(1);
});

test("a pause arriving during reconciliation prevents deterministic resume", async () => {
  const { service } = await fixture();
  const adapter = tool();
  adapter.reconcile.mockImplementation(async () => {
    const room = await service.load(roomId);
    await service.execute({ type: "PauseRun", roomId, expectedVersion: room.streamVersion, commandId: domainId.command("pause-during-reconcile"), actor: "user", reason: "leave" });
    return { status: "not_started", reason: "No execution" };
  });
  const resume = vi.fn(async () => success);
  const room = await new RoomRecovery({ service, tool: adapter, safeDeterministic: { canResume: () => true, resume } }).recoverRoom(roomId);
  expect(resume).not.toHaveBeenCalled();
  expect(room.status).toBe("paused");
});

test("concurrent recovery instances reconcile but terminal result and usage commit only once", async () => {
  const { service, events } = await fixture();
  const adapter = tool();
  await Promise.all([new RoomRecovery({ service, tool: adapter }).recoverRoom(roomId), new RoomRecovery({ service, tool: adapter }).recoverRoom(roomId)]);
  const room = await service.load(roomId);
  expect(room.usage.actions).toBe(1);
  expect(room.messages).toHaveLength(1);
  expect((await events.load(roomId)).filter(item => item.event.type === "ActionCompleted")).toHaveLength(1);
});

test("unknown work requests a pause while other started actions reconcile to completion", async () => {
  const actions = [action("first"), { ...action("second"), position: 1 }];
  const { service, events } = await fixture(actions);
  const adapter = tool();
  adapter.reconcile.mockImplementation(async id => id === actions[0]!.id ? { status: "status_unknown", reason: "unproven" } : success);
  const room = await new RoomRecovery({ service, tool: adapter }).recoverRoom(roomId);
  expect(room.actions.map(item => item.status)).toEqual(["status_unknown", "succeeded"]);
  expect(room.status).toBe("paused");
  expect((await events.load(roomId)).filter(item => item.event.type === "RunPauseRequested")).toHaveLength(1);
});
