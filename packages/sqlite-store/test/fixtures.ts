import { domainId, type Action, type NewRoomEvent } from "@teamroom/room-domain";

export const roomId = domainId.room("room-1");
export const time = "2026-11-02T00:00:00.000Z";
export const created: NewRoomEvent = { type: "RoomCreated", title: "Launch", task: "Plan launch", requirements: [], acceptanceCriteria: [], backgroundPolicy: "pause_on_leave" };
export const member = { id: domainId.member("lead"), name: "Lead", role: "Lead", responsibilities: [], domainPerspective: "planning", communicationStyle: "clear", constraints: [], collaborationGuidance: [], isFacilitator: true, sourceTemplateId: null, sourceTemplateVersion: null } as const;
export function message(sequence: number): NewRoomEvent {
  return { type: "MessagePosted", message: { id: domainId.message(`message-${sequence}`), roomId, authorType: "user", authorId: "user", content: `Message ${sequence}`, type: "user", sequence, createdAt: time } };
}
export function action(id = "action-1"): Action {
  return { id: domainId.action(id), roomId, runId: domainId.run("run-1"), roundId: domainId.round("round-1"), memberId: member.id, position: 0, instruction: "Contribute", dependencies: [], idempotencyKey: `key-${id}`, status: "planned", errorCode: null, startedAt: null, completedAt: null };
}
export function startedActions(actions = [action()]): readonly NewRoomEvent[] {
  return [created, { type: "TeamProposed", members: [member] }, { type: "TeamConfirmed" }, { type: "RunStarted", runId: domainId.run("run-1") }, { type: "RoundPlanned", roundId: domainId.round("round-1"), actions }, ...actions.map(item => ({ type: "ActionStarted" as const, actionId: item.id }))];
}
