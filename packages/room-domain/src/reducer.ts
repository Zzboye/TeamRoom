import { DomainError } from "./errors.js";
import { immutableCopy } from "./decide.js";
import type { EventEnvelope, NewRoomEvent } from "./events.js";
import { routeMessage, validateMessageLink } from "./routing.js";
import { initialRoom, validMemoryItem, type Action, type Room, type RoomStatus } from "./model.js";

const transitions: Readonly<Record<RoomStatus, readonly RoomStatus[]>> = {
  draft: ["team_review", "archived"], team_review: ["ready", "archived"], ready: ["running", "archived"],
  running: ["convergence_check", "paused", "awaiting_input", "awaiting_approval", "archived"],
  convergence_check: ["running", "paused", "awaiting_input", "awaiting_approval", "awaiting_acceptance", "archived"],
  paused: ["running", "archived"], awaiting_input: ["running", "archived"], awaiting_approval: ["running", "archived"],
  awaiting_acceptance: ["running", "completed", "archived"], completed: ["archived"], archived: [],
};

export function assertTransition(from: RoomStatus, to: RoomStatus): void {
  if (!transitions[from].includes(to)) throw new DomainError("validation", `Illegal room transition: ${from} -> ${to}`);
}

function valid(condition: boolean, message: string): asserts condition {
  if (!condition) throw new DomainError("corrupt_data", message);
}

/** Admission rule only: historical v1 streams must remain replayable for recovery. */
export function assertEventSafeBoundary(room: Room | null, event: NewRoomEvent): void {
  if (room?.actions.some(action => action.status === "started") && ["InputRequested", "InputProvided", "ApprovalRequested", "ActionApproved", "ActionRejected", "ConvergenceChecked", "CandidateProduced", "CandidateAccepted", "CandidateRejected"].includes(event.type)) throw new DomainError("validation", `${event.type} requires all started actions to drain`);
}

const legacyStableStates: readonly RoomStatus[] = ["awaiting_input", "awaiting_approval", "awaiting_acceptance", "completed"];

