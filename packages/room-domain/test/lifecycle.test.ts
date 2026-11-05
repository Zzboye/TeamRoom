import { expect, it } from "vitest";
import { assertTransition, type RoomStatus } from "../src/index.js";

const edges: Partial<Record<RoomStatus, readonly RoomStatus[]>> = {
  draft: ["team_review"], team_review: ["ready"], ready: ["running"],
  running: ["convergence_check", "paused", "awaiting_input", "awaiting_approval"],
  convergence_check: ["running", "paused", "awaiting_input", "awaiting_approval", "awaiting_acceptance"],
  paused: ["running"], awaiting_input: ["running"], awaiting_approval: ["running"],
  awaiting_acceptance: ["running", "completed"],
};
const states: readonly RoomStatus[] = ["draft", "team_review", "ready", "running", "convergence_check", "paused", "awaiting_input", "awaiting_approval", "awaiting_acceptance", "completed", "archived"];

it("enumerates every legal edge and rejects every other edge", () => {
  for (const from of states) for (const to of states) {
    const allowed = (from !== "archived" && to === "archived") || edges[from]?.includes(to);
    if (allowed) expect(() => assertTransition(from, to)).not.toThrow();
    else expect(() => assertTransition(from, to)).toThrow(expect.objectContaining({ code: "validation" }));
  }
});
