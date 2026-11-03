import type {
  ActionId, ArtifactId, CandidateId, EventId, MemoryItemId, MessageId,
  PersonaTemplateId, RoomId, RoomMemberId, RoundId, RunId, SourceId, TeamTemplateId,
} from "./ids.js";
import { DomainError } from "./errors.js";
import type { DomainErrorCode } from "./errors.js";

export type RoomStatus =
  | "draft" | "team_review" | "ready" | "running" | "convergence_check"
  | "paused" | "awaiting_input" | "awaiting_approval" | "awaiting_acceptance"
  | "completed" | "archived";

export type BackgroundPolicy = "pause_on_leave" | "continue_on_leave";

export interface BudgetLimits {
  readonly maxRounds?: number;
  readonly maxActions?: number;
  readonly maxTokens?: number;
  readonly maxCost?: number;
}

export interface Usage {
  readonly rounds: number;
  readonly actions: number;
  readonly tokens: number;
  readonly cost: number;
}

export interface RoomMember {
  readonly id: RoomMemberId;
  readonly name: string;
  readonly role: string;
  readonly responsibilities: readonly string[];
  readonly domainPerspective: string;
  readonly communicationStyle: string;
  readonly constraints: readonly string[];
  readonly collaborationGuidance: readonly string[];
  readonly isFacilitator: boolean;
  readonly sourceTemplateId: PersonaTemplateId | null;
  readonly sourceTemplateVersion: number | null;
}

/** Reusable persona definition; room members retain only a copied snapshot. */
export interface PersonaTemplate extends Omit<RoomMember, "id" | "isFacilitator" | "sourceTemplateId" | "sourceTemplateVersion"> {
  readonly id: PersonaTemplateId;
  readonly version: number;
}
export interface TeamTemplate {
  readonly id: TeamTemplateId;
  readonly name: string;
  readonly version: number;
  readonly members: readonly { readonly memberId: RoomMemberId; readonly persona: PersonaTemplate; readonly isFacilitator: boolean }[];
}

export function snapshotTeam(template: TeamTemplate): readonly RoomMember[] {
  if (!Number.isSafeInteger(template.version) || template.version < 1 || template.members.length === 0 ||
    template.members.filter(entry => entry.isFacilitator).length !== 1 || new Set(template.members.map(entry => entry.memberId)).size !== template.members.length) {
    throw new DomainError("validation", "Invalid team template");
  }
  return Object.freeze(template.members.map(({ memberId, persona, isFacilitator }) => {
    if (!Number.isSafeInteger(persona.version) || persona.version < 1) throw new DomainError("validation", "Invalid persona template version");
    return Object.freeze({ id: memberId, name: persona.name, role: persona.role,
      responsibilities: Object.freeze([...persona.responsibilities]), domainPerspective: persona.domainPerspective,
      communicationStyle: persona.communicationStyle, constraints: Object.freeze([...persona.constraints]),
      collaborationGuidance: Object.freeze([...persona.collaborationGuidance]), isFacilitator,
      sourceTemplateId: persona.id, sourceTemplateVersion: persona.version });
  }));
}

export type MemoryKind = "goal" | "fact" | "judgment" | "assumption" | "task" | "completed";

export interface MemoryItem {
  readonly id: MemoryItemId;
  readonly roomId: RoomId;
  readonly memberId: RoomMemberId;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly provenance: readonly (MessageId | EventId)[];
  readonly confidence: number | null;
  readonly createdByEventId: EventId;
  readonly updatedByEventId: EventId;
  readonly pinned: boolean;
}

export function validMemoryItem(item: MemoryItem): boolean {
  return (["goal", "fact", "judgment", "assumption", "task", "completed"] as readonly string[]).includes(item.kind) &&
    item.content.trim().length > 0 &&
    item.provenance.every(id => typeof id === "string" && id.trim().length > 0) &&
    (item.confidence === null || (Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1)) &&
    (!["fact", "judgment", "assumption"].includes(item.kind) || (item.provenance.length > 0 && item.confidence !== null));
}

export type MessageLink = { readonly type: "mention"; readonly memberId: RoomMemberId } |
  { readonly type: "reply" | "quote"; readonly messageId: MessageId };
