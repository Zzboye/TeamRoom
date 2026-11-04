import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { buildHandoff, domainId, reduceRoom, type Room } from "../../packages/room-domain/src/index.js";
import { openTeamRoomDatabase, SqliteEventStore } from "../../packages/sqlite-store/src/index.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) });
const entry = resolve("apps/teamroom-cli/src/main.ts");
const fixturePath = resolve("tests/fixtures/happy-path.json");
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "teamroom-cli-")); directories.push(directory);
  const db = join(directory, "room.sqlite");
  const members = join(directory, "members.json");
  const member = { name: "Lead", role: "Lead", responsibilities: [], domainPerspective: "planning", communicationStyle: "clear", constraints: [], collaborationGuidance: [], sourceTemplateId: null, sourceTemplateVersion: null };
  writeFileSync(members, JSON.stringify([{ ...member, id: "facilitator", isFacilitator: true }, ...["researcher", "editor"].map(id => ({ ...member, id, isFacilitator: false }))]));
  function invoke(args: string[], json = true, environment = false) {
    return spawnSync(process.execPath, ["--import", "tsx", entry, ...args, ...(environment ? [] : ["--db", db]), ...(json ? ["--json"] : [])], { encoding: "utf8", env: { ...process.env, TEAMROOM_DB: environment ? db : "" } });
  }
  function cli(...args: string[]): any {
    const result = invoke(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    return JSON.parse(result.stdout);
  }
  function start() {
    cli("init");
    cli("room", "create", "--id", "room-1", "--title", "Research", "--task", "Write brief", "--criterion", "Research includes evidence", "--criterion", "Brief is edited and ready to review");
    cli("team", "propose", "--room", "room-1", "--members", members);
    cli("team", "confirm", "--room", "room-1");
    return cli("run", "start", "--room", "room-1", "--id", "run-1");
  }
  return { db, directory, members, cli, invoke, start };
}

test("CLI dispatches the complete lifecycle through public services with JSON-only stdout", () => {
  const { cli, invoke, directory, start } = setup();
  expect(start().status).toBe("running");
  const first = cli("run", "step", "--room", "room-1", "--fixture", fixturePath);
  expect(first.room.actions.map((action: any) => action.status)).toEqual(["succeeded", "planned"]);
  const human = invoke(["room", "show", "--room", "room-1"], false);
  expect(human.stdout).toContain("[persona/persona] message-research");
  expect(human.stdout).toContain("[action/planned] edit");
  expect(human.stdout).toContain("[memory/fact] memory-research");
  expect(cli("memory", "list", "--room", "room-1").items).toHaveLength(1);
  expect(cli("message", "post", "--room", "room-1", "--id", "user-1", "--content", "Please continue", "--mention", "editor", "--quote", "message-research").messages.at(-1).id).toBe("user-1");
  expect(cli("run", "pause", "--room", "room-1").status).toBe("paused");
  expect(cli("run", "resume", "--room", "room-1").status).toBe("running");
  expect(cli("run", "step", "--room", "room-1", "--fixture", fixturePath).room.status).toBe("awaiting_acceptance");
  expect(cli("candidate", "accept", "--room", "room-1", "--id", "candidate-1").status).toBe("completed");
  const output = join(directory, "handoff.json");
  const handoff = cli("handoff", "export", "--room", "room-1", "--id", "handoff-1", "--format", "json", "--output", output);
  expect(handoff.candidate.acceptedAt).not.toBeNull();
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(handoff);
  const markdown = invoke(["handoff", "export", "--room", "room-1", "--id", "handoff-2"], false);
  expect(markdown.status, markdown.stderr).toBe(0);
  expect(markdown.stdout).toContain("## Decisions");
  expect(markdown.stdout).not.toContain("Please continue");
  expect(invoke(["room", "show", "--room", "room-1"], true, true).status).toBe(0);
}, 20000);

