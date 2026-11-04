import { describe, expect, it } from "vitest";
import { decide, domainId, initialRoom, type Room, type RoomCommand, type RoomMember, type MemoryItem } from "../src/index.js";

const roomId = domainId.room("room-1");
const commandId = domainId.command("command-1");
const draftRoom = initialRoom({ id: roomId, title: "Launch", task: "Plan launch", requirements: [], acceptanceCriteria: ["actionable"], backgroundPolicy: "pause_on_leave", createdAt: "2026-11-02T00:00:00Z" });
const base = { roomId, commandId, expectedVersion: 0 };
const member: RoomMember = { id: domainId.member("facilitator-1"), name: "Facilitator", role: "Lead", responsibilities: [], domainPerspective: "planning", communicationStyle: "clear", constraints: [], collaborationGuidance: [], isFacilitator: true, sourceTemplateId: null, sourceTemplateVersion: null };
const runId = domainId.run("run-1");
const running: Room = { ...draftRoom, status: "running", teamConfirmed: true, members: [member], activeRun: { id: runId, roomId, status: "running", roundIds: [], startedAt: draftRoom.createdAt, completedAt: null } };
const candidateId = domainId.candidate("candidate-1");
const awaiting: Room = { ...running, status: "awaiting_acceptance", candidate: { id: candidateId, roomId, deliverable: "Plan", checklist: [], decisions: [], unresolvedIssues: [], messageIds: [], artifactIds: [], sourceIds: [], createdAt: draftRoom.createdAt, acceptedAt: null } };
const message = { id: domainId.message("message-1"), roomId, authorType: "user" as const, authorId: "user" as const, content: "More detail", type: "user" as const, sequence: 1, createdAt: draftRoom.createdAt };
const memory: MemoryItem = { id: domainId.memoryItem("memory-1"), roomId, memberId: member.id, kind: "fact", content: "Context", provenance: [domainId.event("evidence")], confidence: 1, createdByEventId: domainId.event("original"), updatedByEventId: domainId.event("original"), pinned: false };

