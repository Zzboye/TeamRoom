import { describe, expect, it, vi } from "vitest";
import { domainId, DomainError, type Action } from "@teamroom/room-domain";
import type { ConvergenceDecision, FacilitatorPort, PersonaActionResult, PersonaPort } from "@teamroom/runtime-ports";
import { AutonomousRunner } from "../src/runner.js";
import { action, member, peer, roomId, running, time } from "./fixtures.js";

export const emptyResult: PersonaActionResult = { messages: [], memoryProposals: [], usage: {} };
export function facilitator(actions: readonly Action[], decision: ConvergenceDecision = { type: "continue", reason: "More work" }): FacilitatorPort {
  return { plan: vi.fn(async () => ({ actions })), evaluate: vi.fn(async () => decision) };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done });
  return { promise, resolve };
}

describe("AutonomousRunner", () => {
  it("commits concurrent reverse completions by position then action ID", async () => {
    const { service, events } = await running();
    const a = action("z", 1), b = action("b", 0), c = action("a", 0);
    const gates = new Map([a, b, c].map(item => [item.id, deferred<PersonaActionResult>()]));
    const called = deferred<void>();
    let calls = 0;
    const persona: PersonaPort = { act: async ({ action: item, memory }) => {
      expect(memory).toEqual([]);
      if (++calls === 3) called.resolve();
      return gates.get(item.id)!.promise;
    } };
    const runner = new AutonomousRunner({ service, facilitator: facilitator([a, b, c]), persona });
    const step = runner.step(roomId);
    await called.promise;
    gates.get(a.id)!.resolve(emptyResult);
    gates.get(b.id)!.resolve(emptyResult);
    gates.get(c.id)!.resolve(emptyResult);
    const result = await step;
    expect(result.outcome).toBe("advanced");
    expect(events.events.flatMap(({ event }) => event.type === "ActionCompleted" ? [event.actionId] : [])).toEqual([c.id, b.id, a.id]);
    expect(result.room.usage).toEqual({ rounds: 1, actions: 3, tokens: 0, cost: 0 });
  });

  it("runs one dependency wave per step without replanning the remaining actions", async () => {
    const { service } = await running();
    const a = action(), b = action("action-2", 1, [a.id]);
    const observed: string[] = [];
    const planner = facilitator([b, a]);
    const runner = new AutonomousRunner({ service, facilitator: planner, persona: { act: async ({ action: item, room }) => {
      if (item.id === b.id) expect(room.actions.find(entry => entry.id === a.id)?.status).toBe("succeeded");
      observed.push(item.id);
      return emptyResult;
    } } });
    await runner.step(roomId);
    expect(observed).toEqual([a.id]);
    expect((await service.load(roomId)).actions.find(item => item.id === b.id)?.status).toBe("planned");
    await runner.step(roomId);
    expect(observed).toEqual([a.id, b.id]);
    expect(planner.plan).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "retryable_adapter", "status_unknown", "approval_required"] as const)("records %s adapter failure and pauses", async code => {
    const { service } = await running();
    const result = await new AutonomousRunner({ service, facilitator: facilitator([action()]), persona: { act: async () => { throw new DomainError(code, "Script failure") } } }).step(roomId);
    expect(result.outcome).toBe("paused");
    expect(result.room.actions[0]).toMatchObject({ status: code === "status_unknown" ? "status_unknown" : "failed", errorCode: code });
  });

  it("requests approval only for a remaining planned action", async () => {
    const { service } = await running();
    const a = action(), b = action("action-2", 1, [a.id]);
    const planner = facilitator([a, b], { type: "request_approval", actionId: b.id, reason: "Review before proceeding" });
    const runner = new AutonomousRunner({ service, facilitator: planner, persona: { act: async () => emptyResult } });
    const pending = await runner.step(roomId);
    expect(pending.outcome).toBe("awaiting_approval");
    expect(pending.room.actions.find(item => item.id === b.id)?.status).toBe("planned");
    await service.execute({ type: "ApproveAction", commandId: domainId.command("approve"), roomId, expectedVersion: pending.room.streamVersion, actor: "user", actionId: b.id });
    planner.evaluate = async () => ({ type: "continue", reason: "Continue" });
    const resumed = await runner.step(roomId);
    expect(resumed.room.actions.find(item => item.id === b.id)?.status).toBe("succeeded");
    expect(planner.plan).toHaveBeenCalledTimes(1);
  });

  it("rejects approval targeting completed work as a permanent adapter failure", async () => {
    const { service, events } = await running();
    const a = action();
    const runner = new AutonomousRunner({ service, facilitator: facilitator([a], { type: "request_approval", actionId: a.id, reason: "Too late" }), persona: { act: async () => emptyResult } });
    expect((await runner.step(roomId)).outcome).toBe("paused");
    expect(events.events.at(-1)?.event).toMatchObject({ type: "RunPaused", reason: expect.stringContaining("permanent_adapter") });
    expect(events.events.some(({ event }) => event.type === "ApprovalRequested")).toBe(false);
  });

  it("rejects invalid facilitator assignments before recording the plan", async () => {
    const { service, events } = await running();
    const persona = { act: vi.fn(async () => emptyResult) };
    const result = await new AutonomousRunner({ service, facilitator: facilitator([{ ...action(), memberId: domainId.member("outsider") }]), persona }).step(roomId);
    expect(result.outcome).toBe("paused");
    expect(result.room.actions).toEqual([]);
    expect(persona.act).not.toHaveBeenCalled();
    expect(events.events.at(-1)?.event).toMatchObject({ type: "RunPaused", reason: expect.stringContaining("permanent_adapter") });
  });

  it.each([undefined, null, "", "   ", 42])("visibly pauses for malformed plan round ID %j", async roundId => {
    const { service, events } = await running();
    const persona = { act: vi.fn(async () => emptyResult) };
    const malformed = { ...action(), roundId } as unknown as Action;
    const result = await new AutonomousRunner({ service, facilitator: facilitator([malformed]), persona }).step(roomId);
    expect(result.outcome).toBe("paused");
    expect(result.room.actions).toEqual([]);
    expect(result.room.usage.rounds).toBe(0);
    expect(persona.act).not.toHaveBeenCalled();
    expect(events.events.at(-1)?.event).toMatchObject({ type: "RunPaused", reason: expect.stringContaining("permanent_adapter") });
  });

  it("rejects inconsistent plan round IDs before recording any action", async () => {
    const { service, events } = await running();
    const actions = [action(), { ...action("action-2", 1), roundId: domainId.round("round-2") }];
    const result = await new AutonomousRunner({ service, facilitator: facilitator(actions), persona: { act: vi.fn() } }).step(roomId);
    expect(result.outcome).toBe("paused");
    expect(result.room.actions).toEqual([]);
    expect(events.events.at(-1)?.event).toMatchObject({ type: "RunPaused", reason: expect.stringContaining("permanent_adapter") });
  });

  it("keeps the fallback round identity for an empty plan", async () => {
    const { service } = await running();
    const result = await new AutonomousRunner({ service, facilitator: facilitator([]), persona: { act: vi.fn() } }).step(roomId);
    expect(result.outcome).toBe("advanced");
    expect(result.room.activeRun?.roundIds).toEqual([domainId.round("run-1:round:1")]);
  });

  it("rejects an entire result containing cross-member memory mutation", async () => {
    const { service, events } = await running();
    const result = await new AutonomousRunner({ service, facilitator: facilitator([action()]), persona: { act: async () => ({
      messages: [{ id: domainId.message("message-1"), roomId, authorId: peer.id, authorType: "persona", type: "persona", content: "Do not partially commit", sequence: 1, createdAt: time }],
      memoryProposals: [{ id: domainId.memoryItem("memory-1"), roomId, memberId: member.id, kind: "goal", content: "Change someone else's memory", provenance: [], confidence: null, pinned: false, createdByEventId: domainId.event("proposal"), updatedByEventId: domainId.event("proposal") }], usage: { tokens: 20, cost: 0.02 },
    }) } }).step(roomId);
    expect(result.room.actions[0]).toMatchObject({ status: "failed", errorCode: "permanent_adapter" });
    expect(result.room.messages).toEqual([]);
    expect(result.room.memory).toEqual([]);
    expect(result.room.usage).toMatchObject({ tokens: 20, cost: 0.02 });
    expect(events.events.some(({ event }) => event.type === "MemoryUpdated")).toBe(false);
  });

  it("accepts valid public output and owner memory with committed provenance", async () => {
    const { service } = await running();
    const result = await new AutonomousRunner({ service, facilitator: facilitator([action()]), persona: { act: async () => ({
      messages: [{ id: domainId.message("message-1"), roomId, authorId: peer.id, authorType: "persona", type: "persona", content: "A contribution", sequence: 0, createdAt: time }],
      memoryProposals: [{ id: domainId.memoryItem("memory-1"), roomId, memberId: peer.id, kind: "goal", content: "Own next task", provenance: [], confidence: null, pinned: false, createdByEventId: domainId.event("proposal"), updatedByEventId: domainId.event("proposal") }], usage: { tokens: 20, cost: 0.01 },
    }) } }).step(roomId);
    expect(result.room.messages[0]).toMatchObject({ content: "A contribution", sequence: 1 });
    expect(result.room.memory[0]).toMatchObject({ content: "Own next task", memberId: peer.id });
    expect(result.room.memory[0]?.createdByEventId).not.toBe("proposal");
    expect(result.room.usage).toEqual({ rounds: 1, actions: 1, tokens: 20, cost: 0.01 });
  });

  it("rejects malformed runtime memory without persisting output", async () => {
    const { service } = await running();
    const result = await new AutonomousRunner({ service, facilitator: facilitator([action()]), persona: { act: async () => ({
      messages: [], memoryProposals: [{ id: "" as ReturnType<typeof domainId.memoryItem>, roomId, memberId: peer.id, kind: "goal", content: "Invalid identity", provenance: [], confidence: null, pinned: false, createdByEventId: domainId.event("proposal"), updatedByEventId: domainId.event("proposal") }], usage: {},
    }) } }).step(roomId);
    expect(result.room.actions[0]).toMatchObject({ status: "failed", errorCode: "permanent_adapter" });
    expect(result.room.memory).toEqual([]);
  });

  it("exposes only the acting member's private memory through both input paths", async () => {
    const { service } = await running();
    for (const owner of [member, peer]) {
      const room = await service.load(roomId);
      await service.execute({ type: "EditMemoryItem", commandId: domainId.command(`memory-${owner.id}`), roomId, expectedVersion: room.streamVersion, actor: "user", item: { id: domainId.memoryItem(`memory-${owner.id}`), roomId, memberId: owner.id, kind: "goal", content: `Private goal of ${owner.id}`, provenance: [], confidence: null, pinned: false, createdByEventId: domainId.event("proposal"), updatedByEventId: domainId.event("proposal") } });
    }
    const observed: string[][] = [];
    const runner = new AutonomousRunner({ service, facilitator: facilitator([action()]), persona: { act: async input => {
      observed.push(input.memory.map(item => item.memberId), input.room.memory.map(item => item.memberId));
      expect(Object.isFrozen(input.room)).toBe(true);
      return emptyResult;
    } } });
    await runner.step(roomId);
    expect(observed).toEqual([[peer.id], [peer.id]]);
    expect((await service.load(roomId)).memory).toHaveLength(2);
  });

  it("recovers from a member failure after explicit resume without poisoning future plans", async () => {
    const { service } = await running();
    let failed = false;
    const planner: FacilitatorPort = { plan: async () => ({ actions: failed ? [{ ...action("retry", 0), roundId: domainId.round("round-2") }] : [action()] }), evaluate: async () => ({ type: "continue", reason: "Continue" }) };
    const runner = new AutonomousRunner({ service, facilitator: planner, persona: { act: async () => {
      if (!failed) { failed = true; throw new Error("Scripted failure") }
      return emptyResult;
    } } });
    const paused = await runner.step(roomId);
    await service.execute({ type: "ResumeRun", commandId: domainId.command("resume"), roomId, expectedVersion: paused.room.streamVersion, actor: "user" });
    const resumed = await runner.step(roomId);
    expect(resumed.outcome).toBe("advanced");
    expect(resumed.room.actions.at(-1)?.status).toBe("succeeded");
  });

  it.each(["permanent_adapter", "status_unknown"] as const)("visibly pauses a resumed plan blocked by %s dependencies", async code => {
    const { service, events } = await running();
    const a = action(), b = action("action-2", 1, [a.id]), c = action("action-3", 2, [b.id]);
    const planner = facilitator([c, b, a]);
    const persona = { act: vi.fn(async () => { throw new DomainError(code, "Failed prerequisite") }) };
    const runner = new AutonomousRunner({ service, facilitator: planner, persona });
    const failed = await runner.step(roomId);
    for (const commandId of ["resume", "resume-again"]) {
      const current = await service.load(roomId);
      const resumed = await service.execute({ type: "ResumeRun", commandId: domainId.command(commandId), roomId, expectedVersion: current.streamVersion, actor: "user" });
      const blocked = await runner.step(roomId);
      expect(blocked.outcome).toBe("paused");
      expect(blocked.room.streamVersion).toBeGreaterThan(resumed.streamVersion);
      expect(blocked.room.actions.filter(item => item.status === "planned").map(item => item.id)).toEqual([c.id, b.id]);
      expect(events.events.at(-1)?.event).toMatchObject({ type: "RunPaused", reason: expect.stringContaining("blocked_plan") });
    }
    expect(failed.outcome).toBe("paused");
    expect(persona.act).toHaveBeenCalledTimes(1);
    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(planner.evaluate).not.toHaveBeenCalled();
  });

  it("visibly pauses descendants of a rejected prerequisite without starting them", async () => {
    const { service, events } = await running();
    const a = action(), b = action("action-2", 1, [a.id]), c = action("action-3", 2, [b.id]);
    const planner = facilitator([a, b, c], { type: "request_approval", actionId: b.id, reason: "Review" });
    const persona = { act: vi.fn(async () => emptyResult) };
    const runner = new AutonomousRunner({ service, facilitator: planner, persona });
    const pending = await runner.step(roomId);
    planner.evaluate = vi.fn(async () => ({ type: "continue" as const, reason: "Continue after rejection" }));
    await service.execute({ type: "RejectAction", commandId: domainId.command("reject"), roomId, expectedVersion: pending.room.streamVersion, actor: "user", actionId: b.id, reason: "Do not execute" });
    const blocked = await runner.step(roomId);
    expect(blocked.outcome).toBe("paused");
    expect(blocked.room.actions.find(item => item.id === b.id)?.status).toBe("cancelled");
    expect(blocked.room.actions.find(item => item.id === c.id)?.status).toBe("planned");
    expect(persona.act).toHaveBeenCalledTimes(1);
    expect(events.events.filter(({ event }) => event.type === "ActionStarted")).toHaveLength(1);
    expect(planner.evaluate).not.toHaveBeenCalled();
    expect(events.events.at(-1)?.event).toMatchObject({ type: "RunPaused", reason: expect.stringContaining("blocked_plan") });
  });

  it.each([
    [{ ...action(), dependencies: [domainId.action("missing")] }],
    [{ ...action(), dependencies: [domainId.action("action-1")] }],
    [action(), action()],
  ])("rejects invalid dependencies or duplicate identities", async (...actions) => {
    const { service } = await running();
    const result = await new AutonomousRunner({ service, facilitator: facilitator(actions), persona: { act: async () => emptyResult } }).step(roomId);
    expect(result.outcome).toBe("paused");
    expect(result.room.actions).toEqual([]);
  });

  it.each([
    [{ type: "request_input", question: "Which direction?" }, "awaiting_input"],
    [{ type: "pause", reason: "Review" }, "paused"],
    [{ type: "candidate", candidate: { id: domainId.candidate("candidate-1"), roomId, deliverable: "Plan", checklist: [{ criterion: "actionable", satisfied: true, evidence: "Plan" }], decisions: [], unresolvedIssues: [], messageIds: [], artifactIds: [], sourceIds: [], createdAt: time, acceptedAt: null } }, "awaiting_acceptance"],
  ] as const)("persists convergence decision %j", async (decision, outcome) => {
    const { service } = await running();
    const runner = new AutonomousRunner({ service, facilitator: facilitator([action()], decision), persona: { act: async () => emptyResult } });
    const result = await runner.step(roomId);
    expect(result.outcome).toBe(outcome);
    expect((await runner.step(roomId)).outcome).toBe(outcome);
  });
});