export function reduceRoom(room: Room | null, envelope: EventEnvelope): Room {
  const { event, sequence, occurredAt } = envelope;
  valid(envelope.schemaVersion === 1, "Unsupported event schema");
  valid(Number.isSafeInteger(sequence) && sequence === (room?.streamVersion ?? 0) + 1, "Non-contiguous event sequence");
  if (room === null) {
    valid(event.type === "RoomCreated", "Stream must begin with RoomCreated");
    return immutableCopy({ ...initialRoom({ ...event, id: envelope.roomId, createdAt: occurredAt }), streamVersion: sequence });
  }
  valid(room.id === envelope.roomId, "Event belongs to another room");
  valid(event.type !== "RoomCreated", "Duplicate RoomCreated");
  valid(room.status !== "archived", "Archived room cannot change");
  let next: Room = { ...room, pauseRequested: room.pauseRequested ?? false, streamVersion: sequence, updatedAt: occurredAt };
  const requireState = (...states: readonly RoomStatus[]) => valid(states.includes(room.status), `${event.type} is invalid in ${room.status}`);
  const move = (status: RoomStatus) => {
    valid(!room.pauseRequested || status === "paused", "Pause request must drain before leaving execution");
    try { assertTransition(room.status, status); } catch { throw new DomainError("corrupt_data", `Invalid event transition: ${room.status} -> ${status}`); }
    next = { ...next, status };
  };
  const updateAction = (id: Action["id"], update: (action: Action) => Action) => {
    valid(room.actions.some(action => action.id === id), "Unknown action");
    next = { ...next, actions: next.actions.map(action => action.id === id ? update(action) : action) };
  };
  const resume = () => {
    valid(room.activeRun !== null, "No active run");
    move("running");
    next = { ...next, activeRun: { ...room.activeRun, status: "running" } };
  };
  const appendMessage = (message: Room["messages"][number]) => {
    try { routeMessage(room, message); } catch { throw new DomainError("corrupt_data", "Invalid message links"); }
    valid(message.roomId === room.id && message.sequence === room.latestMessageSequence + 1 && !room.messages.some(item => item.id === message.id), "Invalid message sequence or identity");
    next = { ...next, messages: [...room.messages, message], messageLinks: [...(room.messageLinks ?? []), ...(message.links ?? []).map(link => ({ messageId: message.id, link }))], latestMessageSequence: message.sequence };
  };
  switch (event.type) {
    case "TeamProposed":
      requireState("draft", "team_review");
      valid(event.members.length > 0 && event.members.filter(member => member.isFacilitator).length === 1 && new Set(event.members.map(member => member.id)).size === event.members.length, "Invalid team");
      if (room.status === "draft") move("team_review");
      next = { ...next, members: event.members, teamConfirmed: false };
      break;
    case "RoomMemberEdited": {
      const previous = room.members.find(member => member.id === event.member.id);
      valid(previous !== undefined && previous.sourceTemplateId === event.member.sourceTemplateId && previous.sourceTemplateVersion === event.member.sourceTemplateVersion && previous.isFacilitator === event.member.isFacilitator, "Invalid member edit");
      next = { ...next, members: room.members.map(member => member.id === event.member.id ? event.member : member) };
      break;
    }
    case "TeamConfirmed":
      valid(room.members.length > 0 && room.members.filter(member => member.isFacilitator).length === 1, "Missing proposed team");
      move("ready");
      next = { ...next, teamConfirmed: true };
      break;
    case "MessagePosted": appendMessage(event.message); break;
    case "MessageLinked": {
      const link = event.link;
      valid(room.messages.some(message => message.id === event.messageId), "Missing linked message");
      try { validateMessageLink(room, link); } catch { throw new DomainError("corrupt_data", "Invalid message link"); }
      next = { ...next, messageLinks: [...(room.messageLinks ?? []), { messageId: event.messageId, link }] };
      break;
    }
    case "MemoryUpdated": {
      const previous = room.memory.find(item => item.id === event.memoryItemId);
      if (event.item === null) {
        valid(previous !== undefined, "Missing memory item");
        next = { ...next, memory: room.memory.filter(item => item.id !== event.memoryItemId) };
      } else {
        valid(validMemoryItem(event.item), "Invalid memory content, provenance, kind or confidence");
        valid(event.item.id === event.memoryItemId && event.item.roomId === room.id && room.members.some(member => member.id === event.item?.memberId), "Invalid memory item");
        valid(previous === undefined || previous.memberId === event.item.memberId, "Memory ownership changed");
        const item = { ...event.item, createdByEventId: previous?.createdByEventId ?? envelope.eventId, updatedByEventId: envelope.eventId };
        next = { ...next, memory: previous === undefined ? [...room.memory, item] : room.memory.map(existing => existing.id === item.id ? item : existing) };
      }
      break;
    }
    case "RunStarted":
      requireState("ready");
      valid(room.teamConfirmed && room.activeRun === null, "Cannot start run without confirmed team");
      move("running");
      next = { ...next, activeRun: { id: event.runId, roomId: room.id, status: "running", roundIds: [], startedAt: occurredAt, completedAt: null } };
      break;
    case "RunResumed": requireState("paused"); resume(); break;
    case "RoundPlanned": {
      requireState("running", "convergence_check");
      valid(!room.pauseRequested, "Cannot plan a round while pause is requested");
      if (room.status === "convergence_check") move("running");
      const run = room.activeRun;
      valid(run !== null && !run.roundIds.includes(event.roundId), "Invalid round");
      const ids = new Set(room.actions.map(action => action.id));
      for (const action of event.actions) {
        valid(!ids.has(action.id) && action.roomId === room.id && action.runId === run.id && action.roundId === event.roundId && action.status === "planned" && room.members.some(member => member.id === action.memberId), "Invalid planned action");
        ids.add(action.id);
      }
      next = { ...next, activeRun: { ...run, roundIds: [...run.roundIds, event.roundId] }, actions: [...room.actions, ...event.actions], usage: { ...room.usage, rounds: room.usage.rounds + 1 } };
      break;
    }
    case "ActionStarted":
      requireState("running");
      valid(!room.pauseRequested, "Cannot start an action while pause is requested");
      updateAction(event.actionId, action => {
        valid(action.status === "planned" && action.dependencies.every(id => room.actions.some(dependency => dependency.id === id && dependency.status === "succeeded")), "Action cannot start");
        return { ...action, status: "started", startedAt: occurredAt };
      });
      break;
    case "ActionCompleted":
      requireState("running", "convergence_check", ...legacyStableStates);
      updateAction(event.actionId, action => {
        valid(action.status === "started", "Action was not started");
        return { ...action, status: event.status, errorCode: event.errorCode, completedAt: occurredAt };
      });
      valid(Object.values(event.usage).every(value => Number.isFinite(value) && value >= 0), "Invalid usage");
      next = { ...next, usage: { rounds: room.usage.rounds + event.usage.rounds, actions: room.usage.actions + event.usage.actions, tokens: room.usage.tokens + event.usage.tokens, cost: room.usage.cost + event.usage.cost } };
      if (room.pauseRequested && !next.actions.some(action => action.status === "started")) {
        valid(room.activeRun !== null, "No run to pause");
        // Legacy v1 streams could enter stable states with started actions.
        // Recovery alone may drain those states to paused; normal lifecycle
        // edges (including completed -> archived) remain unchanged.
        if (legacyStableStates.includes(room.status)) next = { ...next, status: "paused" };
        else move("paused");
        next = { ...next, pauseRequested: false, activeRun: { ...room.activeRun, status: "paused" } };
      }
      break;
    case "RunPauseRequested":
      requireState("running", "convergence_check", ...legacyStableStates);
      valid(room.activeRun !== null && room.actions.some(action => action.status === "started"), "Pause request requires executing actions");
      next = { ...next, pauseRequested: true };
      break;
    case "RunPaused":
      requireState("running", "convergence_check");
      valid(room.activeRun !== null, "No run to pause");
      valid(!room.actions.some(action => action.status === "started"), "Pause requires a safe boundary");
      move("paused");
      next = { ...next, pauseRequested: false, activeRun: { ...room.activeRun, status: "paused" } };
      break;
    case "InputRequested": requireState("running", "convergence_check"); move("awaiting_input"); break;
    case "InputProvided": requireState("awaiting_input"); appendMessage(event.message); resume(); break;
    case "ApprovalRequested":
      requireState("running", "convergence_check");
      valid(room.actions.some(action => action.id === event.actionId && action.status === "planned"), "No action awaiting approval");
      move("awaiting_approval");
      break;
    case "ActionApproved": case "ActionRejected":
      requireState("awaiting_approval");
      updateAction(event.actionId, action => {
        valid(action.status === "planned", "Action is not pending");
        return event.type === "ActionRejected" ? { ...action, status: "cancelled", completedAt: occurredAt } : action;
      });
      resume();
      break;
    case "ConvergenceChecked":
      requireState("running");
      move("convergence_check");
      break;
    case "CandidateProduced":
      requireState("convergence_check");
      valid(event.actor === "facilitator" || room.members.some(member => member.id === event.actor && member.isFacilitator), "Only facilitator may produce a candidate");
      valid(event.candidate.roomId === room.id && event.candidate.acceptedAt === null, "Invalid candidate");
      move("awaiting_acceptance");
      next = { ...next, candidate: { ...event.candidate, createdAt: occurredAt } };
      break;
    case "CandidateAccepted":
      requireState("awaiting_acceptance");
      valid(room.candidate !== null && room.candidate.id === event.candidateId && room.activeRun !== null, "Missing candidate or run");
      move("completed");
      next = { ...next, candidate: { ...room.candidate, acceptedAt: occurredAt }, completedAt: occurredAt, activeRun: { ...room.activeRun, status: "completed", completedAt: occurredAt } };
      break;
    case "CandidateRejected":
      requireState("awaiting_acceptance");
      valid(room.candidate !== null && room.candidate.id === event.candidateId, "Missing candidate");
      resume();
      next = { ...next, candidate: null };
      break;
    case "HandoffGenerated": break;
    case "RoomArchived":
      valid(!room.actions.some(action => action.status === "started"), "Archive requires a safe boundary");
      move("archived");
      next = { ...next, archivedAt: occurredAt };
      break;
  }
  return immutableCopy(next);
}
