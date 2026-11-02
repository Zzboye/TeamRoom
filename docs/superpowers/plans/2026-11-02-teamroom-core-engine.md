# TeamRoom Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent, deterministic TeamRoom core engine and CLI demonstration that supports reviewed persona teams, public messages, structured private memory, autonomous rounds, pause/resume, restart recovery, candidate acceptance, and structured handoff export.

**Architecture:** A pure event-sourced domain package sits behind application services and runtime ports. Deterministic adapters drive orchestration in Phase 1, while a SQLite adapter provides optimistic event append, snapshots, template storage, and recovery; a thin CLI calls the same application APIs used by future Codex hosts.

**Tech Stack:** Node.js 24.15.0, TypeScript 7.0.2, pnpm 11.20.0 workspaces, Vitest 5.0.5, Zod 4.6.7, better-sqlite3 13.0.3, tsx 4.23.15

**Spec:** `docs/superpowers/specs/2026-11-02-teamroom-core-engine-design.md`

## Global Constraints

- Pin Node.js to `24.15.0` and pnpm to `11.20.0`; commit `pnpm-lock.yaml`.
- Use ESM, strict TypeScript, project references, and no default exports.
- Keep `packages/room-domain` free of Node, SQLite, Zod, and adapter imports.
- Treat the append-only room event stream as the source of truth; snapshots are disposable caches.
- Use room-local optimistic stream versions and stable IDs for every message, action, template version, candidate, and handoff.
- Never persist raw model reasoning; persona memory is typed, structured, and user-editable.
- Keep tests deterministic: inject clock and ID ports, use fake timers only where necessary, and never use wall-clock sleeps.
- Phase 1 performs no network access, real tool execution, worktree changes, background processing, or host injection.
- A user pause prevents new actions from starting; uncertain action status pauses for review and is never blindly retried.
- Run `pnpm typecheck` and `pnpm test` before every task commit.

## File Map

```text
package.json                         Workspace scripts and pinned tools
pnpm-workspace.yaml                 Workspace package discovery
tsconfig.base.json                  Strict shared compiler options and aliases
tsconfig.json                       Project references
vitest.config.ts                    Unit/integration test discovery
.node-version                       Node 24.15.0 pin
apps/teamroom-cli/
  package.json                      CLI package metadata
  src/main.ts                       Process entry and exit codes
  src/cli.ts                        parseArgs command dispatch
  src/render.ts                     Human-readable output only
packages/room-domain/src/
  ids.ts                            Branded identifiers and factories
  model.ts                          Aggregate and value-object types
  commands.ts                       External command union
  events.ts                         Versioned event union and envelope
  errors.ts                         Typed domain errors
  reducer.ts                        Pure event reducer
  decide.ts                         Pure command validation and decision
  routing.ts                        Mention/reply/quote routing
  handoff.ts                        Canonical handoff types and Markdown render
packages/runtime-ports/src/
  index.ts                          Clock, ID, facilitator, persona, tool, artifact ports
packages/room-engine/src/
  stores.ts                         Event, snapshot, and template store contracts
  room-service.ts                   Load/execute/append application service
  runner.ts                         One deterministic autonomous step
  recovery.ts                       In-flight action reconciliation
packages/test-adapters/src/
  scenario.ts                       Zod fixture schema
  deterministic.ts                  Scripted ports, clock, and IDs
packages/sqlite-store/
  migrations/001-initial.sql        Complete Phase 1 schema
  src/database.ts                   Connection, pragmas, transactions, migrations
  src/event-store.ts                Optimistic event append/load
  src/snapshot-store.ts             Validated snapshot cache
  src/template-store.ts             Immutable persona/team versions
  src/room-repository.ts            Engine store composition
tests/fixtures/happy-path.json      Deterministic accepted-result scenario
tests/fixtures/failure-path.json    Failure, approval, timeout, unknown-status scenario
tests/fixtures/schema-v1-empty.sqlite  Released migration input fixture
tests/integration/                  SQLite, recovery, CLI, and acceptance tests
```

---

