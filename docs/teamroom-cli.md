# TeamRoom Phase 1 operator walkthrough

This CLI demonstrates the persistent, headless room engine with deterministic adapters. A command runs in one process, commits to SQLite, and exits. Reopening the same database reconstructs the room from its snapshot and event stream. There is no service to keep running between commands.

Run the commands below in **PowerShell 7** from the repository root. The walkthrough uses `-Encoding utf8NoBOM`, which Windows PowerShell 5.1 does not support. Use the versions pinned in `.node-version` and `package.json`: Node.js 24.15.0 and pnpm 11.20.0.

## Install and verify

```powershell
pnpm install --frozen-lockfile
pnpm verify
```

`verify` runs `pnpm typecheck && pnpm vitest run`. The release gate includes unit, SQLite migration, concurrency, recovery, CLI, seven acceptance scenarios, and six fault-injection checkpoints. All tests use isolated temporary databases; normal verification never modifies the committed schema fixture.

## Run the happy fixture

Use a fresh path for each demonstration. The fixed fixture uses `room-1`, `run-1`, `researcher`, and `editor`; running `demo` twice against the same room is a conflict.

```powershell
New-Item -ItemType Directory -Force .tmp | Out-Null
pnpm teamroom --db .tmp/demo.db init
pnpm teamroom --db .tmp/demo.db demo --fixture tests/fixtures/happy-path.json
pnpm teamroom --db .tmp/demo.db room show --room room-1
```

The demo ends in `awaiting_acceptance`, with two successful actions, two persona messages, one researcher memory item, and candidate `candidate-1`. Its checklist covers both fixture criteria. The facilitator proposes the result; the user accepts it with a separate command:

```powershell
pnpm teamroom --db .tmp/demo.db candidate accept --room room-1 --id candidate-1
pnpm teamroom --db .tmp/demo.db handoff export --room room-1 --format json --output .tmp/demo-handoff.json
pnpm teamroom --db .tmp/demo.db handoff export --room room-1 --format markdown --output .tmp/demo-handoff.md
```

The room is now `completed`. Both exports include the accepted candidate, acceptance checklist, decisions and message references, source availability, unresolved issues, limitations, next actions, artifacts, and the room's event position. Each export commits its own `HandoffGenerated` event, so sequential exports have different event positions. The full transcript is not embedded. Sources are labeled `not_collected_in_phase_1`; fixture evidence is simulated, not live research.

The workspace filter is `@teamroom/cli`, matching the actual package name. Equivalent filtered commands execute from `apps/teamroom-cli`, so their paths differ:

```powershell
pnpm --filter @teamroom/cli exec tsx src/main.ts --db ../../.tmp/filtered-demo.db init
pnpm --filter @teamroom/cli exec tsx src/main.ts --db ../../.tmp/filtered-demo.db demo --fixture ../../tests/fixtures/happy-path.json
```

## Review a team, pause, close, reopen, and resume

Use a separate database to walk through the safe pause boundary. Generate a deterministic team file with the member identities required by the happy fixture:

```powershell
New-Item -ItemType Directory -Force .tmp | Out-Null
@('facilitator', 'researcher', 'editor') | ForEach-Object {
  [ordered]@{
    id = $_
    name = $_
    role = $(if ($_ -eq 'facilitator') { 'Facilitator' } else { 'Contributor' })
    responsibilities = @()
    domainPerspective = 'fixture'
    communicationStyle = 'clear'
    constraints = @()
    collaborationGuidance = @()
    isFacilitator = ($_ -eq 'facilitator')
    sourceTemplateId = $null
    sourceTemplateVersion = $null
  }
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8NoBOM .tmp/team.json

pnpm teamroom --db .tmp/walkthrough.db init
pnpm teamroom --db .tmp/walkthrough.db room create --id room-1 --title 'Research brief' --task 'Prepare a reviewed brief' --requirement 'Keep evidence traceable' --criterion 'Research includes evidence' --criterion 'Brief is edited and ready to review'
pnpm teamroom --db .tmp/walkthrough.db team propose --room room-1 --members .tmp/team.json
pnpm teamroom --db .tmp/walkthrough.db room show --room room-1
```