test("a new CLI process restores messages, memories, pending actions, status and event position before resume", () => {
  const { cli, invoke, start } = setup(); start();
  const before = cli("run", "step", "--room", "room-1", "--fixture", fixturePath).room;
  const restored = cli("room", "show", "--room", "room-1");
  expect(restored).toEqual(before);
  expect(restored.messages).toHaveLength(1);
  expect(restored.memory).toHaveLength(1);
  expect(restored.actions.filter((action: any) => action.status === "planned")).toHaveLength(1);
  expect(invoke(["room", "show", "--room", "room-1"]).stdout).toBe(invoke(["room", "show", "--room", "room-1"]).stdout);
  expect(cli("run", "step", "--room", "room-1", "--fixture", fixturePath).room.status).toBe("awaiting_acceptance");
}, 20000);

test("demo uses a fixture to reach acceptance without accepting on the user's behalf", () => {
  const { cli } = setup();
  const result = cli("demo", "--fixture", fixturePath);
  expect(result.room.status).toBe("awaiting_acceptance");
  expect(result.room.candidate.acceptedAt).toBeNull();
  expect(result.handoff.sources.status).toBe("not_collected_in_phase_1");
}, 20000);

test("CLI failures keep stdout empty and write errors to stderr", () => {
  const { invoke } = setup();
  for (const args of [["unknown"], ["room", "show", "--room", "missing"], ["room", "create"], ["init", "--typo"]]) {
    const result = invoke(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toHaveProperty("error.message");
  }
  const missing = spawnSync(process.execPath, ["--import", "tsx", entry, "init", "--json"], { encoding: "utf8", env: { ...process.env, TEAMROOM_DB: "" } });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("--db");
}, 20000);

test.each([
  ["blank member ID", { id: " \t\n" }],
  ["empty member ID", { id: "" }],
  ["non-string member ID", { id: 7 }],
  ["blank persona template ID", { sourceTemplateId: " \t", sourceTemplateVersion: 1 }],
  ["empty persona template ID", { sourceTemplateId: "", sourceTemplateVersion: 1 }],
  ["non-string persona template ID", { sourceTemplateId: 7, sourceTemplateVersion: 1 }],
  ["zero template version", { sourceTemplateId: "persona-1", sourceTemplateVersion: 0 }],
  ["negative template version", { sourceTemplateId: "persona-1", sourceTemplateVersion: -1 }],
  ["fractional template version", { sourceTemplateId: "persona-1", sourceTemplateVersion: 1.5 }],
  ["unsafe template version", { sourceTemplateId: "persona-1", sourceTemplateVersion: Number.MAX_SAFE_INTEGER + 1 }],
  ["string template version", { sourceTemplateId: "persona-1", sourceTemplateVersion: "1" }],
  ["template ID without version", { sourceTemplateId: "persona-1", sourceTemplateVersion: null }],
  ["template version without ID", { sourceTemplateId: null, sourceTemplateVersion: 1 }],
] as const)("team propose rejects %s without persisting a mutation", (_label, invalid) => {
  const { cli, invoke, members } = setup();
  cli("room", "create", "--id", "room-1", "--task", "Validate members");
  const before = cli("team", "propose", "--room", "room-1", "--members", members);
  const payload = JSON.parse(readFileSync(members, "utf8"));
  payload[1] = { ...payload[1], ...invalid };
  writeFileSync(members, JSON.stringify(payload));
  const result = invoke(["team", "propose", "--room", "room-1", "--members", members]);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "validation" } });
  expect(cli("room", "show", "--room", "room-1")).toEqual(before);
}, 20000);

test("team propose accepts valid branded IDs and positive template provenance", () => {
  const { cli, members } = setup();
  cli("room", "create", "--id", "room-1", "--task", "Validate members");
  const payload = JSON.parse(readFileSync(members, "utf8"));
  payload[1] = { ...payload[1], sourceTemplateId: "persona-1", sourceTemplateVersion: 2 };
  writeFileSync(members, JSON.stringify(payload));
  const proposed = cli("team", "propose", "--room", "room-1", "--members", members);
  expect(proposed.members[1]).toMatchObject({ id: "researcher", sourceTemplateId: "persona-1", sourceTemplateVersion: 2 });
  expect(cli("team", "confirm", "--room", "room-1").status).toBe("ready");
}, 20000);