### Task 1: Workspace and Domain Foundations

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.node-version`
- Create: package manifests and `tsconfig.json` files under `apps/teamroom-cli` and every package directory
- Create: `packages/room-domain/src/ids.ts`, `model.ts`, `errors.ts`, `index.ts`
- Test: `packages/room-domain/test/model.test.ts`

**Interfaces:**
- Consumes: none
- Produces: branded IDs, `Room`, `RoomStatus`, `RoomMember`, `MemoryItem`, `Message`, `Run`, `Action`, `CandidateResult`, and `DomainError`

- [ ] **Step 1: Add the workspace configuration**

Use root scripts `typecheck: tsc -b`, `test: vitest run`, and `test:watch: vitest`. Pin the package manager as `pnpm@11.20.0`; pin the dev dependencies listed in the plan header, with `@types/node@24.19.2` and `@types/better-sqlite3@9.6.0`. Configure `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, and `verbatimModuleSyntax`.

- [ ] **Step 2: Write the failing domain-shape tests**

```ts
import { describe, expect, it } from "vitest";
import { domainId, initialRoom } from "../src/index.js";

describe("initialRoom", () => {
  it("creates a draft with no mutable shared collections", () => {
    const room = initialRoom({
      id: domainId.room("room-1"), title: "Launch", task: "Plan launch",
      requirements: ["cite evidence"], acceptanceCriteria: ["plan is actionable"],
      backgroundPolicy: "pause_on_leave", createdAt: "2026-11-02T00:00:00.000Z",
    });
    expect(room.status).toBe("draft");
    expect(room.members).toEqual([]);
    expect(room.streamVersion).toBe(0);
    expect(Object.isFrozen(room)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the focused test and verify failure**

Run: `pnpm vitest run packages/room-domain/test/model.test.ts`

Expected: FAIL because `room-domain/src/index.ts` and its exports do not exist.

- [ ] **Step 4: Add exact domain primitives**

Define `Brand<string, Name>` IDs and `domainId` constructors that reject blank values. Define `RoomStatus` as `draft | team_review | ready | running | convergence_check | paused | awaiting_input | awaiting_approval | awaiting_acceptance | completed | archived`. Make aggregate arrays readonly and return frozen values from constructors. Define `DomainError` with codes `validation | conflict | retryable_adapter | permanent_adapter | timeout | approval_required | budget_exhausted | corrupt_data | status_unknown`.

- [ ] **Step 5: Run workspace checks**

Run: `pnpm install --frozen-lockfile=false && pnpm typecheck && pnpm test`

Expected: install creates `pnpm-lock.yaml`; typecheck and the domain test pass.

- [ ] **Step 6: Commit the foundation**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json vitest.config.ts .node-version apps packages
git commit -m "chore: initialize TeamRoom TypeScript workspace"
```

### Task 2: Event-Sourced Room Decisions

**Files:**
- Create: `packages/room-domain/src/commands.ts`, `events.ts`, `reducer.ts`, `decide.ts`
- Modify: `packages/room-domain/src/index.ts`
- Test: `packages/room-domain/test/decide.test.ts`, `reducer.test.ts`, `lifecycle.test.ts`

**Interfaces:**
- Consumes: `Room` and branded IDs from Task 1
- Produces: `RoomCommand`, `RoomEvent`, `EventEnvelope`, `decide(room, command)`, and `reduceRoom(room, envelope)`

- [ ] **Step 1: Write lifecycle decision tests**

```ts
it("requires team confirmation before a run starts", () => {
  const result = decide(draftRoom, { type: "StartRun", commandId, roomId });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "validation" }) });
});

it("allows only the user to accept a candidate", () => {
  const result = decide(awaitingAcceptanceRoom, {
    type: "AcceptCandidate", commandId, roomId, candidateId, actor: "facilitator",
  });
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run packages/room-domain/test/decide.test.ts packages/room-domain/test/lifecycle.test.ts`

Expected: FAIL because commands and decision functions are missing.

- [ ] **Step 3: Define discriminated command and event unions**

Include every command and event named in spec section 8. Every command carries `commandId`, `roomId`, and `expectedVersion`; `CreateRoom` requires expected version `0`. Actor-sensitive commands carry `actor: "user" | "facilitator" | RoomMemberId`. Use event payload interfaces and this envelope:

```ts
export interface EventEnvelope<E extends RoomEvent = RoomEvent> {
  readonly eventId: EventId;
  readonly roomId: RoomId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly causationId: CommandId | ActionId;
  readonly schemaVersion: 1;
  readonly event: E;
}
```

- [ ] **Step 4: Implement the pure decision table**

