import type { ActionId, CommandId, EventId, HandoffId, MemoryItemId, MessageId, RoomId, RoomMemberId, RoundId, RunId, CandidateId } from "./ids.js";
import type { Action, CandidateResult, InitialRoomInput, MemoryItem, Message, MessageLink, RoomMember, Usage } from "./model.js";

export interface RoomCreated extends Omit<InitialRoomInput, "id" | "createdAt"> { readonly type: "RoomCreated" }
export interface TeamProposed { readonly type: "TeamProposed"; readonly members: readonly RoomMember[] }
export interface TeamConfirmed { readonly type: "TeamConfirmed" }
export interface MessagePosted { readonly type: "MessagePosted"; readonly message: Message }
export interface RoomMemberEdited { readonly type: "RoomMemberEdited"; readonly member: RoomMember }
export interface MessageLinked { readonly type: "MessageLinked"; readonly messageId: MessageId; readonly link: MessageLink }
export interface MemoryUpdated { readonly type: "MemoryUpdated"; readonly memoryItemId: MemoryItemId; readonly item: MemoryItem | null }
export interface RunStarted { readonly type: "RunStarted"; readonly runId: RunId }
export interface RunResumed { readonly type: "RunResumed" }
export interface RoundPlanned { readonly type: "RoundPlanned"; readonly roundId: RoundId; readonly actions: readonly Action[] }
export interface ActionStarted { readonly type: "ActionStarted"; readonly actionId: ActionId }
export interface ActionCompleted { readonly type: "ActionCompleted"; readonly actionId: ActionId; readonly status: Extract<Action["status"], "succeeded" | "failed" | "cancelled" | "status_unknown">; readonly errorCode: Action["errorCode"]; readonly usage: Usage }
export interface RunPaused { readonly type: "RunPaused"; readonly reason: string }
export interface RunPauseRequested { readonly type: "RunPauseRequested"; readonly reason: string }
export interface InputRequested { readonly type: "InputRequested"; readonly prompt: string }
export interface InputProvided { readonly type: "InputProvided"; readonly message: Message }
export interface ApprovalRequested { readonly type: "ApprovalRequested"; readonly actionId: ActionId }
export interface ActionApproved { readonly type: "ActionApproved"; readonly actionId: ActionId }
export interface ActionRejected { readonly type: "ActionRejected"; readonly actionId: ActionId; readonly reason: string }
export interface ConvergenceChecked { readonly type: "ConvergenceChecked"; readonly converged: boolean }
export interface WaveEvaluated { readonly type: "WaveEvaluated"; readonly roundId: RoundId }
export interface CandidateProduced { readonly type: "CandidateProduced"; readonly actor: "facilitator" | "user" | RoomMemberId; readonly candidate: CandidateResult }
export interface CandidateAccepted { readonly type: "CandidateAccepted"; readonly candidateId: CandidateId }
export interface CandidateRejected { readonly type: "CandidateRejected"; readonly candidateId: CandidateId; readonly reason: string }
export interface HandoffGenerated { readonly type: "HandoffGenerated"; readonly handoffId: HandoffId }
export interface RoomArchived { readonly type: "RoomArchived" }

export type RoomEvent = RoomCreated | TeamProposed | RoomMemberEdited | TeamConfirmed | MessagePosted | MessageLinked | MemoryUpdated | RunStarted | RunResumed | RoundPlanned | ActionStarted | ActionCompleted | RunPaused | RunPauseRequested | InputRequested | InputProvided | ApprovalRequested | ActionApproved | ActionRejected | WaveEvaluated | ConvergenceChecked | CandidateProduced | CandidateAccepted | CandidateRejected | HandoffGenerated | RoomArchived;

/** An event payload awaiting persistence metadata from the application/store boundary. */
export type NewRoomEvent = RoomEvent;

export interface EventEnvelope<E extends RoomEvent = RoomEvent> {
  readonly eventId: EventId;
  readonly roomId: RoomId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly causationId: CommandId | ActionId;
  readonly schemaVersion: 1;
  readonly event: E;
}
