import { describe, expect, it } from "vitest";
import { domainId, reduceRoom, type Action, type EventEnvelope, type MemoryItem, type Room, type RoomEvent, type RoomMember } from "../src/index.js";

const roomId = domainId.room("room-1");
export const member: RoomMember = { id: domainId.member("facilitator-1"), name: "Facilitator", role: "Lead", responsibilities: [], domainPerspective: "planning", communicationStyle: "clear", constraints: [], collaborationGuidance: [], isFacilitator: true, sourceTemplateId: null, sourceTemplateVersion: null };
const runId = domainId.run("run-1");
const candidateId = domainId.candidate("candidate-1");
const time = "2026-11-02T00:00:00.000Z";
export const events: readonly RoomEvent[] = [
  { type: "RoomCreated", title: "Launch", task: "Plan launch", requirements: [], acceptanceCriteria: ["actionable"], backgroundPolicy: "pause_on_leave" },
  { type: "TeamProposed", members: [member] }, { type: "TeamConfirmed" },
  { type: "RunStarted", runId }, { type: "ConvergenceChecked", converged: true },
  { type: "CandidateProduced", actor: "facilitator", candidate: { id: candidateId, roomId, deliverable: "Launch plan", checklist: [{ criterion: "actionable", satisfied: true, evidence: "Plan" }], decisions: [], unresolvedIssues: [], messageIds: [], artifactIds: [], sourceIds: [], createdAt: time, acceptedAt: null } },
  { type: "CandidateAccepted", candidateId },
];
export function envelope(event: RoomEvent, sequence: number): EventEnvelope {
  return { eventId: domainId.event(`event-${sequence}`), roomId, sequence, occurredAt: time, causationId: domainId.command("command-1"), schemaVersion: 1, event };
}
export function replay(payloads: readonly RoomEvent[] = events): Room {
  let room: Room | null = null;
  payloads.forEach((event, index) => { room = reduceRoom(room, envelope(event, index + 1)); });
  if (room === null) throw new Error("Empty test stream");
  return room;
}

