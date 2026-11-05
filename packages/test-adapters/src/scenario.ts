import { z } from "zod";
import { domainId, validMemoryItem } from "@teamroom/room-domain";

const text = z.string().refine(value => value.trim().length > 0, "Must not be blank");
const id = <T>(factory: (value: string) => T) => text.transform(factory);
const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative();
export const usageDeltaSchema = z.strictObject({ rounds: count.default(0), actions: count.default(0), tokens: count.default(0), cost: z.number().nonnegative().default(0) });
const actionSchema = z.strictObject({
  id: id(domainId.action), roomId: id(domainId.room), runId: id(domainId.run), roundId: id(domainId.round), memberId: id(domainId.member),
  position: count, instruction: text, dependencies: z.array(id(domainId.action)), idempotencyKey: text,
  status: z.enum(["planned", "started", "succeeded", "failed", "cancelled", "status_unknown"]),
  errorCode: z.enum(["validation", "conflict", "retryable_adapter", "permanent_adapter", "timeout", "approval_required", "budget_exhausted", "corrupt_data", "status_unknown"]).nullable(),
  startedAt: timestamp.nullable(), completedAt: timestamp.nullable(),
});
const planSchema = z.strictObject({ actions: z.array(actionSchema) }).superRefine((plan, ctx) => {
  const ids = new Set(plan.actions.map(action => action.id));
  if (ids.size !== plan.actions.length) ctx.addIssue({ code: "custom", message: "Duplicate action IDs" });
  for (const action of plan.actions) {
    if (action.dependencies.some(dependency => !ids.has(dependency))) ctx.addIssue({ code: "custom", message: "Action dependency references a missing action" });
  }
});
const linkSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("mention"), memberId: id(domainId.member) }),
  z.strictObject({ type: z.enum(["reply", "quote"]), messageId: id(domainId.message) }),
]);
const messageSchema = z.strictObject({
  id: id(domainId.message), roomId: id(domainId.room), authorType: z.enum(["user", "persona", "facilitator", "system"]),
  authorId: z.union([z.literal("user"), z.literal("system"), id(domainId.member)]), content: text,
  type: z.enum(["user", "persona", "facilitator", "system_card", "action_summary", "approval_request", "candidate_result", "handoff"]),
  sequence: count, createdAt: timestamp, links: z.array(linkSchema).default([]),
});
const memorySchema = z.strictObject({
  id: id(domainId.memoryItem), roomId: id(domainId.room), memberId: id(domainId.member),
  kind: z.enum(["goal", "fact", "judgment", "assumption", "task", "completed"]), content: text,
  provenance: z.array(z.union([id(domainId.message), id(domainId.event)])), confidence: z.number().min(0).max(1).nullable(),
  createdByEventId: id(domainId.event), updatedByEventId: id(domainId.event), pinned: z.boolean(),
}).refine(validMemoryItem, "Invalid memory proposal");
const candidateSchema = z.strictObject({
  id: id(domainId.candidate), roomId: id(domainId.room), deliverable: text,
  checklist: z.array(z.strictObject({ criterion: text, satisfied: z.boolean(), evidence: text })),
  decisions: z.array(text), unresolvedIssues: z.array(text), messageIds: z.array(id(domainId.message)),
  artifactIds: z.array(id(domainId.artifact)), sourceIds: z.array(id(domainId.source)), createdAt: timestamp, acceptedAt: timestamp.nullable(),
});
const convergenceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("continue"), reason: text }),
  z.strictObject({ type: z.literal("request_input"), question: text }),
  z.strictObject({ type: z.literal("request_approval"), actionId: id(domainId.action), reason: text }),
  z.strictObject({ type: z.literal("pause"), reason: text }),
  z.strictObject({ type: z.literal("candidate"), candidate: candidateSchema }),
]);
const successSchema = z.strictObject({ status: z.literal("succeeded"), output: z.string(), artifactIds: z.array(id(domainId.artifact)), usage: usageDeltaSchema });
const toolSchema = z.discriminatedUnion("status", [successSchema,
  z.strictObject({ status: z.enum(["retryable_failure", "permanent_failure", "approval_required", "timeout", "status_unknown"]), reason: text }),
]);
const reconciliationSchema = z.discriminatedUnion("status", [successSchema,
  z.strictObject({ status: z.enum(["not_started", "failed", "status_unknown"]), reason: text }),
]);
const script = <T extends z.ZodType>(response: T) => z.strictObject({ response, advanceMs: count.optional() });
const keyed = <T extends z.ZodType>(value: T) => z.record(text, value);

/** JSON parsing and filesystem loading belong to the caller; validation has no I/O. */
export const scenarioSchema = z.strictObject({
  schemaVersion: z.literal(1), id: text, startTime: timestamp, acceptanceCriteria: z.array(text),
  plans: keyed(script(planSchema)), convergence: keyed(script(convergenceSchema)),
  personaActions: keyed(script(z.strictObject({ messages: z.array(messageSchema), memoryProposals: z.array(memorySchema), usage: usageDeltaSchema }))),
  tools: keyed(script(toolSchema)),
  reconciliations: z.array(z.strictObject({ actionId: id(domainId.action), idempotencyKey: text, response: reconciliationSchema })),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export function loadScenario(input: unknown): Scenario { return scenarioSchema.parse(input) }
