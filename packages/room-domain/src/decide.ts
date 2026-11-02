import { DomainError } from "./errors.js";
import type { RoomCommand } from "./commands.js";
import type { NewRoomEvent } from "./events.js";
import type { Room, RoomStatus } from "./model.js";

export type Decision = { readonly ok: true; readonly events: readonly NewRoomEvent[] } | { readonly ok: false; readonly error: DomainError };

/** Copy before freezing: neither decisions nor replay retain caller-owned mutable payloads. */
export function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(item => immutableCopy(item))) as T;
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableCopy(item)]))) as T;
  }
  return value;
}

function requireValid(condition: boolean, message: string): asserts condition {
  if (!condition) throw new DomainError("validation", message);
}

const mutableStates: readonly RoomStatus[] = ["draft", "team_review", "ready", "running", "convergence_check", "paused", "awaiting_input", "awaiting_approval", "awaiting_acceptance", "completed"];
const sources: Record<Exclude<RoomCommand["type"], "CreateRoom">, readonly RoomStatus[]> = {
  ProposeTeam: ["draft", "team_review"], ConfirmTeam: ["team_review"], StartRun: ["ready"],
  PostMessage: mutableStates, PauseRun: ["running", "convergence_check"], ResumeRun: ["paused"],
  ApproveAction: ["awaiting_approval"], RejectAction: ["awaiting_approval"], ProvideRequestedInput: ["awaiting_input"],
  EditMemoryItem: mutableStates, PinMemoryItem: mutableStates, RemoveMemoryItem: mutableStates,
  AcceptCandidate: ["awaiting_acceptance"], RejectCandidate: ["awaiting_acceptance"], GenerateHandoff: mutableStates, ArchiveRoom: mutableStates,
};

export function decide(room: Room | null, command: RoomCommand): Decision {
  try {
    const events = decideEvents(room, command);
    return Object.freeze({ ok: true, events: immutableCopy(events) });
  } catch (error) {
    if (error instanceof DomainError) return Object.freeze({ ok: false, error });
    throw error;
  }
}

