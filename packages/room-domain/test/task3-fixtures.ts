import { domainId, reduceRoom, type EventEnvelope, type Room, type RoomEvent, type RoomMember } from "../src/index.js";

const roomId = domainId.room("room-1");
export const member: RoomMember = { id: domainId.member("facilitator-1"), name: "Facilitator", role: "Lead", responsibilities: [], domainPerspective: "planning", communicationStyle: "clear", constraints: [], collaborationGuidance: [], isFacilitator: true, sourceTemplateId: null, sourceTemplateVersion: null };
const time = "2026-11-02T00:00:00.000Z";
export const events: readonly RoomEvent[] = [
  { type: "RoomCreated", title: "Launch", task: "Plan launch", requirements: [], acceptanceCriteria: ["actionable"], backgroundPolicy: "pause_on_leave" },
  { type: "TeamProposed", members: [member] }, { type: "TeamConfirmed" },

];
export function envelope(event: RoomEvent, sequence: number): EventEnvelope {
  return { eventId: domainId.event(`event-${sequence}`), roomId, sequence, occurredAt: time, causationId: domainId.command("command-1"), schemaVersion: 1, event };
}
export function replay(payloads: readonly RoomEvent[] = events): Room {
  let room: Room | null = null;
  payloads.forEach((event, index) => { room = reduceRoom(room, envelope(event, index + 1)); });
  if (room === null) throw new Error("Empty test stream");
  return room;
}

