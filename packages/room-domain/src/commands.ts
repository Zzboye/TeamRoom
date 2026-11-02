import type { ActionId, CandidateId, CommandId, HandoffId, MemoryItemId, RoomId, RoomMemberId, RunId } from "./ids.js";
import type { InitialRoomInput, MemoryItem, Message, RoomMember } from "./model.js";

export type CommandActor = "user" | "facilitator" | RoomMemberId;
export interface CommandMetadata { readonly commandId: CommandId; readonly roomId: RoomId; readonly expectedVersion: number }
interface UserCommand extends CommandMetadata { readonly actor: CommandActor }
export interface CreateRoom extends Omit<InitialRoomInput, "id" | "createdAt">, CommandMetadata { readonly type: "CreateRoom"; readonly expectedVersion: 0 }
export interface ProposeTeam extends UserCommand { readonly type: "ProposeTeam"; readonly members: readonly RoomMember[] }
export interface ConfirmTeam extends UserCommand { readonly type: "ConfirmTeam" }
export interface StartRun extends CommandMetadata { readonly type: "StartRun"; readonly runId: RunId }
export interface PostMessage extends UserCommand { readonly type: "PostMessage"; readonly message: Message }
export interface PauseRun extends UserCommand { readonly type: "PauseRun"; readonly reason: string }
export interface ResumeRun extends UserCommand { readonly type: "ResumeRun" }
export interface ApproveAction extends UserCommand { readonly type: "ApproveAction"; readonly actionId: ActionId }
export interface RejectAction extends UserCommand { readonly type: "RejectAction"; readonly actionId: ActionId; readonly reason: string }
export interface ProvideRequestedInput extends UserCommand { readonly type: "ProvideRequestedInput"; readonly message: Message }
export interface EditMemoryItem extends UserCommand { readonly type: "EditMemoryItem"; readonly item: MemoryItem }
export interface PinMemoryItem extends UserCommand { readonly type: "PinMemoryItem"; readonly memoryItemId: MemoryItemId; readonly pinned: boolean }
export interface RemoveMemoryItem extends UserCommand { readonly type: "RemoveMemoryItem"; readonly memoryItemId: MemoryItemId }
export interface AcceptCandidate extends UserCommand { readonly type: "AcceptCandidate"; readonly candidateId: CandidateId }
export interface RejectCandidate extends UserCommand { readonly type: "RejectCandidate"; readonly candidateId: CandidateId; readonly reason: string }
export interface GenerateHandoff extends UserCommand { readonly type: "GenerateHandoff"; readonly handoffId: HandoffId }
export interface ArchiveRoom extends UserCommand { readonly type: "ArchiveRoom" }

export type RoomCommand = CreateRoom | ProposeTeam | ConfirmTeam | StartRun | PostMessage | PauseRun | ResumeRun | ApproveAction | RejectAction | ProvideRequestedInput | EditMemoryItem | PinMemoryItem | RemoveMemoryItem | AcceptCandidate | RejectCandidate | GenerateHandoff | ArchiveRoom;