Review the `team_review` output before confirming. To adjust the proposed team, edit `.tmp/team.json` and run `team propose` again before confirmation.

```powershell
pnpm teamroom --db .tmp/walkthrough.db team confirm --room room-1
pnpm teamroom --db .tmp/walkthrough.db run start --room room-1 --id run-1
pnpm teamroom --db .tmp/walkthrough.db run step --room room-1 --fixture tests/fixtures/happy-path.json
pnpm teamroom --db .tmp/walkthrough.db memory list --room room-1 --member researcher
pnpm teamroom --db .tmp/walkthrough.db run pause --room room-1 --reason 'Close and reopen the operator session'
pnpm --silent teamroom --db .tmp/walkthrough.db --json room show --room room-1 | Set-Content -Encoding utf8NoBOM .tmp/before-restart.json
```

The research action has succeeded, its message and memory are committed, the dependent edit action remains planned, and the room is `paused`. Pause prevents new work from starting. During an in-flight action, the engine records pause intent and drains started work before reaching this stable boundary.

Every CLI command above has already closed its process. Close this terminal if desired. Open a new PowerShell terminal, return to this repository root, and run:

```powershell
pnpm --silent teamroom --db .tmp/walkthrough.db --json room show --room room-1 | Set-Content -Encoding utf8NoBOM .tmp/after-restart.json
if ((Get-Content -Raw .tmp/before-restart.json) -cne (Get-Content -Raw .tmp/after-restart.json)) {
  throw 'Room changed across restart'
}
pnpm teamroom --db .tmp/walkthrough.db run resume --room room-1
pnpm teamroom --db .tmp/walkthrough.db run step --room room-1 --fixture tests/fixtures/happy-path.json
pnpm teamroom --db .tmp/walkthrough.db room show --room room-1
pnpm teamroom --db .tmp/walkthrough.db candidate accept --room room-1 --id candidate-1
pnpm teamroom --db .tmp/walkthrough.db handoff export --room room-1 --format json --output .tmp/walkthrough-handoff.json
pnpm teamroom --db .tmp/walkthrough.db handoff export --room room-1 --format markdown --output .tmp/walkthrough-handoff.md
```

The restart comparison checks the entire room, including messages, links, private structured memory, pending actions, usage, and stream version. Resume completes the editor action without repeating research. The acceptance suite also checks exact process-restart equality after a completed round and after candidate acceptance.

## Messages and available controls

While a room is running or paused, these commands persist ordinary, mentioned, and quoted messages:

```powershell
pnpm teamroom --db .tmp/walkthrough.db message post --room room-1 --content 'Please continue'
pnpm teamroom --db .tmp/walkthrough.db message post --room room-1 --content 'Check the wording' --mention editor
pnpm teamroom --db .tmp/walkthrough.db message post --room room-1 --content 'Keep this evidence' --quote message-research
```

Run message examples before candidate acceptance if you want them included in the active discussion. Quote targets and mention targets must already belong to the room. `--json` produces JSON-only stdout; failures return a nonzero exit status and write errors to stderr. `TEAMROOM_DB` can supply the database path. Use `pnpm teamroom --help` for the implemented CLI commands.

The following controls are also available. Use the IDs shown by `room inspect`, `memory list`, and `events list`; each mutation validates the current lifecycle state.

