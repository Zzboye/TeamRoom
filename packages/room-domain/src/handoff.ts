import type { ArtifactId, MessageId, RoomId } from "./ids.js";
import type { AcceptanceCriterionResult, CandidateResult, Room, RoomStatus } from "./model.js";
import { immutableCopy } from "./decide.js";

export interface HandoffDecision {
  readonly content: string;
  readonly messageIds: readonly MessageId[];
  /** Null for older snapshots that did not retain candidate event provenance. */
  readonly eventSequence: number | null;
}
export interface HandoffArtifact {
  readonly id: ArtifactId;
  /** CandidateProduced position where this reference was recorded, not artifact creation time. */
  readonly eventSequence: number | null;
}
export interface HandoffPackageV1 {
  readonly schemaVersion: 1;
  readonly roomId: RoomId;
  readonly title: string;
  readonly status: RoomStatus;
  readonly eventSequence: number;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly acceptanceChecklist: readonly AcceptanceCriterionResult[];
  readonly candidate: CandidateResult | null;
  readonly decisions: readonly HandoffDecision[];
  readonly sources: { readonly status: "not_collected_in_phase_1"; readonly entries: readonly never[]; readonly claimReferences: readonly never[] };
  readonly unresolvedIssues: readonly string[];
  readonly limitations: readonly string[];
  readonly nextActions: readonly string[];
  readonly artifacts: readonly HandoffArtifact[];
}

const bySequence = (a: { eventSequence: number | null }, b: { eventSequence: number | null }) => (a.eventSequence ?? Number.MAX_SAFE_INTEGER) - (b.eventSequence ?? Number.MAX_SAFE_INTEGER);

/** Pure projection of the current committed room. No transcript or invented sources. */
export function buildHandoff(room: Room): HandoffPackageV1 {
  const candidate = room.candidate;
  const eventSequence = room.candidateEventSequence ?? null;
  const nextActions: string[] = [];
  if (candidate && !candidate.acceptedAt) nextActions.push(`Review and accept candidate ${candidate.id}`);
  for (const action of room.actions.filter(item => ["planned", "started", "status_unknown", "failed"].includes(item.status)).sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    nextActions.push(`${action.status === "planned" ? "Continue" : "Review"} action ${action.id}: ${action.instruction}`);
  }
  for (const issue of candidate?.unresolvedIssues ?? []) nextActions.push(`Resolve: ${issue}`);
  if (nextActions.length === 0) nextActions.push(candidate?.acceptedAt ? "Use the accepted deliverable" : `Continue room ${room.id} from status ${room.status}`);
  return immutableCopy({ schemaVersion: 1, roomId: room.id, title: room.title, status: room.status, eventSequence: room.streamVersion,
    task: room.task, requirements: room.requirements, acceptanceCriteria: room.acceptanceCriteria,
    acceptanceChecklist: room.acceptanceCriteria.map(criterion => candidate?.checklist.find(item => item.criterion === criterion) ?? { criterion, satisfied: false, evidence: "Not evaluated" }),
    candidate, decisions: (candidate?.decisions ?? []).map(content => ({ content, messageIds: candidate!.messageIds, eventSequence })).sort(bySequence),
    sources: { status: "not_collected_in_phase_1", entries: [], claimReferences: [] },
    unresolvedIssues: candidate?.unresolvedIssues ?? [], limitations: ["Sources and claim references are not collected in Phase 1"], nextActions,
    artifacts: [...new Set(candidate?.artifactIds ?? [])].map(id => ({ id, eventSequence })).sort(bySequence),
  });
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]));
  return value;
}

/** Canonical key order at every nesting level, including candidate metadata. */
export function serializeHandoffJson(handoff: HandoffPackageV1): string { return `${JSON.stringify(stable(handoff), null, 2)}\n` }

export function renderHandoffMarkdown(handoff: HandoffPackageV1): string {
  const bullets = (items: readonly string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- None";
  return [`# ${handoff.title}`, `Room: ${handoff.roomId} | Event: ${handoff.eventSequence} | Status: ${handoff.status} | Schema: ${handoff.schemaVersion}`,
    "## Task", handoff.task, "## Requirements", bullets(handoff.requirements), "## Acceptance checklist",
    bullets(handoff.acceptanceChecklist.map(item => `[${item.satisfied ? "x" : " "}] ${item.criterion} — ${item.evidence}`)),
    "## Candidate", handoff.candidate ? `${handoff.candidate.id} (${handoff.candidate.acceptedAt ? "accepted" : "proposed"})\n\n${handoff.candidate.deliverable}` : "None",
    "## Decisions", bullets(handoff.decisions.map(item => `${item.content} (messages: ${item.messageIds.join(", ") || "none"}; event: ${item.eventSequence ?? "unknown"})`)),
    "## Sources", handoff.sources.status, "## Unresolved issues", bullets(handoff.unresolvedIssues),
    "## Limitations", bullets(handoff.limitations), "## Next actions", bullets(handoff.nextActions), "## Artifacts",
    bullets(handoff.artifacts.map(item => `${item.id} (event: ${item.eventSequence ?? "unknown"})`)), ""].join("\n\n");
}
