# Personal assistant context evaluation

The assistant's stable role contract is `assistantBrief` in `packages/core/src/shared/assistantPolicy.ts`.
It names three existing information owners: capability/device notes, projects, and personal Markdown memory.
Live device availability, grants and task state remain authoritative at their respective tools.
Capability targets and session hosts are distinct. The phone fixture exposes native actions but cannot host an engine; a capable computer executor receives the phone reference instead.
The full handbook is retrievable beside the assistant's working directory; it is not loaded for every greeting.
App submissions update the assistant through the existing first-party App message channel.

`working-context.md` in the assistant's existing memory directory is a recovery pointer, not another task database.
It holds unresolved constraints and their sources, task/project/device references, what is awaited, and the next step.
Before resuming work, the assistant locates it through that pointer or an already known task reference, then checks the actual task for completion, cancellation or newer instructions. A known task reference does not cover later constraints or waiting parties recorded only in the owner conversation or the note.
Stable personal facts stay in the ordinary memory entries and index. Neither a startup resource snapshot nor native compaction guarantees preservation of historical commitments.

## Controlled model runs

The cases in `scripts/assistant-eval/cases.ts` cover twelve common advanced personal-agent use-case themes
(daily briefing, inbox follow-up, research monitoring, travel, meetings, interrupted projects, content, bug fixing, invoices, household, purchases and specialist handoff),
plus Gugu-specific controls for simple conversation, explicit delegation, device outages, memory scope and resuming cancelled work.
They are synthetic tasks inspired by the themes; they are never included in production instructions.
AutoLibrary's index/body separation is a design reference; the assistant does not require that plugin.

Run a selected case in the foreground:

```sh
pnpm exec tsx scripts/assistant-eval/run.ts --case=travel-memory --out=/absolute/evidence/run-01
```

Omit `--case` to run all cases sequentially. Claude uses the current native SDK configuration and authentication;
no model or billing source is silently changed. Each case has a turn, duration and cost limit.
`--model-config=/absolute/private/model.json` explicitly selects a test model handoff containing `model` and `env`;
credentials stay outside the repository and are never printed. This is required when testing the product default through its dedicated test account.
The lease must cover the entire case deadline. An authentication retry aborts as `RIG-FAIL`; a successful pre-compact phase cannot make an interrupted recovery successful.
`--instructions=/absolute/template.md` compares an alternative brief on the same cases;
the template supports `{{ROOT}}`, `{{CWD}}` and `{{MEMORY}}` fixture paths.
Pair it with `--handbook=/absolute/handbook.md` when comparing a historical brief, so its on-demand rules do not accidentally use the new policy.
Use `--without-recovery` for a historical configuration that did not have the recovery hook.
Use a fresh output directory per run. The runner retains fixture files and native transcripts for inspection.

This mode runs the real model and native context/file tools, with simulated Gugu tools, device grants and task executors.
It measures routing and handoff behavior. `PASS` covers deterministic trace and artifact-integrity checks, with `semanticReview=required` for delegated work. A fixture artifact is **not** proof that a real phone, desktop application or remote agent completed work.
Session, project and library tools reuse production descriptions and schemas; messaging fixture descriptions track the production host without importing its runtime dependencies.
The ACP fixture has one canonical delivered input per turn. Like `runSessionAction`, it uses that host-observed source when the tool omits `source_link`; the raw arguments remain in the trace and explicit wrong links still fail. Do not apply this fallback to ambiguous or historical inputs.
Real product acceptance additionally requires an isolated signed-in product session, actual task-agent delivery,
device/app effects, and independently read-back artifacts. Record that evidence separately with its account, device and build.

## Judging evidence

