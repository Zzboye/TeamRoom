import { expect, it, vi } from "vitest";
import { domainId } from "@teamroom/room-domain";
import type { PersonaActionResult } from "@teamroom/runtime-ports";
import { AutonomousRunner } from "../src/runner.js";
import { action, roomId, running } from "./fixtures.js";

it("drains started work after a committed pause request without starting dependent work", async () => {
  const { service, events } = await running();
  const a = action(), b = action("action-2", 1, [a.id]);
  let complete!: (result: PersonaActionResult) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve });
  const facilitator = { plan: vi.fn(async () => ({ actions: [a, b] })), evaluate: vi.fn() };
  const runner = new AutonomousRunner({ service, facilitator, persona: { act: async () => {
    started();
    return new Promise(resolve => { complete = resolve });
  } } });
  const step = runner.step(roomId);
  await ready;
  const current = await service.load(roomId);
  const draining = await service.execute({ type: "PauseRun", commandId: domainId.command("pause"), roomId, expectedVersion: current.streamVersion, actor: "user", reason: "User interruption" });
  expect(draining.pauseRequested).toBe(true);
  complete({ messages: [], memoryProposals: [], usage: {} });
  expect((await step).outcome).toBe("paused");
  expect(events.events.filter(({ event }) => event.type === "ActionStarted")).toHaveLength(1);
  expect((await service.load(roomId)).actions[0]?.status).toBe("succeeded");
  await runner.step(roomId);
  expect(facilitator.plan).toHaveBeenCalledTimes(1);
  expect(facilitator.evaluate).not.toHaveBeenCalled();
});

it("does not commit a stale plan after pause during planning", async () => {
  const { service, events } = await running();
  const runner = new AutonomousRunner({ service, facilitator: { plan: async () => {
    const room = await service.load(roomId);
    await service.execute({ type: "PauseRun", commandId: domainId.command("pause"), roomId, expectedVersion: room.streamVersion, actor: "user", reason: "Stop" });
    return { actions: [action()] };
  }, evaluate: vi.fn() }, persona: { act: vi.fn() } });
  expect((await runner.step(roomId)).outcome).toBe("paused");
  expect(events.events.some(({ event }) => event.type === "ActionStarted" || event.type === "RoundPlanned")).toBe(false);
});

it("returns the authoritative pause when evaluation continues without events", async () => {
  const { service, events } = await running();
  const a = action(), b = action("action-2", 1, [a.id]);
  const runner = new AutonomousRunner({ service, facilitator: {
    plan: async () => ({ actions: [a, b] }),
    evaluate: async () => {
      const room = await service.load(roomId);
      await service.execute({ type: "PauseRun", commandId: domainId.command("pause"), roomId, expectedVersion: room.streamVersion, actor: "user", reason: "Stop during evaluation" });
      return { type: "continue", reason: "Remaining dependent work" };
    },
  }, persona: { act: async () => ({ messages: [], memoryProposals: [], usage: {} }) } });
  const result = await runner.step(roomId);
  expect(result.outcome).toBe("paused");
  expect(result.room).toEqual(await service.load(roomId));
  expect(result.room.actions.find(item => item.id === b.id)?.status).toBe("planned");
  expect(events.events.at(-1)?.event).toMatchObject({ type: "RunPaused", reason: "Stop during evaluation" });
  expect(events.events.filter(({ event }) => event.type === "ActionStarted")).toHaveLength(1);
});

it("starts no further action when the user pauses between rounds", async () => {
  const { service, events } = await running();
  const facilitator = { plan: vi.fn(async () => ({ actions: [action()] })), evaluate: vi.fn(async () => ({ type: "continue" as const, reason: "Next round" })) };
  const runner = new AutonomousRunner({ service, facilitator, persona: { act: async () => ({ messages: [], memoryProposals: [], usage: {} }) } });
  const advanced = await runner.step(roomId);
  await service.execute({ type: "PauseRun", commandId: domainId.command("pause"), roomId, expectedVersion: advanced.room.streamVersion, actor: "user", reason: "Stop between rounds" });
  expect((await runner.step(roomId)).outcome).toBe("paused");
  expect(facilitator.plan).toHaveBeenCalledTimes(1);
  expect(events.events.filter(({ event }) => event.type === "ActionStarted")).toHaveLength(1);
});