`decide(room: Room | null, command)` returns `Decision = { ok: true; events: readonly NewRoomEvent[] } | { ok: false; error: DomainError }`. Only `CreateRoom` accepts a null room. Encode legal source states explicitly, reject archived-room mutations, require a confirmed team before `StartRun`, require a candidate before acceptance, and emit no events on rejection.

- [ ] **Step 5: Write reducer tests before reducer code**

Test a full sequence from `RoomCreated` through `CandidateAccepted`, plus replaying the same list twice from a fresh initial state and obtaining deep-equal states. Test that a non-contiguous sequence raises `corrupt_data`.

- [ ] **Step 6: Implement `reduceRoom` and lifecycle helpers**

Define `reduceRoom(room: Room | null, envelope): Room`; only `RoomCreated` accepts null input. Return a new frozen state for every event and set `streamVersion` to the envelope sequence. Keep `assertTransition(from, to)` as a pure exported helper so lifecycle tests enumerate every permitted edge from the spec.

- [ ] **Step 7: Run and commit**

Run: `pnpm typecheck && pnpm test`

Expected: all domain suites pass.

```bash
git add packages/room-domain
git commit -m "feat: add event-sourced room lifecycle"
```

### Task 3: Templates, Messages, Routing, and Memory

**Files:**
- Modify: `packages/room-domain/src/model.ts`, `commands.ts`, `events.ts`, `decide.ts`, `reducer.ts`, `index.ts`
- Create: `packages/room-domain/src/routing.ts`
- Test: `packages/room-domain/test/templates.test.ts`, `routing.test.ts`, `memory.test.ts`

**Interfaces:**
- Consumes: Task 2 commands/events/reducer
- Produces: `PersonaTemplate`, `TeamTemplate`, room-member snapshots, `routeMessage(room, message)`, and memory edit decisions

- [ ] **Step 1: Add failing template-isolation tests**

Create a version-1 persona and team template, propose the team into a room, edit the room member's communication style, and assert that the original template object and version remain deep-equal to their pre-room values.

- [ ] **Step 2: Add failing message-routing tests**

```ts
expect(routeMessage(room, mentionedMessage)).toEqual({
  priorityMembers: [researcherId],
  facilitatorMustReview: true,
  referencedMessageIds: [],
});
expect(routeMessage(room, quotedReply).referencedMessageIds).toEqual([sourceMessageId]);
```

Also reject a mention of a member outside the room and a quote whose target is not in the same room.

- [ ] **Step 3: Add failing memory ownership tests**

Verify that a user can edit, pin, and remove any member's structured item; a member can propose an update to its own item; and one member cannot mutate another member's memory. Verify supported kinds are exactly `goal`, `fact`, `judgment`, `assumption`, `task`, and `completed`.

- [ ] **Step 4: Implement immutable template snapshots and routing**

Store source template ID and version on each room member. `routeMessage` must prioritize explicit mentions in message-link order, preserve stable quote/reply IDs, and return the facilitator as reviewer for unaddressed user messages without selecting all members.

- [ ] **Step 5: Implement typed memory decisions**

Require non-empty content, provenance message/event ID, and confidence from 0 to 1 for facts, judgments, and assumptions. Pinning prevents adapter-originated deletion but never prevents a user edit or removal.

- [ ] **Step 6: Run and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add packages/room-domain
git commit -m "feat: add team snapshots messaging and memory"
```

### Task 4: Runtime Ports and Deterministic Adapters

**Files:**
- Create: `packages/runtime-ports/src/index.ts`
- Create: `packages/test-adapters/src/scenario.ts`, `deterministic.ts`, `index.ts`
- Test: `packages/test-adapters/test/deterministic.test.ts`
- Create: `tests/fixtures/happy-path.json`, `tests/fixtures/failure-path.json`

**Interfaces:**
- Consumes: domain snapshot, message, action, candidate, and memory types
- Produces: `FacilitatorPort`, `PersonaPort`, `ToolPort`, `ClockPort`, `IdPort`, `ArtifactPort`, `UsagePort`, `NotificationPort`, and deterministic implementations

- [ ] **Step 1: Write compile-time and behavioral port tests**

Assert that the happy fixture returns two ordered actions then a candidate; the failure fixture returns retryable failure, approval required, timeout, and status unknown in that order. Assert repeated fixture runs produce identical IDs and timestamps.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run packages/test-adapters/test/deterministic.test.ts`

Expected: FAIL because runtime ports and fixture loader do not exist.

