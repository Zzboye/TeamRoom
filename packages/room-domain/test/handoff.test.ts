import { expect, test } from "vitest";
import { buildHandoff, domainId, renderHandoffMarkdown, serializeHandoffJson, type Room } from "../src/index.js";
import { events, replay } from "./task3-fixtures.js";

function room(): Room {
  const base = replay();
  return { ...base, requirements: ["Concise"], candidateEventSequence: 9, streamVersion: 10,
    messages: [{ id: domainId.message("evidence"), roomId: base.id, authorType: "user", authorId: "user", type: "user", content: "PRIVATE FULL TRANSCRIPT", sequence: 1, createdAt: base.createdAt }],
    candidate: { id: domainId.candidate("candidate"), roomId: base.id, deliverable: "Launch plan", checklist: [{ criterion: "actionable", satisfied: true, evidence: "evidence" }], decisions: ["Launch in stages"], unresolvedIssues: ["Confirm budget"], messageIds: [domainId.message("evidence")], artifactIds: [domainId.artifact("plan.md")], sourceIds: [], createdAt: base.createdAt, acceptedAt: null } };
}

test("canonical handoff includes explicit source availability and traceable candidate references", () => {
  const handoff = buildHandoff(room());
  expect(handoff).toMatchObject({ schemaVersion: 1, roomId: "room-1", eventSequence: 10, task: "Plan launch", requirements: ["Concise"], acceptanceCriteria: ["actionable"], acceptanceChecklist: [{ criterion: "actionable", satisfied: true }], candidate: { id: "candidate", deliverable: "Launch plan" }, decisions: [{ content: "Launch in stages", messageIds: ["evidence"], eventSequence: 9 }], sources: { status: "not_collected_in_phase_1", entries: [], claimReferences: [] }, unresolvedIssues: ["Confirm budget"], artifacts: [{ id: "plan.md", eventSequence: 9 }] });
  expect(handoff.nextActions).toContain("Review and accept candidate candidate");
  const json = serializeHandoffJson(handoff);
  expect(json.endsWith("\n")).toBe(true);
  expect(JSON.parse(json)).toEqual(handoff);
  expect(serializeHandoffJson({ ...handoff, sources: { claimReferences: [], entries: [], status: "not_collected_in_phase_1" } })).toBe(json);
  expect(renderHandoffMarkdown(handoff)).toContain("evidence");
  expect(renderHandoffMarkdown(handoff)).toContain("not_collected_in_phase_1");
  expect(renderHandoffMarkdown(handoff)).not.toContain("PRIVATE FULL TRANSCRIPT");
});

test("rooms without candidates preserve unchecked criteria and pending action IDs", () => {
  const base = replay();
  const handoff = buildHandoff(base);
  expect(handoff.candidate).toBeNull();
  expect(handoff.acceptanceChecklist).toEqual([{ criterion: "actionable", satisfied: false, evidence: "Not evaluated" }]);
  expect(handoff.decisions).toEqual([]);
  expect(handoff.artifacts).toEqual([]);
  expect(handoff.nextActions.length).toBeGreaterThan(0);
});

test("replayed candidate provenance survives acceptance and uses the current handoff position", () => {
  const base = replay([...events, { type: "RunStarted", runId: domainId.run("run") }, { type: "ConvergenceChecked", converged: true },
    { type: "CandidateProduced", actor: "facilitator", candidate: { ...room().candidate!, unresolvedIssues: [] } }, { type: "CandidateAccepted", candidateId: room().candidate!.id }]);
  expect(base.candidateEventSequence).toBe(6);
  const handoff = buildHandoff(base);
  expect(handoff.eventSequence).toBe(7);
  expect(handoff.candidate?.acceptedAt).not.toBeNull();
  expect(handoff.nextActions).toEqual(["Use the accepted deliverable"]);
});

test("older snapshots expose unknown provenance without inventing an event position", () => {
  const { candidateEventSequence: _sequence, ...legacy } = room();
  const handoff = buildHandoff(legacy);
  expect(handoff.decisions[0]?.eventSequence).toBeNull();
  expect(handoff.artifacts[0]?.eventSequence).toBeNull();
});

test("handoff keeps candidate ordering for references from the same event and copies input", () => {
  const base = room();
  const candidate = { ...base.candidate!, decisions: ["Second", "First"], artifactIds: [domainId.artifact("z"), domainId.artifact("a"), domainId.artifact("z")] };
  const handoff = buildHandoff({ ...base, candidate });
  expect(handoff.decisions.map(item => item.content)).toEqual(["Second", "First"]);
  expect(handoff.artifacts.map(item => item.id)).toEqual(["z", "a"]);
  candidate.decisions.push("later");
  expect(handoff.candidate?.decisions).toEqual(["Second", "First"]);
  expect(Object.isFrozen(candidate)).toBe(false);
});

test("pending and uncertain actions retain their stable IDs in next actions", () => {
  const base = replay();
  const action = { id: domainId.action("action-pending"), roomId: base.id, runId: domainId.run("run"), roundId: domainId.round("round"), memberId: base.members[0]!.id, position: 0, instruction: "Write brief", dependencies: [], idempotencyKey: "intent", status: "planned" as const, errorCode: null, startedAt: null, completedAt: null };
  const handoff = buildHandoff({ ...base, actions: [action, { ...action, id: domainId.action("action-unknown"), position: 1, status: "status_unknown" }] });
  expect(handoff.nextActions).toEqual(["Continue action action-pending: Write brief", "Review action action-unknown: Write brief"]);
});