function decideEvents(room: Room | null, command: RoomCommand): readonly NewRoomEvent[] {
  if (command.type === "CreateRoom") {
    requireValid(room === null, "Room already exists");
    requireValid(command.expectedVersion === 0, "CreateRoom requires version zero");
    requireValid(command.title.trim().length > 0 && command.task.trim().length > 0, "Title and task are required");
    const { commandId: _commandId, roomId: _roomId, expectedVersion: _expectedVersion, type: _type, ...input } = command;
    return [{ type: "RoomCreated", ...input }];
  }
  requireValid(room !== null, "Room does not exist");
  requireValid(room.id === command.roomId, "Command targets another room");
  if (room.streamVersion !== command.expectedVersion) throw new DomainError("conflict", "Stale room stream version");
  requireValid(sources[command.type].includes(room.status), `${command.type} is not legal in ${room.status}`);
  const userOnly = () => requireValid("actor" in command && command.actor === "user", "Only the user may perform this command");
  switch (command.type) {
    case "ProposeTeam":
      requireValid(command.actor === "user" || command.actor === "facilitator", "Only user or facilitator may propose a team");
      requireValid(command.members.length > 0 && command.members.filter(member => member.isFacilitator).length === 1, "Team needs exactly one facilitator");
      requireValid(new Set(command.members.map(member => member.id)).size === command.members.length, "Duplicate team member");
      return [{ type: "TeamProposed", members: command.members }];
    case "ConfirmTeam":
      userOnly();
      requireValid(room.members.length > 0 && room.members.filter(member => member.isFacilitator).length === 1, "A proposed team is required");
      return [{ type: "TeamConfirmed" }];
    case "StartRun":
      requireValid(room.teamConfirmed, "Team must be confirmed before starting");
      return [{ type: "RunStarted", runId: command.runId }];
    case "PostMessage": {
      const message = command.message;
      requireValid(message.roomId === room.id && message.content.trim().length > 0 && message.sequence === room.latestMessageSequence + 1, "Invalid message");
      requireValid(!room.messages.some(existing => existing.id === message.id), "Duplicate message");
      requireValid((command.actor === "user" && message.authorType === "user" && message.authorId === "user") ||
        (command.actor === "facilitator" && message.authorType === "facilitator" && room.members.some(member => member.id === message.authorId && member.isFacilitator)) ||
        (room.members.some(member => member.id === command.actor) && message.authorId === command.actor && (message.authorType === "persona" || (message.authorType === "facilitator" && room.members.some(member => member.id === command.actor && member.isFacilitator)))), "Message author does not match actor");
      return [{ type: "MessagePosted", message }];
    }
    case "PauseRun":
      requireValid(command.actor === "user" || command.actor === "facilitator", "Only user or facilitator may pause");
      requireValid(room.activeRun !== null, "No active run");
      return [{ type: room.actions.some(action => action.status === "started") ? "RunPauseRequested" : "RunPaused", reason: command.reason }];
    case "ResumeRun":
      userOnly();
      requireValid(room.activeRun !== null, "No run to resume");
      return [{ type: "RunResumed" }];
    case "ApproveAction": case "RejectAction":
      userOnly();
      requireValid(room.activeRun !== null, "No active run");
      requireValid(room.actions.some(action => action.id === command.actionId && action.status === "planned"), "No pending action");
      return command.type === "ApproveAction" ? [{ type: "ActionApproved", actionId: command.actionId }] : [{ type: "ActionRejected", actionId: command.actionId, reason: command.reason }];
    case "ProvideRequestedInput": {
      userOnly();
      requireValid(room.activeRun !== null, "No active run");
      const result = decideEvents(room, { ...command, type: "PostMessage" });
      const posted = result[0];
      requireValid(posted?.type === "MessagePosted", "Expected a message");
      return [{ type: "InputProvided", message: posted.message }];
    }
    case "EditMemoryItem": {
      const existing = room.memory.find(item => item.id === command.item.id);
      requireValid(command.item.roomId === room.id && room.members.some(member => member.id === command.item.memberId), "Invalid memory owner");
      requireValid(existing === undefined || existing.memberId === command.item.memberId, "Cannot transfer memory ownership");
      requireValid(command.actor === "user" || command.actor === command.item.memberId, "Cannot edit another member's memory");
      requireValid(existing === undefined || command.actor === "user" || existing.pinned === command.item.pinned, "Only user may pin memory");
      requireValid(command.actor === "user" || !command.item.pinned || existing?.pinned === true, "Only user may pin memory");
      return [{ type: "MemoryUpdated", memoryItemId: command.item.id, item: command.item }];
    }
    case "PinMemoryItem": case "RemoveMemoryItem": {
      userOnly();
      const item = room.memory.find(item => item.id === command.memoryItemId);
      requireValid(item !== undefined, "Memory item does not exist");
      return [{ type: "MemoryUpdated", memoryItemId: item.id, item: command.type === "RemoveMemoryItem" ? null : { ...item, pinned: command.pinned } }];
    }
    case "AcceptCandidate": case "RejectCandidate":
      userOnly();
      requireValid(room.candidate !== null && room.candidate.id === command.candidateId, "Candidate does not exist");
      requireValid(room.activeRun !== null, "No active run");
      return command.type === "AcceptCandidate" ? [{ type: "CandidateAccepted", candidateId: command.candidateId }] : [{ type: "CandidateRejected", candidateId: command.candidateId, reason: command.reason }];
    case "GenerateHandoff":
      userOnly();
      return [{ type: "HandoffGenerated", handoffId: command.handoffId }];
    case "ArchiveRoom":
      userOnly();
      requireValid(!room.actions.some(action => action.status === "started") && !room.pauseRequested, "Archive requires a safe boundary");
      return [{ type: "RoomArchived" }];
  }
}
