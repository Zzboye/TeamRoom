import { expect, test, vi } from "vitest";
import { domainId, reduceRoom, type Room } from "../../packages/room-domain/src/index.js";
import { AutonomousRunner } from "../../packages/room-engine/src/index.js";
import type { ConvergenceDecision } from "../../packages/runtime-ports/src/index.js";
import { databaseFixture, execute, happy, happyRunner, members, roomId, startRoom, time } from "./acceptance-support.js";

const empty = { messages: [], memoryProposals: [], usage: {} };

test.each(["approval", "candidate"] as const)("restart evaluates a completed wave before new work: %s", async decision => {
  let armed = false;
  const crash = new Error("crash after durable completion");
  const context = databaseFixture({ events: events => ({
    load: (id, cursor) => events.load(id, cursor),
    append: async (...args) => {
      const committed = await events.append(...args);
      if (armed && args[2].some(event => event.type === "ActionCompleted")) { armed = false; throw crash }
      return committed;
    },
  }) });
  await startRoom(context.service);
  const actions = happy.plans["round-1"]!.response.actions;
  const facilitator = {
    plan: vi.fn(async () => ({ actions })),
    evaluate: vi.fn(async ({ room }: { room: Room }): Promise<ConvergenceDecision> => decision === "approval" && room.actions.some(action => action.status === "planned")
      ? { type: "request_approval", actionId: actions[1]!.id, reason: "Review" }
      : happy.convergence["round-1"]!.response),
  };
  const persona = { act: vi.fn(async ({ action }: { action: Room["actions"][number] }) => happy.personaActions[action.id]!.response) };
  const runner = new AutonomousRunner({ service: context.service, facilitator, persona });
  if (decision === "candidate") {
    facilitator.evaluate.mockResolvedValueOnce({ type: "continue", reason: "Next wave" });
    await runner.step(roomId);
  }
  armed = true;
  await expect(runner.step(roomId)).rejects.toBe(crash);
  const before = await context.service.load(roomId);
  expect(before).toMatchObject({ pendingEvaluation: { roundId: actions[0]!.roundId, outcomes: [expect.objectContaining({ status: "succeeded" })] } });
  const reopened = context.reopen();
  await reopened.snapshots.save({ schemaVersion: 1, roomId, sequence: before.streamVersion, room: before });
  const planned = facilitator.plan.mock.calls.length, acted = persona.act.mock.calls.length;
  const resumed = await new AutonomousRunner({ service: reopened.service, facilitator, persona }).step(roomId);
  expect(resumed.room.status).toBe(decision === "approval" ? "awaiting_approval" : "awaiting_acceptance");
  expect(resumed.room).toMatchObject({ pendingEvaluation: null });
  expect(facilitator.plan).toHaveBeenCalledTimes(planned);
  expect(persona.act).toHaveBeenCalledTimes(acted);
});

test.each(["ApproveAction", "RejectAction"] as const)("%s must resolve the exact recorded approval", async type => {
  const { service, events } = databaseFixture();
  await startRoom(service);
  const actions = happy.plans["round-1"]!.response.actions;
  const third = { ...actions[1]!, id: domainId.action("third"), idempotencyKey: "third", position: 2 };
  const runner = new AutonomousRunner({ service, persona: { act: async () => empty }, facilitator: {
    plan: async () => ({ actions: [...actions, third] }),
    evaluate: async () => ({ type: "request_approval", actionId: actions[1]!.id, reason: "Review edit only" }),
  } });
  const pending = (await runner.step(roomId)).room;
  await expect(execute(service, { type, actor: "user", actionId: third.id, reason: "Wrong action" })).rejects.toMatchObject({ code: "validation" });
  expect(await service.load(roomId)).toEqual(pending);
  const resolved = await execute(service, { type, actor: "user", actionId: actions[1]!.id, reason: "Resolved" });
  expect(resolved).toMatchObject({ pendingApprovalActionId: null });
  const log = await events.load(roomId);
  expect(log.at(-1)?.causationId).toBe(`acceptance-${pending.streamVersion}`);
  expect(log.reduce<Room | null>(reduceRoom, null)).toEqual(resolved);
});

