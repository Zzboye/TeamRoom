import { describe, expect, it } from "vitest";
import { domainId } from "@teamroom/room-domain";
import { writeDerivedEvents } from "../src/room-service.js";
import { create, fixture, member, roomId } from "./fixtures.js";

describe("RoomService", () => {
  it("rejects stale commands without appending", async () => {
    const { service, events } = fixture();
    await service.execute(create());
    await expect(service.execute({ type: "ProposeTeam", roomId, expectedVersion: 0, commandId: domainId.command("stale"), actor: "user", members: [member] })).rejects.toMatchObject({ code: "conflict" });
    expect(events.events).toHaveLength(1);
    expect(events.appends).toBe(1);
  });

  it("loads committed state and rejects illegal commands with no append", async () => {
    const { service, events } = fixture();
    const created = await service.execute(create());
    expect(await service.load(roomId)).toEqual(created);
    await expect(service.execute({ type: "ConfirmTeam", roomId, expectedVersion: 1, commandId: domainId.command("invalid"), actor: "user" })).rejects.toMatchObject({ code: "validation" });
    expect(events.appends).toBe(1);
  });

  it("snapshots at an event interval and replays only the tail", async () => {
    const { service, events, snapshots } = fixture(2);
    await service.execute(create());
    expect(snapshots.saved).toHaveLength(0);
    await service.execute({ type: "ProposeTeam", roomId, expectedVersion: 1, commandId: domainId.command("team"), actor: "user", members: [member] });
    expect(snapshots.saved).toHaveLength(1);
    await service.execute({ type: "ConfirmTeam", roomId, expectedVersion: 2, commandId: domainId.command("confirm"), actor: "user" });
    expect((await service.load(roomId)).status).toBe("ready");
    expect(events.loads.at(-1)).toBe(2);
    expect(snapshots.saved).toHaveLength(1);
  });

  it("reports missing rooms and rejects invalid intervals", async () => {
    await expect(fixture().service.load(roomId)).rejects.toMatchObject({ code: "validation" });
    expect(() => fixture(0)).toThrow();
  });

  it("keeps snapshot-only loads immutable and separate from the cache", async () => {
    const { service, snapshots } = fixture(1);
    await service.execute(create());
    const room = await service.load(roomId);
    expect(Object.isFrozen(room)).toBe(true);
    expect(Object.isFrozen(room.requirements)).toBe(true);
    expect(room).not.toBe(snapshots.saved[0]!.room);
  });

  it("validates a complete derived batch before appending any event", async () => {
    const { service, events } = fixture();
    const room = await service.execute(create());
    await expect(writeDerivedEvents(service, room, [{ type: "TeamProposed", members: [member] }, { type: "ActionStarted", actionId: domainId.action("missing") }])).rejects.toMatchObject({ code: "corrupt_data" });
    expect(events.events).toHaveLength(1);
    expect(events.appends).toBe(1);
  });

  it("measures intervals from the last snapshot when a batch crosses the threshold", async () => {
    const { service, snapshots } = fixture(2);
    const room = await service.execute(create());
    const ready = await writeDerivedEvents(service, room, [{ type: "TeamProposed", members: [member] }, { type: "TeamConfirmed" }]);
    expect(snapshots.saved[0]?.sequence).toBe(3);
    await service.execute({ type: "StartRun", commandId: domainId.command("start"), roomId, expectedVersion: ready.streamVersion, runId: domainId.run("run-1") });
    expect(snapshots.saved).toHaveLength(1);
  });

  it("lets only one competing command commit at the expected version", async () => {
    const { service, events } = fixture();
    await service.execute(create());
    const command = { type: "ProposeTeam", roomId, expectedVersion: 1, commandId: domainId.command("team"), actor: "user", members: [member] } as const;
    const results = await Promise.allSettled([service.execute(command), service.execute({ ...command, commandId: domainId.command("competing") })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect(events.events).toHaveLength(2);
  });
});