describe("reduceRoom", () => {
  it("reconstructs the full creation-to-acceptance lifecycle deterministically", () => {
    const room = replay();
    expect(room).toEqual(replay());
    expect(room).toMatchObject({ status: "completed", streamVersion: 7, teamConfirmed: true, completedAt: time, candidate: { acceptedAt: time }, activeRun: { status: "completed", completedAt: time } });
    expect(Object.isFrozen(room)).toBe(true);
    expect(Object.isFrozen(room.candidate?.checklist)).toBe(true);
  });

  it("rejects noncontiguous sequences, wrong rooms, and events without creation", () => {
    const room = replay(events.slice(0, 1));
    expect(() => reduceRoom(room, envelope({ type: "TeamConfirmed" }, 3))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    expect(() => reduceRoom(null, envelope({ type: "TeamConfirmed" }, 1))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    expect(() => reduceRoom(room, { ...envelope({ type: "RoomArchived" }, 2), roomId: domainId.room("other") })).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    expect(() => reduceRoom(room, envelope(events[0]!, 2))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
  });

  it("copies and deeply freezes payloads without freezing caller-owned objects", () => {
    const members = [{ ...member, responsibilities: ["Plan"] }];
    const before = replay(events.slice(0, 1));
    const room = reduceRoom(before, envelope({ type: "TeamProposed", members }, 2));
    members[0]!.responsibilities.push("changed");
    expect(room.members[0]?.responsibilities).toEqual(["Plan"]);
    expect(Object.isFrozen(room.members[0]?.responsibilities)).toBe(true);
    expect(before.members).toEqual([]);
  });

  it("rejects illegal lifecycle changes and unauthorized candidate production", () => {
    const draft = replay(events.slice(0, 1));
    expect(() => reduceRoom(draft, envelope({ type: "RunStarted", runId }, 2))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    const checking = replay(events.slice(0, 5));
    const candidateEvent = events[5]!;
    if (candidateEvent.type !== "CandidateProduced") throw new Error("Invalid fixture");
    expect(() => reduceRoom(checking, envelope({ ...candidateEvent, actor: "user" }, 6))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
  });

  it("replays round execution, stable interruptions, memory edits and audit events", () => {
    const roundId = domainId.round("round-1");
    const action: Action = { id: domainId.action("action-1"), roomId, runId, roundId, memberId: member.id, position: 0, instruction: "Plan", dependencies: [], idempotencyKey: "key-1", status: "planned", errorCode: null, startedAt: null, completedAt: null };
    const action2: Action = { ...action, id: domainId.action("action-2"), roundId: domainId.round("round-2"), idempotencyKey: "key-2" };
    const message = { id: domainId.message("message-1"), roomId, authorType: "user" as const, authorId: "user" as const, content: "Context", type: "user" as const, sequence: 1, createdAt: time };
    const item: MemoryItem = { id: domainId.memoryItem("memory-1"), roomId, memberId: member.id, kind: "fact", content: "Context", provenance: [message.id], confidence: 1, createdByEventId: domainId.event("placeholder"), updatedByEventId: domainId.event("placeholder"), pinned: false };
    const payloads: readonly RoomEvent[] = [
      ...events.slice(0, 4),
      { type: "MessagePosted", message },
      { type: "MessageLinked", messageId: message.id, link: { type: "mention", memberId: member.id } },
      { type: "MessageLinked", messageId: message.id, link: { type: "quote", messageId: message.id } },
      { type: "MemoryUpdated", memoryItemId: item.id, item },
      { type: "MemoryUpdated", memoryItemId: item.id, item: { ...item, pinned: true } },
      { type: "RoundPlanned", roundId, actions: [action] },
      { type: "ActionStarted", actionId: action.id },
      { type: "ActionCompleted", actionId: action.id, status: "succeeded", errorCode: null, usage: { rounds: 0, actions: 1, tokens: 50, cost: 0.01 } },
      { type: "RunPaused", reason: "Break" }, { type: "RunResumed" },
      { type: "InputRequested", prompt: "More detail?" },
      { type: "InputProvided", message: { ...message, id: domainId.message("message-2"), sequence: 2 } },
      { type: "ConvergenceChecked", converged: false },
      { type: "RoundPlanned", roundId: action2.roundId, actions: [action2] },
      { type: "ApprovalRequested", actionId: action2.id }, { type: "ActionApproved", actionId: action2.id },
      { type: "ApprovalRequested", actionId: action2.id }, { type: "ActionRejected", actionId: action2.id, reason: "Skip" },
      { type: "MemoryUpdated", memoryItemId: item.id, item: null },
      ...events.slice(4, 6),
      { type: "CandidateRejected", candidateId, reason: "Improve" },
      ...events.slice(4),
      { type: "HandoffGenerated", handoffId: domainId.handoff("handoff-1") },
      { type: "RoomArchived" },
    ];
    const room = replay(payloads);
    expect(room).toEqual(replay(payloads));
    expect(room).toMatchObject({ status: "archived", archivedAt: time, streamVersion: payloads.length, latestMessageSequence: 2, memory: [], usage: { rounds: 2, actions: 1, tokens: 50, cost: 0.01 } });
    expect(room.actions.map(item => item.status)).toEqual(["succeeded", "cancelled"]);
    const beforeDeletion = replay(payloads.slice(0, 9));
    expect(beforeDeletion.memory[0]).toMatchObject({ pinned: true, createdByEventId: "event-8", updatedByEventId: "event-9" });
  });

  it("rejects duplicate action completion and unsafe pause without mutating state", () => {
    const roundId = domainId.round("round-1");
    const action: Action = { id: domainId.action("action-1"), roomId, runId, roundId, memberId: member.id, position: 0, instruction: "Plan", dependencies: [], idempotencyKey: "key", status: "planned", errorCode: null, startedAt: null, completedAt: null };
    const room = replay([...events.slice(0, 4), { type: "RoundPlanned", roundId, actions: [action] }, { type: "ActionStarted", actionId: action.id }]);
    expect(() => reduceRoom(room, envelope({ type: "RunPaused", reason: "Break" }, 7))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    const completion: RoomEvent = { type: "ActionCompleted", actionId: action.id, status: "succeeded", errorCode: null, usage: { rounds: 0, actions: 1, tokens: 0, cost: 0 } };
    const completed = reduceRoom(room, envelope(completion, 7));
    expect(() => reduceRoom(completed, envelope(completion, 8))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    expect(room.actions[0]?.status).toBe("started");
    expect(completed.usage.actions).toBe(1);
  });

  it("preserves a pause request across replay, blocks starts, and drains before stable pause", () => {
    const roundId = domainId.round("pause-round");
    const action: Action = { id: domainId.action("started-1"), roomId, runId, roundId, memberId: member.id, position: 0, instruction: "Work", dependencies: [], idempotencyKey: "key-1", status: "planned", errorCode: null, startedAt: null, completedAt: null };
    const second = { ...action, id: domainId.action("started-2"), position: 1, idempotencyKey: "key-2" };
    const pending = { ...action, id: domainId.action("pending"), position: 2, idempotencyKey: "key-3" };
    const payloads: readonly RoomEvent[] = [...events.slice(0, 4),
      { type: "RoundPlanned", roundId, actions: [action, second, pending] },
      { type: "ActionStarted", actionId: action.id }, { type: "ActionStarted", actionId: second.id },
      { type: "RunPauseRequested", reason: "User requested pause" },
    ];
    const requested = replay(payloads);
    expect(requested).toMatchObject({ status: "running", pauseRequested: true, activeRun: { status: "running" } });
    expect(requested).toEqual(replay(payloads));
    const blocked: readonly RoomEvent[] = [
      { type: "ActionStarted", actionId: pending.id },
      { type: "RoundPlanned", roundId: domainId.round("next-round"), actions: [] },
      { type: "ConvergenceChecked", converged: true },
      { type: "InputRequested", prompt: "Input?" },
      { type: "ApprovalRequested", actionId: pending.id },
      { type: "RoomArchived" },
    ];
    for (const event of blocked) expect(() => reduceRoom(requested, envelope(event, 9))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    const completion = (actionId: Action["id"]): RoomEvent => ({ type: "ActionCompleted", actionId, status: "succeeded", errorCode: null, usage: { rounds: 0, actions: 1, tokens: 5, cost: 0 } });
    const draining = reduceRoom(requested, envelope(completion(action.id), 9));
    expect(draining).toMatchObject({ status: "running", pauseRequested: true, usage: { actions: 1, tokens: 5 } });
    const paused = reduceRoom(draining, envelope(completion(second.id), 10));
    expect(paused).toMatchObject({ status: "paused", pauseRequested: false, activeRun: { status: "paused" }, usage: { actions: 2, tokens: 10 } });
    expect(paused.actions.map(item => item.status)).toEqual(["succeeded", "succeeded", "planned"]);
    expect(() => reduceRoom(paused, envelope({ type: "ActionStarted", actionId: pending.id }, 11))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    const resumed = reduceRoom(paused, envelope({ type: "RunResumed" }, 11));
    expect(reduceRoom(resumed, envelope({ type: "ActionStarted", actionId: pending.id }, 12)).actions[2]?.status).toBe("started");
    expect(reduceRoom(paused, envelope({ type: "RoomArchived" }, 11)).status).toBe("archived");
  });

  it("rejects archive while an action is started even without a pause request", () => {
    const roundId = domainId.round("archive-round");
    const action: Action = { id: domainId.action("started"), roomId, runId, roundId, memberId: member.id, position: 0, instruction: "Work", dependencies: [], idempotencyKey: "key", status: "planned", errorCode: null, startedAt: null, completedAt: null };
    const room = replay([...events.slice(0, 4), { type: "RoundPlanned", roundId, actions: [action] }, { type: "ActionStarted", actionId: action.id }]);
    expect(() => reduceRoom(room, envelope({ type: "RoomArchived" }, 7))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    const completed = reduceRoom(room, envelope({ type: "ActionCompleted", actionId: action.id, status: "succeeded", errorCode: null, usage: { rounds: 0, actions: 1, tokens: 0, cost: 0 } }, 7));
    expect(reduceRoom(completed, envelope({ type: "RoomArchived" }, 8))).toMatchObject({ status: "archived", actions: [{ status: "succeeded" }] });
  });

  it("treats a missing legacy pause flag as false", () => {
    const roundId = domainId.round("legacy-round");
    const action: Action = { id: domainId.action("legacy-action"), roomId, runId, roundId, memberId: member.id, position: 0, instruction: "Work", dependencies: [], idempotencyKey: "legacy-key", status: "planned", errorCode: null, startedAt: null, completedAt: null };
    const { pauseRequested: _pauseRequested, ...legacy } = replay([...events.slice(0, 4), { type: "RoundPlanned", roundId, actions: [action] }]);
    const started = reduceRoom(legacy, envelope({ type: "ActionStarted", actionId: action.id }, 6));
    expect(started).toMatchObject({ pauseRequested: false, actions: [{ status: "started" }] });
  });

  it("drains a pause request in convergence_check without producing a candidate", () => {
    const roundId = domainId.round("checking-round");
    const action: Action = { id: domainId.action("checking-action"), roomId, runId, roundId, memberId: member.id, position: 0, instruction: "Work", dependencies: [], idempotencyKey: "checking-key", status: "planned", errorCode: null, startedAt: null, completedAt: null };
    const room = replay([...events.slice(0, 4), { type: "RoundPlanned", roundId, actions: [action] }, { type: "ActionStarted", actionId: action.id }, { type: "ConvergenceChecked", converged: true }, { type: "RunPauseRequested", reason: "Pause" }]);
    const candidate = events[5]!;
    expect(() => reduceRoom(room, envelope(candidate, 9))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
    const paused = reduceRoom(room, envelope({ type: "ActionCompleted", actionId: action.id, status: "failed", errorCode: "permanent_adapter", usage: { rounds: 0, actions: 1, tokens: 0, cost: 0 } }, 9));
    expect(paused).toMatchObject({ status: "paused", pauseRequested: false, activeRun: { status: "paused" }, actions: [{ status: "failed" }] });
  });
});
