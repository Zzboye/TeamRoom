import { readFileSync } from "node:fs";
import { describe, expect, it, expectTypeOf } from "vitest";
import { domainId, initialRoom } from "@teamroom/room-domain";
import type { ArtifactPort, ClockPort, FacilitatorPort, IdPort, NotificationPort, PersonaPort, ToolPort, UsagePort } from "@teamroom/runtime-ports";
import { createDeterministicAdapters, loadScenario } from "../src/index.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../tests/fixtures/${name}.json`, import.meta.url), "utf8"));
const room = initialRoom({ id: domainId.room("room-1"), title: "Brief", task: "Prepare brief", requirements: [], acceptanceCriteria: [], backgroundPolicy: "pause_on_leave", createdAt: "2026-11-02T00:00:00.000Z" });

describe("deterministic runtime ports", () => {
  it("implements all runtime contracts and returns the ordered happy plan and candidate", async () => {
    const scenario = loadScenario(fixture("happy-path"));
    const ports = createDeterministicAdapters(scenario);
    expectTypeOf(ports.facilitator).toExtend<FacilitatorPort>();
    expectTypeOf(ports.persona).toExtend<PersonaPort>();
    expectTypeOf(ports.tool).toExtend<ToolPort>();
    expectTypeOf(ports.clock).toExtend<ClockPort>();
    expectTypeOf(ports.ids).toExtend<IdPort>();
    expectTypeOf(ports.artifacts).toExtend<ArtifactPort>();
    expectTypeOf(ports.usage).toExtend<UsagePort>();
    expectTypeOf(ports.notifications).toExtend<NotificationPort>();
    const plan = await ports.facilitator.plan({ room, callKey: "round-1" });
    expect(plan.actions.map(action => [action.memberId, action.position])).toEqual([["researcher", 0], ["editor", 1]]);
    expect(plan.actions[1]!.dependencies).toEqual([plan.actions[0]!.id]);
    for (const action of plan.actions) {
      const result = await ports.persona.act({ room, action, memory: [], callKey: action.id });
      expect(result.messages).toHaveLength(1);
    }
    const decision = await ports.facilitator.evaluate({ room, callKey: "round-1" });
    expect(decision.type).toBe("candidate");
    if (decision.type !== "candidate") throw new Error("Expected candidate");
    expect(decision.candidate.checklist.map(item => item.criterion)).toEqual(scenario.acceptanceCriteria);
    expect(decision.candidate.checklist.every(item => item.satisfied && item.evidence)).toBe(true);
  });

  it("scripts retryable failure, approval required, timeout, and unknown status", async () => {
    const ports = createDeterministicAdapters(loadScenario(fixture("failure-path")));
    const results = [];
    for (const callKey of ["retry", "approval", "timeout", "unknown"]) {
      results.push(await ports.tool.execute({ roomId: room.id, actionId: domainId.action("action-1"), idempotencyKey: "intent-1", callKey, tool: "mock", input: "nothing is executed" }));
    }
    expect(results.map(result => result.status)).toEqual(["retryable_failure", "approval_required", "timeout", "status_unknown"]);
    expect(await ports.tool.reconcile(domainId.action("action-1"), "intent-1")).toEqual({ status: "status_unknown", reason: "Completion cannot be proven" });
  });

  it("uses stable call keys, isolates returned values, and rejects missing scripts", async () => {
    const ports = createDeterministicAdapters(loadScenario(fixture("happy-path")));
    const action = (await ports.facilitator.plan({ room, callKey: "round-1" })).actions[0]!;
    const second = (await ports.facilitator.plan({ room, callKey: "round-1" })).actions[1]!;
    const b = await ports.persona.act({ room, action: second, memory: [], callKey: second.id });
    const a = await ports.persona.act({ room, action, memory: [], callKey: action.id });
    expect(a).toEqual(await ports.persona.act({ room, action, memory: [], callKey: action.id }));
    expect(ports.clock.now()).toBe("2026-11-02T00:00:03.000Z");
    expect(b.messages[0]!.authorId).toBe("editor");
    (a.messages as unknown[]).pop();
    expect((await ports.persona.act({ room, action, memory: [], callKey: action.id })).messages).toHaveLength(1);
    await expect(ports.facilitator.plan({ room, callKey: "missing" })).rejects.toThrow(/missing/);
  });

  it("repeats IDs and timestamps, advancing time only on explicit fixture instruction", async () => {
    const run = async () => {
      const ports = createDeterministicAdapters(loadScenario(fixture("happy-path")));
      const first = ports.clock.now();
      expect(ports.clock.now()).toBe(first);
      const plan = await ports.facilitator.plan({ room, callKey: "round-1" });
      await ports.persona.act({ room, action: plan.actions[0]!, memory: [], callKey: "research" });
      expect(ports.clock.now()).toBe("2026-11-02T00:00:01.000Z");
      return [first, ports.clock.now(), ports.ids.next("action"), ports.ids.next("message"), ports.ids.next("action")];
    };
    expect(await run()).toEqual(await run());
    expect((await run()).slice(2)).toEqual(["action-0001", "message-0001", "action-0002"]);
  });

  it("stores artifacts, accounts usage per room, and captures notifications without external effects", async () => {
    const ports = createDeterministicAdapters(loadScenario(fixture("happy-path")));
    const ref = await ports.artifacts.put({ roomId: room.id, name: "brief.txt", mediaType: "text/plain", content: "brief" });
    expect((await ports.artifacts.get(ref.id))?.content).toBe("brief");
    expect(await ports.artifacts.get(domainId.artifact("absent"))).toBeNull();
    expect(await ports.usage.charge(room.id, { tokens: 12, actions: 1 })).toEqual({ rounds: 0, actions: 1, tokens: 12, cost: 0 });
    expect(await ports.usage.current(domainId.room("other"))).toEqual({ rounds: 0, actions: 0, tokens: 0, cost: 0 });
    await expect(ports.usage.charge(room.id, { cost: -1 })).rejects.toThrow();
    await ports.notifications.publish({ roomId: room.id, type: "updated", message: "Ready" });
    expect(ports.notifications.published).toEqual([{ roomId: room.id, type: "updated", message: "Ready" }]);
  });

  it("strictly rejects invalid versioned fixtures and unresolved dependencies", () => {
    const valid = fixture("happy-path") as any;
    for (const change of [
      (s: any) => { s.schemaVersion = 2; },
      (s: any) => { s.unexpected = true; },
      (s: any) => { s.plans["round-1"].response.extra = true; },
      (s: any) => { s.plans["round-1"].response.actions[0].id = " "; },
      (s: any) => { s.personaActions.research.response.usage.tokens = -1; },
      (s: any) => { s.plans["round-1"].response.actions[0].dependencies = ["missing"]; },
    ]) {
      const invalid = structuredClone(valid);
      change(invalid);
      expect(() => loadScenario(invalid)).toThrow();
    }
  });

  it("preserves concurrent usage charges and failed charges leave usage unchanged", async () => {
    const ports = createDeterministicAdapters(loadScenario(fixture("happy-path")));
    await Promise.all([ports.usage.charge(room.id, { tokens: 10 }), ports.usage.charge(room.id, { tokens: 20 })]);
    expect((await ports.usage.current(room.id)).tokens).toBe(30);
    await expect(ports.usage.charge(room.id, { tokens: Number.POSITIVE_INFINITY })).rejects.toThrow();
    expect((await ports.usage.current(room.id)).tokens).toBe(30);
  });

  it("models tool success and permanent failure and requires exact reconciliation identity", async () => {
    const request = { roomId: room.id, actionId: domainId.action("action-1"), idempotencyKey: "intent-1", tool: "mock", input: "ignored" };
    const happy = createDeterministicAdapters(loadScenario(fixture("happy-path")));
    expect((await happy.tool.execute({ ...request, callKey: "success" })).status).toBe("succeeded");
    const failure = createDeterministicAdapters(loadScenario(fixture("failure-path")));
    expect((await failure.tool.execute({ ...request, callKey: "permanent" })).status).toBe("permanent_failure");
    await expect(failure.tool.reconcile(request.actionId, "different-intent")).rejects.toThrow(/Missing reconciliation/);
    await expect(failure.tool.reconcile(domainId.action("different-action"), request.idempotencyKey)).rejects.toThrow(/Missing reconciliation/);
  });
});