test("SQLite invalid adapter provenance atomically fails, charges usage and pauses", async () => {
  const context = databaseFixture();
  const { service, events } = context;
  const append = vi.spyOn(events, "append");
  await startRoom(service);
  const output = structuredClone(happy.personaActions.research!.response);
  const invalid = { ...output, memoryProposals: output.memoryProposals.map(item => ({ ...item, provenance: [domainId.event("nonexistent")] })), usage: { tokens: 17, cost: 0.4 } };
  const runner = happyRunner(service, { persona: { act: async () => invalid } });
  const result = await runner.step(roomId);
  expect(result.room.status).toBe("paused");
  expect(result.room.actions[0]).toMatchObject({ status: "failed", errorCode: "permanent_adapter" });
  expect(result.room.usage).toMatchObject({ actions: 1, tokens: 17, cost: 0.4 });
  expect(result.room.messages).toEqual([]);
  expect(result.room.memory).toEqual([]);
  const log = await events.load(roomId);
  expect(log[0]?.causationId).toBe("acceptance-0");
  expect(log.some(item => item.event.type === "RunPauseRequested" || item.event.type === "RunPaused")).toBe(true);
  expect(log.filter(item => item.event.type === "ActionCompleted")).toHaveLength(1);
  const failureBatch = append.mock.calls.find(call => call[2].some(event => event.type === "ActionCompleted"));
  expect(failureBatch?.[2].map(event => event.type)).toEqual(["RunPauseRequested", "ActionCompleted", "WaveEvaluated"]);
  expect(await context.reopen().service.load(roomId)).toEqual(result.room);
});

test("facilitator planning and evaluation see only its own private memory", async () => {
  const { service } = databaseFixture();
  await startRoom(service);
  for (const member of members) await execute(service, { type: "EditMemoryItem", actor: "user", item: {
    id: domainId.memoryItem(`private-${member.id}`), roomId, memberId: member.id, kind: "goal", content: `Private ${member.id}`, provenance: [], confidence: null,
    pinned: false, createdByEventId: domainId.event("proposal"), updatedByEventId: domainId.event("proposal"),
  } });
  const seen: string[][] = [];
  await new AutonomousRunner({ service, persona: { act: async () => empty }, facilitator: {
    plan: async ({ room }) => { seen.push(room.memory.map(item => item.memberId)); return happy.plans["round-1"]!.response },
    evaluate: async ({ room }) => { seen.push(room.memory.map(item => item.memberId)); return { type: "continue", reason: "Continue" } },
  } }).step(roomId);
  expect(seen).toEqual([["facilitator"], ["facilitator"]]);
  expect((await service.load(roomId)).memory).toHaveLength(3);
});

test.each([{ maxTokens: 10 }, { maxCost: 1 }])("independent actions charge before next capped dispatch: %j", async budget => {
  const { service } = databaseFixture();
  await execute(service, { type: "CreateRoom", title: "Budget", task: "Budget", requirements: [], acceptanceCriteria: [], backgroundPolicy: "pause_on_leave", budget });
  await execute(service, { type: "ProposeTeam", actor: "user", members });
  await execute(service, { type: "ConfirmTeam", actor: "user" });
  await execute(service, { type: "StartRun", runId: domainId.run("run-1") });
  const actions = happy.plans["round-1"]!.response.actions.map(action => ({ ...action, dependencies: [] }));
  const act = vi.fn(async () => ({ ...empty, usage: { tokens: 12, cost: 1.2 } }));
  const result = await new AutonomousRunner({ service, persona: { act }, facilitator: { plan: async () => ({ actions }), evaluate: vi.fn() } }).step(roomId);
  expect(act).toHaveBeenCalledTimes(1);
  expect(result.room.actions.map(action => action.status)).toEqual(["succeeded", "planned"]);
  expect(result.room.status).toBe("paused");
});