- [ ] **Step 3: Define the exact orchestration contracts**

```ts
export interface FacilitatorPort {
  plan(input: PlanInput): Promise<FacilitatorPlan>;
  evaluate(input: ConvergenceInput): Promise<ConvergenceDecision>;
}
export interface PersonaPort {
  act(input: PersonaActionInput): Promise<PersonaActionResult>;
}
export interface ToolPort {
  execute(input: ToolRequest): Promise<ToolResult>;
  reconcile(actionId: ActionId, idempotencyKey: string): Promise<ToolReconciliation>;
}
export interface ClockPort { now(): string; }
export interface IdPort { next(kind: IdKind): string; }
export interface ArtifactPort {
  put(input: ArtifactWrite): Promise<ArtifactRef>;
  get(id: ArtifactId): Promise<ArtifactRead | null>;
}
export interface UsagePort {
  current(roomId: RoomId): Promise<Usage>;
  charge(roomId: RoomId, delta: UsageDelta): Promise<Usage>;
}
export interface NotificationPort {
  publish(notification: RoomNotification): Promise<void>;
}
```

`ConvergenceDecision` is a discriminated union of `continue`, `request_input`, `request_approval`, `pause`, and `candidate`.

- [ ] **Step 4: Validate versioned scenario fixtures with Zod**

Use schema version `1`. Reject unknown fixture keys, blank IDs, negative usage, and action dependencies that reference missing actions. The happy fixture contains researcher and editor actions followed by a candidate satisfying both fixture acceptance criteria.

- [ ] **Step 5: Implement deterministic ports**

Consume scripted responses by stable call key rather than mutable global order. `DeterministicClock` advances only when the fixture requests it. `DeterministicIdPort` generates `kind-0001` style IDs independently per kind.

- [ ] **Step 6: Run and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add packages/runtime-ports packages/test-adapters tests/fixtures
git commit -m "feat: add deterministic runtime adapters"
```

### Task 5: Application Service and Autonomous Runner

**Files:**
- Create: `packages/room-engine/src/stores.ts`, `room-service.ts`, `runner.ts`, `index.ts`
- Test: `packages/room-engine/test/room-service.test.ts`, `runner.test.ts`, `pause.test.ts`, `budget.test.ts`

**Interfaces:**
- Consumes: domain `decide/reduceRoom`, runtime ports, deterministic adapters
- Produces: `RoomEventStore`, `SnapshotStore`, `TemplateStore`, `RoomService.execute`, `RoomService.load`, `AutonomousRunner.step`

- [ ] **Step 1: Write failing optimistic-command tests**

Use an in-memory test store. Execute `CreateRoom`, then execute a stale command with expected version `0`; assert `conflict` and assert the stream still has only the creation event.

- [ ] **Step 2: Define store and service signatures**

```ts
export interface RoomEventStore {
  load(roomId: RoomId, afterSequence?: number): Promise<readonly EventEnvelope[]>;
  append(roomId: RoomId, expectedVersion: number, events: readonly NewRoomEvent[]): Promise<readonly EventEnvelope[]>;
}
export interface SnapshotStore {
  load(roomId: RoomId): Promise<RoomSnapshot | null>;
  save(snapshot: RoomSnapshot): Promise<void>;
}
export interface TemplateStore {
  getPersona(id: PersonaTemplateId, version: number): Promise<PersonaTemplate | null>;
  putPersona(template: PersonaTemplate): Promise<void>;
  getTeam(id: TeamTemplateId, version: number): Promise<TeamTemplate | null>;
  putTeam(template: TeamTemplate): Promise<void>;
}
export class RoomService {
  load(roomId: RoomId): Promise<Room>;
  execute(command: RoomCommand): Promise<Room>;
}
```

`execute` loads state, calls `decide`, appends exactly once, reduces committed envelopes, and snapshots only after a configurable event interval.

- [ ] **Step 3: Implement and verify `RoomService`**

Run: `pnpm vitest run packages/room-engine/test/room-service.test.ts`

Expected: PASS for successful commands, rejected commands with no append, and stale-version conflict.

- [ ] **Step 4: Write autonomous-order and pause tests**

Create two independent actions whose deterministic adapters finish in reverse order. Assert committed `ActionCompleted` events follow plan position then action ID. Issue a pause between rounds and assert no further `ActionStarted` event is appended.

- [ ] **Step 5: Implement one safe autonomous step**

`step(roomId)` performs one planning/execution/evaluation cycle and returns `{ room, outcome }`, where outcome is `advanced | paused | awaiting_input | awaiting_approval | awaiting_acceptance | completed`. Execute dependency-free actions with `Promise.allSettled`, sort results deterministically before command submission, and convert adapter errors into typed action outcomes.

- [ ] **Step 6: Add budget and invalid-adapter tests**

Prove the runner emits a visible budget pause before starting an action that exceeds the remaining limit. Prove an invalid facilitator assignment and cross-member memory mutation become `permanent_adapter` failures rather than state mutations.

- [ ] **Step 7: Run and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add packages/room-engine
git commit -m "feat: orchestrate deterministic room runs"
```