test("HandoffGenerated projection stores canonical content at its event position within a batch", async () => {
  const { db: path } = setup();
  const db = openTeamRoomDatabase(path);
  try {
    const events = new SqliteEventStore(db);
    const committed = await events.append(domainId.room("room"), 0, [
      { type: "RoomCreated", title: "Test", task: "Test", requirements: [], acceptanceCriteria: [], backgroundPolicy: "pause_on_leave" },
      { type: "HandoffGenerated", handoffId: domainId.handoff("handoff") },
      { type: "MessagePosted", message: { id: domainId.message("later"), roomId: domainId.room("room"), authorType: "user", authorId: "user", content: "Later", type: "user", sequence: 1, createdAt: "2026-11-02T00:00:00.000Z" } },
    ]);
    const room = committed.slice(0, 2).reduce<Room | null>((room, event) => reduceRoom(room, event), null)!;
    const stored = db.prepare("SELECT handoff_json, event_sequence FROM handoffs").get() as { handoff_json: string; event_sequence: number };
    expect(stored.event_sequence).toBe(2);
    expect(JSON.parse(stored.handoff_json)).toEqual(buildHandoff(room));
  } finally { db.close() }
});

test("CLI lists, inspects and archives rooms, manages templates and edits memory", () => {
  const { cli, directory, start } = setup();
  start();
  expect(cli("room", "list").rooms.map((room: Room) => room.id)).toEqual(["room-1"]);
  expect(cli("room", "open", "--room", "room-1").status).toBe("running");
  expect(cli("room", "inspect", "--room", "room-1").actions).toEqual([]);
  const persona = { id: "saved-persona", version: 1, name: "Planner", role: "Planner", responsibilities: [], domainPerspective: "Planning", communicationStyle: "Clear", constraints: [], collaborationGuidance: [] };
  const personaFile = join(directory, "persona.json");
  writeFileSync(personaFile, JSON.stringify(persona));
  expect(cli("template", "persona", "create", "--file", personaFile)).toEqual(persona);
  expect(cli("template", "persona", "list").templates).toEqual([persona]);
  const team = { id: "saved-team", version: 1, name: "Team", members: [{ memberId: "lead", persona, isFacilitator: true }] };
  const teamFile = join(directory, "team.json");
  writeFileSync(teamFile, JSON.stringify(team));
  expect(cli("template", "team", "create", "--file", teamFile)).toEqual(team);
  expect(cli("template", "team", "list").templates).toEqual([team]);
  cli("run", "step", "--room", "room-1", "--fixture", fixturePath);
  expect(cli("memory", "edit", "--room", "room-1", "--id", "memory-research", "--content", "User correction").memory[0].content).toBe("User correction");
  expect(cli("memory", "pin", "--room", "room-1", "--id", "memory-research").memory[0].pinned).toBe(true);
  expect(cli("memory", "pin", "--room", "room-1", "--id", "memory-research", "--unpin").memory[0].pinned).toBe(false);
  expect(cli("memory", "remove", "--room", "room-1", "--id", "memory-research").memory).toEqual([]);
  expect(cli("events", "list", "--room", "room-1").events.some((event: any) => event.event.type === "MemoryUpdated")).toBe(true);
  expect(cli("room", "archive", "--room", "room-1").status).toBe("archived");
}, 30000);

