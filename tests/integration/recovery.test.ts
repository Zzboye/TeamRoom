import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainId, DomainError, type Action, type ActionId, type Room } from "../../packages/room-domain/src/index.js";
import { RoomRecovery, RoomService } from "../../packages/room-engine/src/index.js";
import type { ToolPort, ToolReconciliation } from "../../packages/runtime-ports/src/index.js";
import { openTeamRoomDatabase, SqliteEventStore, SqliteSnapshotStore } from "../../packages/sqlite-store/src/index.js";
import { action, roomId, startedActions } from "../../packages/sqlite-store/test/fixtures.js";
import { afterEach, expect, test, vi } from "vitest";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close() });
async function fixture(actions = [action()]) {
  const directory = mkdtempSync(join(tmpdir(), "teamroom-recovery-"));
  const path = join(directory, "room.sqlite");
  let db = openTeamRoomDatabase(path);
  cleanup.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }) });
  await new SqliteEventStore(db).append(roomId, 0, startedActions(actions));
  db.close(); db = openTeamRoomDatabase(path); // simulate process exit after durable intent, before completion
  const events = new SqliteEventStore(db);
  const service = new RoomService({ events, snapshots: new SqliteSnapshotStore(db) });
  return { events, service };
}
const success = { status: "succeeded", output: "Recovered result", artifactIds: [domainId.artifact("artifact-1")], usage: { tokens: 12, cost: 0.1 } } as const;
function tool(response: ToolReconciliation = success) {
  return { execute: vi.fn(async () => success), reconcile: vi.fn(async (_id: ActionId, _key: string): Promise<ToolReconciliation> => response) } satisfies ToolPort;
}

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