### Task 6: SQLite Event Store, Templates, Snapshots, and Recovery

**Files:**
- Create: `packages/sqlite-store/migrations/001-initial.sql`
- Create: `packages/sqlite-store/src/database.ts`, `event-store.ts`, `snapshot-store.ts`, `template-store.ts`, `room-repository.ts`, `index.ts`
- Create: `packages/room-engine/src/recovery.ts`
- Test: `packages/sqlite-store/test/event-store.test.ts`, `migration.test.ts`, `snapshot.test.ts`, `template-store.test.ts`
- Test: `tests/integration/recovery.test.ts`, `tests/integration/concurrency.test.ts`

**Interfaces:**
- Consumes: Task 5 store contracts and Task 4 `ToolPort.reconcile`
- Produces: `openTeamRoomDatabase(path)`, SQLite store implementations, `recoverRoom(roomId)`

- [ ] **Step 1: Write migration and pragma tests**

Open a temporary database and assert `journal_mode` is `wal`, foreign keys are enabled, schema version is `1`, and all tables from spec section 11 exist. Reopen the same file and assert migration remains idempotent.

- [ ] **Step 2: Create the complete initial schema**

Include `schema_migrations`, `room_streams`, `room_events`, `room_snapshots`, `persona_templates`, `team_templates`, `messages`, `message_links`, `memory_items`, `runs`, `actions`, `candidate_results`, and `handoffs`. Use `(room_id, sequence)` as the event primary key and unique `event_id`; store canonical event and snapshot JSON plus indexed projection columns.

- [ ] **Step 3: Add optimistic-append tests before implementation**

Append at expected version 0, then attempt another append at expected version 0 and assert `conflict`. Verify the failed transaction changes neither stream version nor event count. Verify concurrent database connections cannot both win the same expected version.

- [ ] **Step 4: Implement transactional event append and load**

Use a single immediate transaction to read the stream version, compare it, assign contiguous sequences, insert canonical JSON, update the stream version, and commit. Map SQLite constraint failures to typed `conflict` or `corrupt_data` errors.

- [ ] **Step 5: Add snapshot-corruption tests and implementation**

Save a snapshot at event 20, append events 21–22, and assert load replays only 21–22. Corrupt the snapshot checksum and assert the repository ignores it and replays from event 1. Store `schema_version`, `last_sequence`, JSON, and SHA-256 checksum.

- [ ] **Step 6: Add immutable-template persistence tests**

Insert persona version 1, insert version 2, and assert both remain readable. Reject duplicate `(template_id, version)`. Persist a room-member edit and assert neither saved template row changes.

- [ ] **Step 7: Implement recovery reconciliation**

Find actions in `started` without a terminal event. Call `ToolPort.reconcile` with action ID and idempotency key. Commit a known success once, resume only a declared safe deterministic action, and emit `status_unknown` plus a room pause when completion cannot be proven.