export interface LinkedMessage { readonly messageId: MessageId; readonly link: MessageLink }

export type MessageType =
  | "user" | "persona" | "facilitator" | "system_card" | "action_summary"
  | "approval_request" | "candidate_result" | "handoff";

export interface Message {
  readonly links?: readonly MessageLink[];
  readonly id: MessageId;
  readonly roomId: RoomId;
  readonly authorType: "user" | "persona" | "facilitator" | "system";
  readonly authorId: "user" | "system" | RoomMemberId;
  readonly content: string;
  readonly type: MessageType;
  readonly sequence: number;
  readonly createdAt: string;
}

export interface Run {
  readonly id: RunId;
  readonly roomId: RoomId;
  readonly status: "running" | "paused" | "completed";
  readonly roundIds: readonly RoundId[];
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export type ActionStatus = "planned" | "started" | "succeeded" | "failed" | "cancelled" | "status_unknown";

export interface Action {
  readonly id: ActionId;
  readonly roomId: RoomId;
  readonly runId: RunId;
  readonly roundId: RoundId;
  readonly memberId: RoomMemberId;
  readonly position: number;
  readonly instruction: string;
  readonly dependencies: readonly ActionId[];
  readonly idempotencyKey: string;
  readonly status: ActionStatus;
  readonly errorCode: DomainErrorCode | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface AcceptanceCriterionResult {
  readonly criterion: string;
  readonly satisfied: boolean;
  readonly evidence: string;
}

export interface CandidateResult {
  readonly id: CandidateId;
  readonly roomId: RoomId;
  readonly deliverable: string;
  readonly checklist: readonly AcceptanceCriterionResult[];
  readonly decisions: readonly string[];
  readonly unresolvedIssues: readonly string[];
  readonly messageIds: readonly MessageId[];
  readonly artifactIds: readonly ArtifactId[];
  readonly sourceIds: readonly SourceId[];
  readonly createdAt: string;
  readonly acceptedAt: string | null;
}

export interface Room {
  readonly id: RoomId;
  readonly title: string;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly status: RoomStatus;
  readonly backgroundPolicy: BackgroundPolicy;
  readonly budget: BudgetLimits | null;
  readonly usage: Usage;
  readonly members: readonly RoomMember[];
  readonly teamConfirmed: boolean;
  readonly messages: readonly Message[];
  /** Missing in older snapshots means no links. */
  readonly messageLinks?: readonly LinkedMessage[];
  readonly memory: readonly MemoryItem[];
  readonly latestMessageSequence: number;
  readonly activeRun: Run | null;
  readonly actions: readonly Action[];
  /** Missing in older snapshots means false. True while started actions drain. */
  readonly pauseRequested?: boolean;
  readonly candidate: CandidateResult | null;
  /** CandidateProduced event position; absent in older Room v1 snapshots. */
  readonly candidateEventSequence?: number;
  readonly workspaceRef: string | null;
  readonly hostRef: string | null;
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly archivedAt: string | null;
}

export interface InitialRoomInput {
  readonly id: RoomId;
  readonly title: string;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly backgroundPolicy: BackgroundPolicy;
  readonly budget?: BudgetLimits;
  readonly createdAt: string;
}

export function initialRoom(input: InitialRoomInput): Room {
  return Object.freeze({
    id: input.id,
    title: input.title,
    task: input.task,
    requirements: Object.freeze([...input.requirements]),
    acceptanceCriteria: Object.freeze([...input.acceptanceCriteria]),
    status: "draft",
    backgroundPolicy: input.backgroundPolicy,
    budget: input.budget === undefined ? null : Object.freeze({ ...input.budget }),
    usage: Object.freeze({ rounds: 0, actions: 0, tokens: 0, cost: 0 }),
    members: Object.freeze([]),
    teamConfirmed: false,
    messages: Object.freeze([]),
    messageLinks: Object.freeze([]),
    memory: Object.freeze([]),
    latestMessageSequence: 0,
    activeRun: null,
    actions: Object.freeze([]),
    pauseRequested: false,
    candidate: null,
    workspaceRef: null,
    hostRef: null,
    streamVersion: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: null,
    archivedAt: null,
  });
}
