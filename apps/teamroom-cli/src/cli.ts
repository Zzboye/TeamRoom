import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildHandoff, domainId, DomainError, type Room, type RoomCommand, type RoomMember } from "@teamroom/room-domain";
import { AutonomousRunner, type RoomService } from "@teamroom/room-engine";
import { openTeamRoomDatabase, RoomRepository } from "@teamroom/sqlite-store";
import { createDeterministicAdapters, loadScenario, type Scenario } from "@teamroom/test-adapters";
import { renderHandoff, renderJson, renderResult } from "./render.js";

const options = {
  db: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
  room: { type: "string" }, id: { type: "string" }, title: { type: "string" }, task: { type: "string" },
  requirement: { type: "string", multiple: true }, criterion: { type: "string", multiple: true },
  fixture: { type: "string" }, members: { type: "string" }, content: { type: "string" }, reason: { type: "string" },
  member: { type: "string" }, mention: { type: "string", multiple: true }, quote: { type: "string", multiple: true },
  format: { type: "string" }, output: { type: "string" },
} as const;
const help = `teamroom --db <path> [--json] <command>\n
init
room create --task <text> [--title <text>] [--id <room-id>] [--requirement <text>] [--criterion <text>]
room show --room <room-id>
team propose --room <room-id> --members <json-file>
team confirm --room <room-id>
run start|pause|resume --room <room-id> [--id <run-id>] [--reason <text>]
run step --room <room-id> --fixture <json-file>
message post --room <room-id> --content <text> [--id <message-id>] [--mention <member-id>] [--quote <message-id>]
memory list --room <room-id> [--member <member-id>]
candidate accept --room <room-id> [--id <candidate-id>]
handoff export --room <room-id> [--id <handoff-id>] [--format json|markdown] [--output <path>]
demo --fixture <json-file>
TEAMROOM_DB may supply the database path. Repeated requirement/criterion/mention/quote flags are supported.
`;
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new DomainError("validation", `Missing --${name}`);
  return value;
}
function fixture(path: string): Scenario { return loadScenario(JSON.parse(readFileSync(path, "utf8"))) }
type UserCommandInput<T = Extract<RoomCommand, { actor: unknown }>> = T extends unknown ? Omit<T, "roomId" | "expectedVersion" | "commandId"> : never;

/** Translate fixture shorthand keys to port call keys; all outcomes remain fixture-authored. */
function scenarioRunner(service: RoomService, scenario: Scenario): AutonomousRunner {
  const adapters = createDeterministicAdapters(scenario);
  return new AutonomousRunner({ service,
    facilitator: {
      plan: input => adapters.facilitator.plan({ ...input, callKey: Object.hasOwn(scenario.plans, input.callKey) ? input.callKey : `round-${input.room.usage.rounds + 1}` }),
      evaluate: input => {
        const round = input.room.activeRun!.roundIds.at(-1)!;
        const completed = input.room.actions.filter(action => !["planned", "started"].includes(action.status)).length;
        const key = [input.callKey, `${round}:${completed}`, round].find(key => Object.hasOwn(scenario.convergence, key)) ?? input.callKey;
        return adapters.facilitator.evaluate({ ...input, callKey: key });
      },
    },
    persona: { act: input => adapters.persona.act({ ...input, callKey: Object.hasOwn(scenario.personaActions, input.callKey) ? input.callKey : input.action.id }) },
  });
}

function demoMembers(scenario: Scenario): readonly RoomMember[] {
  const ids = [...new Set(Object.values(scenario.plans).flatMap(plan => plan.response.actions.map(action => action.memberId)))];
  const facilitator = domainId.member("demo-facilitator");
  return [facilitator, ...ids.filter(id => id !== facilitator)].map(id => ({ id, name: id, role: id === facilitator ? "Facilitator" : "Contributor", responsibilities: [], domainPerspective: "fixture", communicationStyle: "clear", constraints: [], collaborationGuidance: [], isFacilitator: id === facilitator, sourceTemplateId: null, sourceTemplateVersion: null }));
}