```powershell
pnpm teamroom --db .tmp/walkthrough.db room list
pnpm teamroom --db .tmp/walkthrough.db room open --room room-1
pnpm teamroom --db .tmp/walkthrough.db room inspect --room room-1
pnpm teamroom --db .tmp/walkthrough.db events list --room room-1 --after 0
pnpm teamroom --db .tmp/walkthrough.db memory edit --room room-1 --id memory-research --content 'User-corrected evidence'
pnpm teamroom --db .tmp/walkthrough.db memory pin --room room-1 --id memory-research
pnpm teamroom --db .tmp/walkthrough.db memory pin --room room-1 --id memory-research --unpin
pnpm teamroom --db .tmp/walkthrough.db memory remove --room room-1 --id memory-research
pnpm teamroom --db .tmp/walkthrough.db action approve --room room-1 --id edit
pnpm teamroom --db .tmp/walkthrough.db action reject --room room-1 --id edit --reason 'Do not execute'
pnpm teamroom --db .tmp/walkthrough.db input provide --room room-1 --content 'Proceed with the reviewed direction'
pnpm teamroom --db .tmp/walkthrough.db candidate reject --room room-1 --reason 'Revise the evidence'
pnpm teamroom --db .tmp/walkthrough.db room archive --room room-1
```

These are individual controls, not a sequence to run unconditionally: approval/rejection requires the exact pending action ID, input requires `awaiting_input`, and candidate rejection requires `awaiting_acceptance`. After rejecting a candidate, use a fixture containing the next round and a new candidate ID, then `run step` and explicitly `candidate accept`. Archived rooms are read-only.

Templates are immutable versions. Persona JSON contains `id`, `version`, `name`, `role`, `responsibilities`, `domainPerspective`, `communicationStyle`, `constraints`, and `collaborationGuidance`. Team JSON contains `id`, `version`, `name`, and `members`; each member has `memberId`, a full `persona` template, and `isFacilitator`. Exactly one member is the facilitator. Save edits as a new version.

```powershell
pnpm teamroom --db .tmp/walkthrough.db template persona create --file .tmp/persona.json
pnpm teamroom --db .tmp/walkthrough.db template persona list
pnpm teamroom --db .tmp/walkthrough.db template team create --file .tmp/team-template.json
pnpm teamroom --db .tmp/walkthrough.db template team list
pnpm teamroom --db .tmp/walkthrough.db run recover --room room-1 --fixture tests/fixtures/failure-path.json
```

`run recover` reconciles started actions using the fixture's `reconciliations`, keyed by both action ID and idempotency key. `run step` performs the same reconciliation before any new work. Known success records an action summary and actual usage exactly once; missing, uncertain, or unstarted reconciliation pauses for review without redispatch. Use a fixture whose reconciliation keys match the interrupted actions. `tests/fixtures/failure-path.json` scripts simulated permanent/retryable failure, approval, timeout, and unknown completion status; it is a tool/recovery fixture, not a standalone `demo` scenario.

Completed waves retain a pending evaluation cursor and usage outcomes until the facilitator's decision commits. Restart evaluates that wave before planning or dispatching more work. Approval state retains the exact requested action ID. Older v1 snapshots without these fields are rebuilt from the existing event log; no database migration is needed. A token or cost cap makes action dispatch serial so usage can exceed a cap by at most one action's actual usage.

## Schema fixture maintenance

The committed `tests/fixtures/schema-v1-empty.sqlite` is an empty database produced by the migration test using the real migration entry point. Its migration timestamp is fixed for reproducibility. To intentionally regenerate it:

```powershell
$env:TEAMROOM_WRITE_MIGRATION_FIXTURE = '1'
try {
  pnpm vitest run tests/integration/migration-fixtures.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Migration fixture generation failed' }
} finally {
  Remove-Item Env:TEAMROOM_WRITE_MIGRATION_FIXTURE
}
```

Review the fixture change before committing. Ordinary runtime `.db`/`.sqlite` files, SQLite sidecars, and `.tmp/` output are ignored by Git; this released fixture is explicitly allowed.

## Phase 1 non-goals

Phase 1 does not include:

- a graphical interface;
- a real language-model provider;
- web search or live source collection;
- filesystem or command execution outside the deterministic test adapters;
- worktree creation;
- a background daemon or desktop notifications;
- automatic injection into a Codex chat;
- multiple human participants;
- cloud storage or cross-device synchronization; or
- a production plugin package.

These exclusions are hard scope boundaries. Phase 1 may define ports and data fields for future capabilities, but it must not add speculative implementations.