describe("decide", () => {
  it("requires team confirmation before a run starts", () => {
    expect(decide(draftRoom, { ...base, type: "StartRun", runId: domainId.run("run-1") })).toEqual({ ok: false, error: expect.objectContaining({ code: "validation" }) });
  });

  it("allows only the user to accept a candidate", () => {
    for (const actor of ["facilitator", member.id] as const) {
      expect(decide(awaiting, { ...base, type: "AcceptCandidate", candidateId, actor }).ok).toBe(false);
    }
  });

  it("rejects stale versions and wrong rooms without events", () => {
    expect(decide(draftRoom, { ...base, expectedVersion: 1, type: "ArchiveRoom", actor: "user" })).toEqual({ ok: false, error: expect.objectContaining({ code: "conflict" }) });
    expect(decide(draftRoom, { ...base, roomId: domainId.room("other"), type: "ArchiveRoom", actor: "user" }).ok).toBe(false);
  });

  it("only creates a new room from null", () => {
    expect(decide(null, { ...base, type: "ArchiveRoom", actor: "user" }).ok).toBe(false);
    const command = { ...base, expectedVersion: 0 as const, type: "CreateRoom" as const, title: "Launch", task: "Plan", requirements: [], acceptanceCriteria: ["actionable"], backgroundPolicy: "pause_on_leave" as const };
    expect(decide(null, command)).toMatchObject({ ok: true, events: [{ type: "RoomCreated", title: "Launch" }] });
    expect(decide(draftRoom, command).ok).toBe(false);
  });

  it("rejects archived room mutations", () => {
    expect(decide({ ...draftRoom, status: "archived" }, { ...base, type: "ArchiveRoom", actor: "user" }).ok).toBe(false);
  });

  it("requires a candidate even for the user", () => {
    expect(decide({ ...draftRoom, status: "awaiting_acceptance" }, { ...base, type: "AcceptCandidate", candidateId: domainId.candidate("candidate-1"), actor: "user" }).ok).toBe(false);
  });

  it("emits an event for every supported command in its legal state", () => {
    const actionId = domainId.action("action-1");
    const pending: Room = { ...running, status: "awaiting_approval", pendingApprovalActionId: actionId, actions: [{ id: actionId, roomId, runId, roundId: domainId.round("round-1"), memberId: member.id, position: 0, instruction: "Work", dependencies: [], idempotencyKey: "key", status: "planned", errorCode: null, startedAt: null, completedAt: null }] };
    const cases: readonly [Room, RoomCommand, string][] = [
      [draftRoom, { ...base, type: "ProposeTeam", members: [member], actor: "facilitator" }, "TeamProposed"],
      [{ ...running, status: "team_review", teamConfirmed: false }, { ...base, type: "ConfirmTeam", actor: "user" }, "TeamConfirmed"],
      [{ ...running, status: "ready", activeRun: null }, { ...base, type: "StartRun", runId }, "RunStarted"],
      [running, { ...base, type: "PostMessage", message, actor: "user" }, "MessagePosted"],
      [running, { ...base, type: "PauseRun", reason: "Break", actor: "user" }, "RunPaused"],
      [{ ...running, status: "paused" }, { ...base, type: "ResumeRun", actor: "user" }, "RunResumed"],
      [pending, { ...base, type: "ApproveAction", actionId, actor: "user" }, "ActionApproved"],
      [pending, { ...base, type: "RejectAction", actionId, reason: "No", actor: "user" }, "ActionRejected"],
      [{ ...running, status: "awaiting_input" }, { ...base, type: "ProvideRequestedInput", message, actor: "user" }, "InputProvided"],
      [running, { ...base, type: "EditMemoryItem", item: memory, actor: member.id }, "MemoryUpdated"],
      [{ ...running, memory: [memory] }, { ...base, type: "PinMemoryItem", memoryItemId: memory.id, pinned: true, actor: "user" }, "MemoryUpdated"],
      [{ ...running, memory: [memory] }, { ...base, type: "RemoveMemoryItem", memoryItemId: memory.id, actor: "user" }, "MemoryUpdated"],
      [awaiting, { ...base, type: "AcceptCandidate", candidateId, actor: "user" }, "CandidateAccepted"],
      [awaiting, { ...base, type: "RejectCandidate", candidateId, reason: "Improve", actor: "user" }, "CandidateRejected"],
      [awaiting, { ...base, type: "GenerateHandoff", handoffId: domainId.handoff("handoff-1"), actor: "user" }, "HandoffGenerated"],
      [running, { ...base, type: "ArchiveRoom", actor: "user" }, "RoomArchived"],
    ];
    for (const [room, command, eventType] of cases) {
      const before = JSON.stringify(room);
      expect(decide(room, command)).toMatchObject({ ok: true, events: [{ type: eventType }] });
      expect(JSON.stringify(room)).toBe(before);
      expect(decide({ ...room, status: "archived" }, command)).toMatchObject({ ok: false, error: { code: "validation" } });
    }
  });

  it("enforces user control, message authorship, and memory ownership", () => {
    const cases: readonly RoomCommand[] = [
      { ...base, type: "ConfirmTeam", actor: "facilitator" },
      { ...base, type: "ResumeRun", actor: member.id },
      { ...base, type: "PostMessage", message, actor: member.id },
      { ...base, type: "EditMemoryItem", item: memory, actor: domainId.member("other") },
      { ...base, type: "EditMemoryItem", item: { ...memory, pinned: true }, actor: member.id },
      { ...base, type: "PinMemoryItem", memoryItemId: memory.id, pinned: true, actor: member.id },
      { ...base, type: "RemoveMemoryItem", memoryItemId: memory.id, actor: domainId.member("other") },
    ];
    for (const command of cases) expect(decide({ ...running, memory: [memory] }, command)).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("returns independent immutable event payloads", () => {
    const members = [{ ...member, responsibilities: ["Plan"] }];
    const decision = decide(draftRoom, { ...base, type: "ProposeTeam", actor: "user", members });
    members[0]!.responsibilities.push("Changed");
    expect(decision).toMatchObject({ ok: true, events: [{ members: [{ responsibilities: ["Plan"] }] }] });
    if (!decision.ok) throw new Error("Expected accepted decision");
    expect(Object.isFrozen(decision.events)).toBe(true);
    expect(Object.isFrozen(decision.events[0])).toBe(true);
  });

  it("persists pause intent immediately while rejecting archive during action execution", () => {
    const room: Room = { ...running, actions: [{ id: domainId.action("started"), roomId, runId, roundId: domainId.round("round-1"), memberId: member.id, position: 0, instruction: "Work", dependencies: [], idempotencyKey: "key", status: "started", errorCode: null, startedAt: draftRoom.createdAt, completedAt: null }] };
    expect(decide(room, { ...base, type: "PauseRun", actor: "user", reason: "Stop after current work" })).toEqual({ ok: true, events: [{ type: "RunPauseRequested", reason: "Stop after current work" }] });
    expect(decide(room, { ...base, type: "ArchiveRoom", actor: "user" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(decide({ ...room, actions: room.actions.map(action => ({ ...action, status: "succeeded" })) }, { ...base, type: "ArchiveRoom", actor: "user" })).toMatchObject({ ok: true, events: [{ type: "RoomArchived" }] });
  });
});
