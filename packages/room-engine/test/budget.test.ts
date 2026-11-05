import { expect, it, vi } from "vitest";
import { AutonomousRunner } from "../src/runner.js";
import { action, roomId, running } from "./fixtures.js";

it("reserves action capacity before concurrent starts and emits a visible budget pause", async () => {
  const { service, events } = await running({ maxActions: 1 });
  const persona = { act: vi.fn(async () => ({ messages: [], memoryProposals: [], usage: {} })) };
  const runner = new AutonomousRunner({ service, facilitator: { plan: async () => ({ actions: [action(), action("action-2", 1)] }), evaluate: vi.fn() }, persona });
  const result = await runner.step(roomId);
  expect(result.outcome).toBe("paused");
  expect(result.room.usage.actions).toBe(1);
  expect(persona.act).toHaveBeenCalledTimes(1);
  expect(events.events.filter(({ event }) => event.type === "ActionStarted")).toHaveLength(1);
  expect(events.events.some(({ event }) => (event.type === "RunPaused" || event.type === "RunPauseRequested") && event.reason.includes("budget_exhausted"))).toBe(true);
});

it("pauses before planning a round beyond the configured limit", async () => {
  const { service, events } = await running({ maxRounds: 0 });
  const facilitator = { plan: vi.fn(), evaluate: vi.fn() };
  const result = await new AutonomousRunner({ service, facilitator, persona: { act: vi.fn() } }).step(roomId);
  expect(result.outcome).toBe("paused");
  expect(facilitator.plan).not.toHaveBeenCalled();
  expect(events.events.at(-1)?.event).toMatchObject({ type: "RunPaused", reason: expect.stringContaining("budget_exhausted") });
});

it("pauses before starting work with no remaining token or cost capacity", async () => {
  for (const budget of [{ maxTokens: 0 }, { maxCost: 0 }]) {
    const { service, events } = await running(budget);
    const persona = { act: vi.fn() };
    expect((await new AutonomousRunner({ service, facilitator: { plan: async () => ({ actions: [action()] }), evaluate: vi.fn() }, persona }).step(roomId)).outcome).toBe("paused");
    expect(persona.act).not.toHaveBeenCalled();
    expect(events.events.some(({ event }) => event.type === "ActionStarted")).toBe(false);
  }
});

it("records actual token/cost usage then pauses before dependent work can start", async () => {
  for (const budget of [{ maxTokens: 10 }, { maxCost: 0.01 }]) {
    const { service, events } = await running(budget);
    const a = action(), b = action("action-2", 1, [a.id]);
    const persona = { act: vi.fn(async () => ({ messages: [], memoryProposals: [], usage: { tokens: 12, cost: 0.02 } })) };
    const runner = new AutonomousRunner({ service, facilitator: { plan: async () => ({ actions: [a, b] }), evaluate: vi.fn() }, persona });
    const result = await runner.step(roomId);
    expect(result.outcome).toBe("paused");
    expect(result.room.usage).toMatchObject({ tokens: 12, cost: 0.02 });
    expect(result.room.actions.find(item => item.id === b.id)?.status).toBe("planned");
    await runner.step(roomId);
    expect(persona.act).toHaveBeenCalledTimes(1);
    expect(events.events.filter(({ event }) => event.type === "ActionStarted")).toHaveLength(1);
    expect(events.events.at(-1)?.event).toMatchObject({ type: "RunPaused", reason: expect.stringContaining("budget_exhausted") });
  }
});
