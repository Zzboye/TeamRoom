import type { RoomId } from "@teamroom/room-domain";
import type { RoomSnapshot } from "@teamroom/room-engine";

type RecordValue = Record<string, unknown>;
type Check = (value: unknown) => boolean;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const string: Check = value => typeof value === "string";
const id: Check = value => typeof value === "string" && value.trim().length > 0;
const boolean: Check = value => typeof value === "boolean";
const integer: Check = value => Number.isSafeInteger(value) && (value as number) >= 0;
const positive: Check = value => integer(value) && (value as number) > 0;
const finite: Check = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp: Check = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullable = (check: Check): Check => value => value === null || check(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const oneOf = (...values: readonly string[]): Check => value => typeof value === "string" && values.includes(value);
const shape = (value: unknown, fields: Readonly<Record<string, Check>>): value is RecordValue => object(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
const optional = (value: RecordValue, key: string, check: Check) => value[key] === undefined || check(value[key]);
const strings = array(string);
const ids = array(id);
const usage: Check = value => shape(value, { rounds: integer, actions: integer, tokens: integer, cost: finite });
const errorCode = nullable(oneOf("validation", "conflict", "retryable_adapter", "permanent_adapter", "timeout", "approval_required", "budget_exhausted", "corrupt_data", "status_unknown"));
const budget: Check = value => object(value) && optional(value, "maxRounds", integer) && optional(value, "maxActions", integer) && optional(value, "maxTokens", integer) && optional(value, "maxCost", finite);
const member: Check = value => shape(value, {
  id, name: string, role: string, responsibilities: strings, domainPerspective: string,
  communicationStyle: string, constraints: strings, collaborationGuidance: strings,
  isFacilitator: boolean, sourceTemplateId: nullable(id), sourceTemplateVersion: nullable(positive),
});
const link: Check = value => object(value) && (value.type === "mention" ? id(value.memberId) : (value.type === "reply" || value.type === "quote") && id(value.messageId));
const message: Check = value => shape(value, {
  id, roomId: id, authorType: oneOf("user", "persona", "facilitator", "system"), authorId: id,
  content: string, type: oneOf("user", "persona", "facilitator", "system_card", "action_summary", "approval_request", "candidate_result", "handoff"),
  sequence: positive, createdAt: timestamp,
}) && optional(value, "links", array(link));
const memory: Check = value => shape(value, {
  id, roomId: id, memberId: id, kind: oneOf("goal", "fact", "judgment", "assumption", "task", "completed"), content: string,
  provenance: ids, confidence: value => value === null || finite(value) && (value as number) <= 1,
  createdByEventId: id, updatedByEventId: id, pinned: boolean,
});
const run: Check = value => shape(value, { id, roomId: id, status: oneOf("running", "paused", "completed"), roundIds: ids, startedAt: timestamp, completedAt: nullable(timestamp) });
const action: Check = value => shape(value, {
  id, roomId: id, runId: id, roundId: id, memberId: id, position: integer, instruction: string,
  dependencies: ids, idempotencyKey: id, status: oneOf("planned", "started", "succeeded", "failed", "cancelled", "status_unknown"),
  errorCode,
  startedAt: nullable(timestamp), completedAt: nullable(timestamp),
});
const candidate: Check = value => shape(value, {
  id, roomId: id, deliverable: string,
  checklist: array(value => shape(value, { criterion: string, satisfied: boolean, evidence: string })),
  decisions: strings, unresolvedIssues: strings, messageIds: ids, artifactIds: ids, sourceIds: ids,
  createdAt: timestamp, acceptedAt: nullable(timestamp),
});
const pendingEvaluation: Check = value => shape(value, {
  roundId: id, actionIds: ids,
  outcomes: array(value => shape(value, { actionId: id, status: oneOf("succeeded", "failed", "cancelled", "status_unknown"), errorCode, usage })),
});
const room: Check = value => shape(value, {
  id, title: string, task: string, requirements: strings, acceptanceCriteria: strings,
  status: oneOf("draft", "team_review", "ready", "running", "convergence_check", "paused", "awaiting_input", "awaiting_approval", "awaiting_acceptance", "completed", "archived"),
  backgroundPolicy: oneOf("pause_on_leave", "continue_on_leave"), budget: nullable(budget), usage,
  members: array(member), teamConfirmed: boolean, messages: array(message), memory: array(memory),
  latestMessageSequence: integer, activeRun: nullable(run), actions: array(action), candidate: nullable(candidate),
  workspaceRef: nullable(string), hostRef: nullable(string), streamVersion: positive,
  createdAt: timestamp, updatedAt: timestamp, completedAt: nullable(timestamp), archivedAt: nullable(timestamp),
}) && optional(value, "messageLinks", array(value => shape(value, { messageId: id, link }))) && optional(value, "pauseRequested", boolean) && optional(value, "candidateEventSequence", positive) && optional(value, "pendingEvaluation", nullable(pendingEvaluation)) && optional(value, "pendingApprovalActionId", nullable(id));

/** Every required and nested Room v1 field is checked before trusting cache data. */
export function validSnapshot(value: unknown, roomId: RoomId, sequence: number): value is RoomSnapshot {
  return shape(value, { schemaVersion: value => value === 1, roomId: id, sequence: positive, room }) &&
    value.roomId === roomId && value.sequence === sequence && object(value.room) && value.room.id === roomId && value.room.streamVersion === sequence;
}