- [ ] **Step 8: Run and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add packages/sqlite-store packages/room-engine/src/recovery.ts tests/integration
git commit -m "feat: persist and recover TeamRoom state"
```

### Task 7: Handoff Generation and CLI Demonstration

**Files:**
- Modify: `packages/room-domain/src/handoff.ts`, `index.ts`
- Create: `apps/teamroom-cli/src/main.ts`, `cli.ts`, `render.ts`
- Test: `packages/room-domain/test/handoff.test.ts`
- Test: `tests/integration/cli.test.ts`

**Interfaces:**
- Consumes: `RoomService`, `AutonomousRunner`, SQLite stores, canonical handoff types
- Produces: JSON/Markdown handoffs and `teamroom` CLI commands

- [ ] **Step 1: Write canonical handoff tests**

Assert JSON contains schema version, room/event position, task, requirements, acceptance checklist, candidate, decisions with message IDs, empty sources explicitly labeled `not_collected_in_phase_1`, unresolved issues, next actions, and artifacts. Assert Markdown omits the full transcript.

- [ ] **Step 2: Implement handoff builder and renderer**

Expose `buildHandoff(room): HandoffPackageV1` and `renderHandoffMarkdown(handoff): string`. Sort decisions and artifacts by event sequence; serialize JSON with stable key order and a trailing newline.

- [ ] **Step 3: Write CLI dispatch tests**

Invoke the CLI process against a temporary database for `init`, `room create`, `team propose`, `team confirm`, `run start`, `run step`, `message post`, `run pause`, `run resume`, `memory list`, `candidate accept`, `handoff export`, and `demo --fixture <path>`. Assert exit code 0 and parse stable JSON output under `--json`.

- [ ] **Step 4: Implement CLI commands with `node:util.parseArgs`**

Require `--db <path>` or `TEAMROOM_DB`. Support stable IDs in all human-readable output. `--json` writes only machine JSON to stdout and errors to stderr. Normal output delegates to `render.ts`; command handlers call engine services and never access SQLite tables directly.

- [ ] **Step 5: Add restart demonstration test**

Run one CLI process through a completed round, exit it, start a second process on the same database, and assert `room show --json` returns identical messages, memories, pending actions, status, and stream version before resuming.

- [ ] **Step 6: Run and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add packages/room-domain apps/teamroom-cli tests/integration/cli.test.ts
git commit -m "feat: add TeamRoom CLI and handoff export"
```

### Task 8: Acceptance, Fault Injection, and Operator Documentation

**Files:**
- Create: `tests/integration/acceptance.test.ts`, `fault-injection.test.ts`, `migration-fixtures.test.ts`
- Create: `docs/teamroom-cli.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: all Phase 1 public APIs and CLI commands
- Produces: a single `pnpm verify` release gate and reproducible operator walkthrough

- [ ] **Step 1: Encode the seven spec acceptance scenarios**

Create one named test per scenario in spec section 15.4. Use temporary databases and the committed happy/failure fixtures. Assert final event types, stream versions, room states, message links, memory ownership, candidate versions, and exported handoff contents rather than relying only on console text.

- [ ] **Step 2: Add fault-injection checkpoints**

Inject termination/reconstruction after event append, snapshot write, action start, simulated tool intent, action completion, and candidate submission. For each checkpoint, reopen the database, call recovery twice, and assert event IDs remain unique and no completed action gains a second completion event.

- [ ] **Step 3: Add migration fixture coverage**

Commit a schema-version-1 empty database fixture generated by the migration test, copy it into a temporary directory, reopen it, and assert a no-op migration plus successful room creation. Keep generated runtime databases out of Git.

- [ ] **Step 4: Write the operator walkthrough**

Document exact pnpm commands for install, verification, creating a sample database, running the happy fixture, pausing, closing the process, reopening, resuming, accepting a candidate, and exporting JSON and Markdown handoffs. State Phase 1 non-goals verbatim so the CLI is not mistaken for the finished plugin.

- [ ] **Step 5: Add and run the release gate**

Set `verify` to `pnpm typecheck && pnpm vitest run`. Run: `pnpm verify`.

Expected: all unit, integration, migration, recovery, CLI, and acceptance suites pass in a clean checkout.

- [ ] **Step 6: Confirm dependency boundaries**

Run: `rg -n "node:|better-sqlite3|zod|room-engine|sqlite-store" packages/room-domain`

Expected: no matches. Run: `git status --short` and confirm only Task 8 files are pending.

- [ ] **Step 7: Commit Phase 1 acceptance**

```bash
git add package.json tests docs/teamroom-cli.md
git commit -m "test: verify TeamRoom phase one acceptance"
```

## Completion Gate

After Task 8, run these commands from a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter teamroom-cli exec tsx src/main.ts --db .tmp/demo.db init
pnpm --filter teamroom-cli exec tsx src/main.ts --db .tmp/demo.db demo --fixture ../../tests/fixtures/happy-path.json
```

The implementation is ready for Phase 1 review only if the verification suite passes, the demo produces an accepted candidate and both handoff formats, restarting the CLI preserves the exact logical state, and `git status --short` is empty.