test.each(["approve", "reject"])("CLI resolves approval by %s and answers requested input", resolution => {
  const { cli, invoke, directory, start } = setup(); start();
  const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
  scenario.convergence["round-1:1"] = { response: { type: "request_approval", actionId: "edit", reason: "Review edit" } };
  const script = join(directory, "approval.json");
  writeFileSync(script, JSON.stringify(scenario));
  expect(cli("run", "step", "--room", "room-1", "--fixture", script).room.pendingApprovalActionId).toBe("edit");
  expect(invoke(["room", "inspect", "--room", "room-1"], false).stdout).toContain("[approval] edit");
  expect(invoke(["action", resolution, "--room", "room-1", "--id", "research"]).status).toBe(1);
  expect(cli("action", resolution, "--room", "room-1", "--id", "edit", "--reason", "User decision").pendingApprovalActionId).toBeNull();
  if (resolution === "approve") {
    scenario.convergence["round-1"] = { response: { type: "request_input", question: "Confirm the direction" } };
    writeFileSync(script, JSON.stringify(scenario));
    expect(cli("run", "step", "--room", "room-1", "--fixture", script).room.status).toBe("awaiting_input");
    expect(cli("input", "provide", "--room", "room-1", "--content", "Proceed").status).toBe("running");
  } else expect(cli("room", "show", "--room", "room-1").actions[1].status).toBe("cancelled");
}, 30000);

test("CLI rejects a candidate and accepts a later revised version", () => {
  const { cli, directory } = setup();
  const original = cli("demo", "--fixture", fixturePath).room;
  expect(cli("candidate", "reject", "--room", "room-1", "--reason", "Improve evidence").status).toBe("running");
  const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
  scenario.plans["round-2"] = { response: { actions: [] } };
  scenario.convergence["run-1:round:2"] = { response: { type: "candidate", candidate: { ...original.candidate, id: "candidate-2", deliverable: "Revised brief", acceptedAt: null } } };
  const script = join(directory, "revision.json");
  writeFileSync(script, JSON.stringify(scenario));
  expect(cli("run", "step", "--room", "room-1", "--fixture", script).room.candidate.id).toBe("candidate-2");
  expect(cli("candidate", "accept", "--room", "room-1").status).toBe("completed");
}, 30000);

test.each(["step", "recover"])("CLI run %s reconciles persisted interrupted work before dispatch", async command => {
  const { cli, db: path, directory, start } = setup(); start();
  const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
  const actions = scenario.plans["round-1"].response.actions;
  // Model a process exiting after its durable dispatch checkpoint.
  const child = join(directory, "interrupt.mjs");
  writeFileSync(child, `import { openTeamRoomDatabase, SqliteEventStore } from ${JSON.stringify(pathToFileURL(resolve("packages/sqlite-store/src/index.ts")).href)};\nconst db = openTeamRoomDatabase(process.argv[2]);\nawait new SqliteEventStore(db).append("room-1", 4, ${JSON.stringify([{ type: "RoundPlanned", roundId: "round-1", actions }, { type: "ActionStarted", actionId: "research" }])});\nprocess.exit(23);\n`);
  expect(spawnSync(process.execPath, ["--import", "tsx", child, path], { encoding: "utf8" }).status).toBe(23);
  scenario.reconciliations = [{ actionId: "research", idempotencyKey: "intent-research", response: { status: "succeeded", output: "Recovered research", artifactIds: [], usage: { tokens: 7 } } }];
  scenario.convergence["round-1:1"] = { response: { type: "request_approval", actionId: "edit", reason: "Review recovered work" } };
  const script = join(directory, "recovery.json");
  writeFileSync(script, JSON.stringify(scenario));
  const recovered = cli("run", command, "--room", "room-1", "--fixture", script);
  const room = recovered.room ?? recovered;
  expect(room.actions[0].status).toBe("succeeded");
  expect(room.actions[1].status).toBe("planned");
  if (command === "step") expect(room.status).toBe("awaiting_approval");
  const events = cli("events", "list", "--room", "room-1").events;
  expect(events.filter((event: any) => event.event.type === "ActionCompleted" && event.event.actionId === "research")).toHaveLength(1);
  expect(events.filter((event: any) => event.event.type === "ActionStarted")).toHaveLength(1);
  expect(cli("run", "recover", "--room", "room-1", "--fixture", script)).toEqual(room);
}, 30000);
