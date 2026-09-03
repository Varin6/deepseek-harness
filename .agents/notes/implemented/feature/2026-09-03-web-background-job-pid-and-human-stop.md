# Agent Note: Web background-job pid and human stop

Status: implemented

English | [中文](2026-09-03-web-background-job-pid-and-human-stop.zh.md)

## Problem

The [Web background-job display](2026-08-08-web-background-job-display.md) shipped a list a human could read but not act on: the session header showed which background jobs the session owns, and the only stop path was the model's `job_kill` tool. A person watching a runaway command or a stuck build had to type an instruction into the composer and wait for the model to translate it into a tool call.

The same list could not say which OS process a live row was. The subprocess service spawns every one of these jobs and terminates by tree root, yet the row carried no process identity, so correlating the list with a task manager or `ps` output had nothing to correlate.

The display note deferred the stop verb deliberately: `kill()` marks terminal delivery `reported`, suppressing the completion notice `dsh-tool-jobs` delivers, so a human interrupt written without a model-facing notice would leave the model believing its job is still running. This note settles that decision.

## Decision

Process identity travels the existing job-data channel, and the stop verb is a new session-fact RPC whose host command tells the model.

### Process identity: `ShellProcess.pid` to the row

`SubprocessHandle.pid` is the spawned tree root — the identity the subprocess service's termination verb targets — and is `-1` when the spawn itself failed. [`LocalBashExecutor`](../../../../packages/shell/bash-local/src/index.ts) and [`PwshLocalExecutor`](../../../../packages/shell/pwsh-local/src/index.ts) publish it as `ShellProcess.pid`, absent when the spawn failed, so the executor seam's handle carries the same identity its `kill()` terminates.

The shell tools forward that fact to the job they register:

```ts ignore-check
...proc.pid === undefined ? {} : { meta: { pid: proc.pid } }
```

`JobHooks` gains an open field for exactly this:

```ts ignore-check
/**
 * JSON-safe producer facts captured at start, e.g. the spawned process's
 * tree-root pid. The registry copies them into every snapshot of the job;
 * the producer must not mutate the record after supplying it.
 */
meta?: Readonly<Record<string, JsonValue>>
```

`LocalJobRegistry` stores the record and copies it into every snapshot — a fresh copy per snapshot, present iff supplied — and the Session Controller's `jobView` projects it onto the wire's `SessionJob.meta`. The field is deliberately an open JSON-safe map rather than a typed `pid`: the registry does not know what a pid is, the channel costs the same either way, and one producer fact does not earn a closed wire vocabulary.

The [ui-jobs](../../../../packages/client/ui-jobs/README.md) row renders `meta.pid` as a `#<pid>` chip on live rows only, with a locale tooltip (`Process {pid}` / `进程 {pid}`). Settled rows render no chip even when the snapshot still carries the meta, and a non-number `pid` renders nothing.

The chip is data, not control: the stop button addresses the job id, and nothing sends the pid to a kill. A recycled pid cannot target a wrong process because no path reads it for termination.

### The stop verb: `session.killJob`

The Session Controller gains one unary beside `cancel`:

```ts ignore-check
killJob(request: SessionJobKillRequest): SessionJobKillValue
// SessionJobKillRequest { sessionId: SessionId; jobId: JobId }
// SessionJobKillValue   { result: 'requested' | 'already-finished' }
```

The host command resolves the session's live `Agent` (`session/not-found` when none is attached), reads `ctx.get('jobs')` — a `gateway/internal` naming the missing `@deepseek-ai/dsh-jobs` plugin when the composition mounts no registry, because it is an optional peer — and then calls `jobs.kill(jobId, agent, 'stopped by the user')`. Ownership is fenced by the registry's own session-id check, so a cross-session kill answers with the registry's `job … belongs to another session` error, which the gateway maps to `gateway/internal`. Unlike `cancel`, the command carries no subagent guard: a subagent session's live child agent is a valid caller for the jobs it owns.

A kill of a settled job answers `already-finished` and delivers nothing.

### The model notice