/** Composes public services only. This module does not query database tables. */
export async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { values, positionals } = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  if (values.help) return values.json ? renderJson({ help }) : help;
  const command = positionals.join(" ");
  const commands = ["init", "room create", "room show", "team propose", "team confirm", "run start", "run step", "run pause", "run resume", "message post", "memory list", "candidate accept", "handoff export", "demo"];
  if (!commands.includes(command)) throw new DomainError("validation", `Unknown command: ${command || "(missing)"}. Use --help`);
  const path = required(values.db ?? env.TEAMROOM_DB, "db (or TEAMROOM_DB)");
  const db = openTeamRoomDatabase(path);
  try {
    const service = RoomRepository.sqlite(db);
    const metadata = (room: Room) => ({ roomId: room.id, expectedVersion: room.streamVersion, commandId: domainId.command(randomUUID()) });
    const execute = (room: Room, input: UserCommandInput) => service.execute({ ...metadata(room), ...input });
    let result: unknown;
    if (command === "init") result = { database: path, schemaVersion: 1 };
    else if (command === "room create") {
      const task = required(values.task, "task");
      result = await service.execute({ type: "CreateRoom", roomId: domainId.room(values.id ?? randomUUID()), expectedVersion: 0, commandId: domainId.command(randomUUID()), title: values.title ?? task, task, requirements: values.requirement ?? [], acceptanceCriteria: values.criterion ?? [], backgroundPolicy: "pause_on_leave" });
    } else if (command === "demo") {
      const scenario = fixture(required(values.fixture, "fixture"));
      const first = Object.values(scenario.plans).flatMap(plan => plan.response.actions)[0];
      if (!first) throw new DomainError("validation", "Demo fixture must contain a planned action");
      let room = await service.execute({ type: "CreateRoom", roomId: first.roomId, expectedVersion: 0, commandId: domainId.command(randomUUID()), title: scenario.id, task: `Demonstrate ${scenario.id}`, requirements: [], acceptanceCriteria: scenario.acceptanceCriteria, backgroundPolicy: "pause_on_leave" });
      room = await execute(room, { type: "ProposeTeam", actor: "user", members: demoMembers(scenario) });
      room = await execute(room, { type: "ConfirmTeam", actor: "user" });
      room = await service.execute({ ...metadata(room), type: "StartRun", runId: first.runId });
      const runner = scenarioRunner(service, scenario);
      // Bound the demonstration by the fixture's finite scripts; each step must commit progress.
      const limit = Object.values(scenario.plans).reduce((total, plan) => total + plan.response.actions.length + 1, 1);
      for (let step = 0; step < limit && ["running", "convergence_check"].includes(room.status); step++) {
        const before = room.streamVersion;
        room = (await runner.step(room.id)).room;
        if (room.streamVersion === before) throw new DomainError("validation", "Demo made no progress");
      }
      if (["running", "convergence_check"].includes(room.status)) throw new DomainError("validation", "Demo exceeded fixture step limit");
      result = { room, handoff: buildHandoff(room) };
    } else {
      let room = await service.load(domainId.room(required(values.room, "room")));
      switch (command) {
        case "room show": result = room; break;
        case "team propose": {
          const members: unknown = JSON.parse(readFileSync(required(values.members, "members"), "utf8"));
          if (!Array.isArray(members) || !members.every(member => member && typeof member === "object" && typeof member.id === "string" && typeof member.name === "string" && typeof member.role === "string" && ["responsibilities", "constraints", "collaborationGuidance"].every(key => Array.isArray(member[key]) && member[key].every((item: unknown) => typeof item === "string")) && typeof member.domainPerspective === "string" && typeof member.communicationStyle === "string" && typeof member.isFacilitator === "boolean" && (member.sourceTemplateId === null || typeof member.sourceTemplateId === "string") && (member.sourceTemplateVersion === null || Number.isSafeInteger(member.sourceTemplateVersion)))) throw new DomainError("validation", "Invalid team member JSON");
          result = await execute(room, { type: "ProposeTeam", actor: "user", members: members as RoomMember[] }); break;
        }
        case "team confirm": result = await execute(room, { type: "ConfirmTeam", actor: "user" }); break;
        case "run start": result = await service.execute({ ...metadata(room), type: "StartRun", runId: domainId.run(values.id ?? randomUUID()) }); break;
        case "run step": result = await scenarioRunner(service, fixture(required(values.fixture, "fixture"))).step(room.id); break;
        case "run pause": result = await execute(room, { type: "PauseRun", actor: "user", reason: values.reason ?? "Paused by user" }); break;
        case "run resume": result = await execute(room, { type: "ResumeRun", actor: "user" }); break;
        case "message post": result = await execute(room, { type: room.status === "awaiting_input" ? "ProvideRequestedInput" : "PostMessage", actor: "user", message: {
          id: domainId.message(values.id ?? randomUUID()), roomId: room.id, authorType: "user", authorId: "user", type: "user", content: required(values.content, "content"), sequence: room.latestMessageSequence + 1, createdAt: new Date().toISOString(),
          links: [...(values.mention ?? []).map(id => ({ type: "mention" as const, memberId: domainId.member(id) })), ...(values.quote ?? []).map(id => ({ type: "quote" as const, messageId: domainId.message(id) }))],
        } }); break;
        case "memory list": result = { roomId: room.id, items: room.memory.filter(item => !values.member || item.memberId === values.member) }; break;
        case "candidate accept": result = await execute(room, { type: "AcceptCandidate", actor: "user", candidateId: domainId.candidate(required(values.id ?? room.candidate?.id, "id")) }); break;
        case "handoff export": {
          const format = values.format ?? "markdown";
          if (format !== "json" && format !== "markdown") throw new DomainError("validation", "--format must be json or markdown");
          const id = domainId.handoff(values.id ?? randomUUID());
          room = await execute(room, { type: "GenerateHandoff", actor: "user", handoffId: id });
          const handoff = buildHandoff(room);
          const output = renderHandoff(handoff, format);
          if (values.output) writeFileSync(values.output, output, "utf8");
          return values.json ? renderHandoff(handoff, "json") : format === "markdown" ? `Handoff ${id}\n\n${output}` : output;
        }
      }
    }
    return values.json ? renderJson(result) : renderResult(result);
  } finally { db.close() }
}
