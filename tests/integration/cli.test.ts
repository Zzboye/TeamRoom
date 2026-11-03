import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  return { db, directory, cli, invoke, start };
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