`kill()` marks the record `reported` — the [job runtime's](../architecture/2026-06-20-generic-long-running-tool-runtime.md) suppression bit — so the completion notice `dsh-tool-jobs` would deliver is suppressed. The stop still reaches the model, framed as a user action, as a plugin-sourced `form: 'notice'` user message the command appends to the owner's inbox with the delivery terms the [completion-wake decision](2026-08-11-background-job-completion-wakes-an-idle-owner.md) gives tool-jobs for completions: an idle owner is woken (`followup`), a busy owner receives the message at its next step boundary (`inject`).

The wake is unconditional where tool-jobs budgets it. The budget exists because completions arrive in bursts; a human stop is a rare deliberate act, and the failure mode of an unclaimed notice is precisely the one the deferred decision named — the model believing its job is still running.

The message names the job, its kind and label, that a user stopped it, and points at `job_output`:

> background job bash-3 (bash: sleep 60) was stopped by the user. Read its output with job_output.

Its source summary is `<kind> <label> stopped by the user`.

The message satisfies model-visible ⟺ logged by the mechanism every in-session notice uses: the agent loop admits inbox messages as `user/message` session events at the step boundary that consumes them, so the log carries the message before any model request can. No new session-event type is required. The stop's remaining state — the job settled `killed` — is registry state, process-local like every job record, and the owner observes it through `job_output`'s status line.

### The client side

The ui-jobs entry registers with an inject face:

```ts ignore-check
killJob(jobId: string): Promise<RemoteResult<{ result: 'requested' | 'already-finished' }>>
```

Apply wires it through `ctx.sessions`: the injected callback resolves the addressed session's binding and calls the session face's `killJob`. A stop failure publishes through the session's `promptError`; the row itself needs no error state, because the registry's `stopping` frame arrives for any requested kill and the `killed` frame arrives when the producer settles.

Live rows render a square stop button, its accessible name and tooltip owned by the locale (`Stop job` / `停止任务`), disabled while the row is `stopping` or when no callback is injected. Settled rows render no button.

The client `Session` face's `killJob` brands its argument through the cordis-free `@deepseek-ai/dsh-jobs/brand` leaf — the same arrangement the `SessionJob` wire type already uses — so the tsdown client gate's `INLINE_SAFE` list admits exactly that anchored specifier while the bare `dsh-jobs` root stays rejected (it reaches `dsh-agent`).

## Alternatives considered

**Letting the tool-jobs completion notice carry the stop.** Do not mark `reported` on a user kill, and let the registry's settlement deliver the ordinary completion notice. Rejected on framing and timing: the notice is worded as a settlement (`killed`, signal detail) rather than as a user action, and it fires from the settlement listener after the producer's `done` settles — a window in which the model can act on a job a human already stopped. The command owns both the framing and the delivery terms.

**A dedicated session log event for the stop.** Model-visible ⟺ logged could be read as requiring a new event type. The notice's `user/message` admission already records the model-visible input in the log, by the same vehicle tool-jobs notices and every other in-session notice use; a second event would double-record one fact.

**Routing the stop through `cancel`.** `cancel` aborts the session's active turn — the [composer's stop button](../bug-fix/2026-07-31-web-stop-preserves-queue.md) owns that control; the job outlives the turn, because the job belongs to the subprocess service, not to the turn. The two controls address different resources and share nothing.

**A browser-reachable registry.** The browser has no `ctx.jobs`, and giving it one would move job ownership authorization into a new surface. Every job control crosses the wire through the session face, same as `cancel`.

**A stop flow that reads the job's output.** The web path never calls `ctx.jobs.read()` — the display note pins that invariant, because the single output cursor is the model's.

## Testing

[`session-killjob.host.spec.ts`](../../../../packages/api/session-controller/tests/session-killjob.host.spec.ts) pins the host command on a composed registry: the idle wake and the busy next-step injection each carry the exact notice text and source, an already-settled kill answers `already-finished` without a notice or a cancel, a cross-session kill maps to the registry fence error, a ghost session answers `session/not-found`, and a composition without the registry fails loud with the plugin name in the message.

[`control-jobs.host.spec.ts`](../../../../packages/api/session-controller/tests/control-jobs.host.spec.ts) pins the wire projection: a row produced with `meta: { pid: 4321 }` carries it into the frame, and the internal registry fields still do not.

The [`jobs-local`](../../../../packages/jobs/jobs-local/tests/jobs.spec.ts) spec pins the copy semantics: every snapshot gets its own copy of the meta record, a mutated first snapshot never leaks into later reads, and absence stays absent.

The executor specs pin the identity source: `ShellProcess.pid` is the spawned shell's own `$$` / `$PID`, and a failed spawn publishes no pid. The tool specs pin the hand-off: a background `bash`/`pwsh` registration carries `meta.pid`, and a process handle without a pid registers no `meta` at all.

The ui-jobs suites pin the presentation (chip on live rows with the locale tooltip; suppressed for settled, missing, and non-number pids; button click routing, disabled while stopping and without a callback, absent on settled rows) and the apply-side routing (a bound session routes to the session face, an unbound one is a no-op, a rejection is swallowed by the documented `promptError` publication).

The keyless [web e2e scenario](../../../../apps/web/tests/background-job-list.e2e.ts) renders the new row: its goldens carry a `{{pid}}`-redacted chip and the stop button. The redaction is scoped to the scenario's region — the same `#<digits>` shape is a stable request counter in other web goldens, so it must not be tokenized globally.

## Consequences

**Every human stop is a model-visible wake or injection.** A session whose job a user stops while the model is idle pays one model request it would not otherwise spend. Accepted: the alternative is a stop the model never learns about, and tool-jobs already accepts the same cost for completions.

**`reported` is the hinge of the design.** If the kill notice is ever dropped, no other reporter exists — the model's only account of the stop is that message. The killjob spec asserts the notice and the `reported` settlement together, so the coupling fails loud.

**The wire's `meta` is an open channel.** Any producer can declare arbitrary JSON-safe facts and every consumer sees them. The pid chip is the first reader; the field's contract is producer-owned facts, not process identity. A producer that mutates its record after supplying it violates the contract, and the fresh copy per snapshot is what keeps that violation from propagating silently.

**`stopping` becomes a state a human can hold.** The registry transition existed for the model's `job_kill`; the button's disabled-while-stopping state means the UI now sits in it for the full TERM-to-KILL grace — immediate on Windows, the grace window on POSIX.

**The brand leaf is in the client's inline set.** `INLINE_SAFE` admits `@deepseek-ai/dsh-jobs/brand$` and nothing more of that package; the root stays rejected.