`assessAssistantRun` uses observed tool effects and artifact read-back, not assertions made in the final response.
Its dimensions are delegation, device/project placement, continuity, necessary context, privacy, outcome, authority and context size.
It allows different valid tool sequences; it does not reward a fixed number of calls or a particular prose style.
An accepted spawn is insufficient without artifact inspection. Failed or unobserved model execution is `RIG-FAIL`, separate from `FAIL`.
Negative controls in `tests/unit/scripts/assistantEval.test.ts` prove that missing handoffs, wrong devices, lost facts,
unread artifacts, privacy leaks and unauthorized actions can fail independently of a plausible final answer.

For before/after comparisons, hold the cases, fixture facts, model/configuration, limits and evaluator fixed.
Keep per-case dimensions, raw transcripts, instruction characters, duration and estimated cost; do not present one aggregate score as reliability.
Repeat stochastic model runs before making a reliability claim. Human review checks the semantic quality of the handoff and final answer;
deterministic checks cannot alone judge whether a creative deliverable or research conclusion is good.
Configuration evidence records the case, input records, controlled executor artifact, loaded brief, handbook and generated script hashes. Per-case cost includes all compact/resume queries and shares the same one-dollar limit.

`native-compact-recovery` executes a real native `/compact` between delegation and resumption.
It separately checks that compaction happened, that the pending-work pointer was written before it, and that the model recovered through the pointer or verified the already known original task afterward.
This does not prove the preservation of work that was never saved before an automatic compaction or a crash.
`--materialization=/absolute/assistant-context.ts` uses the actual context builder from a dependent worktree, writes its plugin artifacts,
and executes the native hook scripts. The resource transport remains an isolated local fixture; no real device is invoked.

The three `native-compact-pending-*` cases persist a later owner decision **after** the real `/compact`, before resumption.
The task snapshot and pre-compact history do not contain the legal reviewer or pending confirmation. Only the dedicated note and source conversation contain them.
The short, oversize and unreadable variants check recovery through the bounded snapshot, full-file read or original conversation respectively.
Reading a known task alone can therefore pass task continuity while independently failing pending-constraint recovery.
The final answer must still identify the pending confirmation and waiting party; artifact read-back alone is insufficient.
An unreadable-note variant uses a dangling symlink inside the isolated fixture, never a real personal memory file.

## Native trace assessment and counterexamples

`native-evidence.ts` parses actual assistant tool uses and their user tool results. API request snapshots repeat historical calls and are excluded. A requested but disabled Bash call is a failed request, not shell execution; missing results stay unresolved. Logical Gugu failures are checked independently of transport success.

Native trajectory checks include accepted nested executors, project and source references, necessary handoff facts, memory scope, coordinator edits, executor edits, parent read-back, actual attachment delivery and authority. Parent shell execution also fails the local coordinator contract. A writer may legitimately use Bash or an App API: no native Write/Edit then yields `UNVERIFIED`, not a false product failure. Independent artifact read-back and semantic review remain required even for trace PASS.

Earlier native runs shaped the contract; their transcripts are not part of this repository:

- A coordinator that authored slides, README or packaging itself failed its trajectory even with an intact artifact. The short role contract therefore names assembly, documentation and packaging as executor work.
- Missing historical inputs are a fixture error, not a policy failure: asking for absent facts is valid. Fixtures provide inspectable versioned records and project notes, and executor outputs are substantive drafts.
- A recovery run that preserved a cancellation but then guessed chat/session addresses from a task identifier still fails. Recovery and handoff instructions keep complete typed references, use `session_get` for tasks and look up a chat only by a known `chat_id`.
- The dedicated recovery note is excluded from personal memory cards; ordinary memory entries keep the existing YAML name/description/type metadata and Markdown bodies.
- Native CLIs may load an ancestor `~/.claude/CLAUDE.md` as project instructions. Managed local assistant settings exclude ancestor coding instructions without changing the owner's files, and all local prepare/refresh/start paths install the same short brief. One-off executors in the managed assistant workspace receive an execution contract, no personal auto-memory and no assistant startup/recovery subscription.

A single successful retry is not a reliability percentage; repeat runs before claiming one.