test("restart preserves a budget pause after a charged action completes", async () => {
  let armed = false;
  const crash = new Error("exit before budget check");
  const context = databaseFixture({ events: events => ({ load: (id, cursor) => events.load(id, cursor), append: async (...args) => {
    const committed = await events.append(...args);
    if (armed && args[2].some(event => event.type === "ActionCompleted")) { armed = false; throw crash }
    return committed;
  } }) });
  await execute(context.service, { type: "CreateRoom", title: "Budget", task: "Budget", requirements: [], acceptanceCriteria: [], backgroundPolicy: "pause_on_leave", budget: { maxTokens: 10 } });
  await execute(context.service, { type: "ProposeTeam", actor: "user", members });
  await execute(context.service, { type: "ConfirmTeam", actor: "user" });
  await execute(context.service, { type: "StartRun", runId: domainId.run("run-1") });
  const facilitator = { plan: vi.fn(async () => happy.plans["round-1"]!.response), evaluate: vi.fn(async () => ({ type: "continue" as const, reason: "More work" })) };
  const persona = { act: vi.fn(async () => ({ ...empty, usage: { tokens: 12 } })) };
  armed = true;
  await expect(new AutonomousRunner({ service: context.service, facilitator, persona }).step(roomId)).rejects.toBe(crash);
  const reopened = context.reopen();
  const resumed = await new AutonomousRunner({ service: reopened.service, facilitator, persona }).step(roomId);
  expect(resumed.room.status).toBe("paused");
  expect(persona.act).toHaveBeenCalledTimes(1);
  expect(facilitator.evaluate).not.toHaveBeenCalled();
});

test("legacy failed waves still pause blocked dependencies before evaluation", async () => {
  const { service, events } = databaseFixture();
  const running = await startRoom(service);
  const actions = happy.plans["round-1"]!.response.actions;
  await events.append(roomId, running.streamVersion, [
    { type: "RoundPlanned", roundId: actions[0]!.roundId, actions },
    { type: "ActionStarted", actionId: actions[0]!.id },
    { type: "ActionCompleted", actionId: actions[0]!.id, status: "failed", errorCode: "permanent_adapter", usage: { rounds: 0, actions: 1, tokens: 0, cost: 0 } },
    { type: "RunPaused", reason: "Legacy failure review" },
  ]);
  await execute(service, { type: "ResumeRun", actor: "user" });
  const evaluate = vi.fn(async () => ({ type: "continue" as const, reason: "Continue" }));
  const result = await happyRunner(service, { facilitator: { plan: vi.fn(), evaluate } }).step(roomId);
  expect(result.room.status).toBe("paused");
  expect(evaluate).not.toHaveBeenCalled();
  expect((await events.load(roomId)).at(-1)?.event).toMatchObject({ type: "RunPaused", reason: expect.stringContaining("blocked_plan") });
});

test("command and action causation survives append, output and replay", async () => {
  const { service, events } = databaseFixture();
  await startRoom(service);
  let room = await service.load(roomId);
  const commandId = domainId.command("real-user-command");
  await service.execute({ type: "PostMessage", commandId, roomId, expectedVersion: room.streamVersion, actor: "user", message: {
    id: domainId.message("user-message"), roomId, authorType: "user", authorId: "user", type: "user", content: "Proceed", sequence: 1, createdAt: time,
  } });
  room = (await happyRunner(service).step(roomId)).room;
  const log = await events.load(roomId);
  expect(log.find(item => item.event.type === "MessagePosted" && item.event.message.id === "user-message")?.causationId).toBe(commandId);
  for (const envelope of log.filter(item => item.event.type === "MemoryUpdated" || item.event.type === "MessagePosted" && item.event.message.authorType === "persona")) expect(envelope.causationId).toBe("research");
  expect(log.reduce<Room | null>(reduceRoom, null)).toEqual(room);
});
