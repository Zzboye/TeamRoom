import { DomainError, renderHandoffMarkdown, serializeHandoffJson, type HandoffPackageV1, type Room } from "@teamroom/room-domain";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function renderJson(value: unknown): string { return `${JSON.stringify(canonical(value), null, 2)}\n` }
export function renderRoom(room: Room): string {
  return [`Room ${room.id}: ${room.title} [${room.status}] event=${room.streamVersion}`, `Task: ${room.task}`,
    ...room.members.map(member => `[${member.isFacilitator ? "facilitator" : "persona"}] ${member.id}: ${member.name} (${member.role})`),
    ...room.messages.map(message => `[${message.type}/${message.authorType}] ${message.id} author=${message.authorId}: ${message.content}`),
    ...room.actions.map(action => `[action/${action.status}] ${action.id} member=${action.memberId}: ${action.instruction}`),
    ...(room.pendingApprovalActionId ? [`[approval] ${room.pendingApprovalActionId}: awaiting user decision`] : []),
    ...room.memory.map(item => `[memory/${item.kind}] ${item.id} member=${item.memberId}: ${item.content}`),
    ...(room.candidate ? [`[candidate] ${room.candidate.id}: ${room.candidate.deliverable}`] : []), ""].join("\n");
}
export function renderResult(value: unknown): string {
  if (value !== null && typeof value === "object") {
    if ("streamVersion" in value) return renderRoom(value as Room);
    if ("room" in value) return renderRoom((value as { room: Room }).room);
  }
  return renderJson(value);
}
export function renderHandoff(handoff: HandoffPackageV1, format: "json" | "markdown"): string {
  return format === "json" ? serializeHandoffJson(handoff) : renderHandoffMarkdown(handoff);
}
export function renderError(error: unknown, json: boolean): string {
  const detail = { code: error instanceof DomainError ? error.code : "validation", message: error instanceof Error ? error.message : String(error) };
  return json ? renderJson({ error: detail }) : `Error [${detail.code}]: ${detail.message}\n`;
}
