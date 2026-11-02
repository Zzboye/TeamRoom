import type {
  Action, ActionId, ArtifactId, CandidateResult, MemoryItem, Message, Room, RoomId, Usage,
} from "@teamroom/room-domain";

/** Stable caller-provided keys identify scripted operations, including retry attempts. */
export interface PlanInput { readonly room: Room; readonly callKey: string }
export interface FacilitatorPlan { readonly actions: readonly Action[] }
export interface ConvergenceInput { readonly room: Room; readonly callKey: string }
export type ConvergenceDecision =
  | { readonly type: "continue"; readonly reason: string }
  | { readonly type: "request_input"; readonly question: string }
  | { readonly type: "request_approval"; readonly actionId: ActionId; readonly reason: string }
  | { readonly type: "pause"; readonly reason: string }
  | { readonly type: "candidate"; readonly candidate: CandidateResult };
export interface PersonaActionInput {
  readonly room: Room;
  readonly action: Action;
  readonly memory: readonly MemoryItem[];
  readonly callKey: string;
}
export interface PersonaActionResult {
  readonly messages: readonly Message[];
  readonly memoryProposals: readonly MemoryItem[];
  readonly usage: UsageDelta;
}
export interface ToolRequest {
  readonly roomId: RoomId;
  readonly actionId: ActionId;
  readonly idempotencyKey: string;
  readonly callKey: string;
  readonly tool: string;
  readonly input: string;
}
export type ToolResult =
  | { readonly status: "succeeded"; readonly output: string; readonly artifactIds: readonly ArtifactId[]; readonly usage: UsageDelta }
  | { readonly status: "retryable_failure" | "permanent_failure" | "approval_required" | "timeout" | "status_unknown"; readonly reason: string };
export type ToolReconciliation =
  | { readonly status: "succeeded"; readonly output: string; readonly artifactIds: readonly ArtifactId[]; readonly usage: UsageDelta }
  | { readonly status: "not_started" | "failed" | "status_unknown"; readonly reason: string };
export type IdKind = "room" | "member" | "memoryItem" | "message" | "run" | "round" | "action" | "candidate" | "event" | "command" | "personaTemplate" | "teamTemplate" | "artifact" | "source" | "handoff";
export interface ArtifactWrite { readonly roomId: RoomId; readonly name: string; readonly mediaType: string; readonly content: string }
export interface ArtifactRef { readonly id: ArtifactId; readonly roomId: RoomId; readonly name: string; readonly mediaType: string; readonly createdAt: string }
export interface ArtifactRead extends ArtifactRef { readonly content: string }
export type UsageDelta = Partial<Usage>;
export interface RoomNotification { readonly roomId: RoomId; readonly type: string; readonly message: string }

export interface FacilitatorPort {
  plan(input: PlanInput): Promise<FacilitatorPlan>;
  evaluate(input: ConvergenceInput): Promise<ConvergenceDecision>;
}
export interface PersonaPort { act(input: PersonaActionInput): Promise<PersonaActionResult> }
export interface ToolPort {
  execute(input: ToolRequest): Promise<ToolResult>;
  reconcile(actionId: ActionId, idempotencyKey: string): Promise<ToolReconciliation>;
}
export interface ClockPort { now(): string }
export interface IdPort { next(kind: IdKind): string }
export interface ArtifactPort {
  put(input: ArtifactWrite): Promise<ArtifactRef>;
  get(id: ArtifactId): Promise<ArtifactRead | null>;
}
export interface UsagePort {
  current(roomId: RoomId): Promise<Usage>;
  charge(roomId: RoomId, delta: UsageDelta): Promise<Usage>;
}
export interface NotificationPort { publish(notification: RoomNotification): Promise<void> }
