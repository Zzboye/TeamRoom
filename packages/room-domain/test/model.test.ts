import { describe, expect, it } from "vitest";
import { DomainError, domainId, initialRoom } from "../src/index.js";

describe("initialRoom", () => {
  it("creates a draft with no mutable shared collections", () => {
    const room = initialRoom({
      id: domainId.room("room-1"), title: "Launch", task: "Plan launch",
      requirements: ["cite evidence"], acceptanceCriteria: ["plan is actionable"],
      backgroundPolicy: "pause_on_leave", createdAt: "2026-11-02T00:00:00.000Z",
    });
    expect(room.status).toBe("draft");
    expect(room.members).toEqual([]);
    expect(room.streamVersion).toBe(0);
    expect(Object.isFrozen(room)).toBe(true);
  });
});

describe("domainId", () => {
  it("rejects empty and whitespace identifiers for every ID kind", () => {
    for (const makeId of Object.values(domainId)) {
      for (const value of ["", " ", "\n\t"]) {
        expect(() => makeId(value)).toThrow(DomainError);
        expect(() => makeId(value)).toThrow(expect.objectContaining({ code: "validation" }));
      }
      expect(makeId("stable-id")).toBe("stable-id");
    }
    expect(Object.isFrozen(domainId)).toBe(true);
  });
});

it("copies and freezes initial collections and budget values", () => {
  const requirements = ["cite evidence"];
  const acceptanceCriteria = ["actionable"];
  const budget = { maxRounds: 3, maxActions: 5, maxTokens: 1000, maxCost: 1 };
  const input = {
    id: domainId.room("room-1"), title: "Launch", task: "Plan launch",
    requirements, acceptanceCriteria, budget,
    backgroundPolicy: "pause_on_leave" as const, createdAt: "2026-11-02T00:00:00.000Z",
  };
  const room = initialRoom(input);
  const another = initialRoom({ ...input, id: domainId.room("room-2") });
  requirements.push("changed");
  acceptanceCriteria.push("changed");
  budget.maxActions = 999;
  expect(room.requirements).toEqual(["cite evidence"]);
  expect(room.acceptanceCriteria).toEqual(["actionable"]);
  expect(room.budget?.maxActions).toBe(5);
  for (const value of Object.values(room)) {
    if (value !== null && typeof value === "object") expect(Object.isFrozen(value)).toBe(true);
  }
  expect(room.members).not.toBe(another.members);
  expect(room.usage).not.toBe(another.usage);
  expect(room.messages).toEqual([]);
  expect(room.activeRun).toBeNull();
  expect(room.candidate).toBeNull();
});
