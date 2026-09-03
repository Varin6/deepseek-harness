/**
 * Session Controller killJob delegation through the composed job registry.
 * The agent is a structural stub whose followup/inject mirror the runtime
 * agent's inbox placement (next-turn / next-step) and record the delivery the
 * command chooses for its owner's status; the producer hooks record the cancel
 * reason the registry forwards. killJob requires an attached agent, so every
 * case registers one directly — cold-session resolution (the shared `agentFor`
 * path) is covered by the other unaries.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createSessionTestRemote } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

function request<P>(payload: P): P {
  return payload
}

async function composed(withJobs = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  if (withJobs) {
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('session-killjob-test')
  }
  return ctx
}

/** Register one agent over a fresh session, recording followup/inject deliveries. */
function liveAgent(ctx: Context, id: string, status: AgentStatus = 'idle'): {
  session: Session
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
  setStatus: (next: AgentStatus) => void
} {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const followup = vi.fn((message: UserMessage) => { inbox.append('next-turn', message) })
  const inject = vi.fn((message: UserMessage) => { inbox.append('next-step', message) })
  // The Agent face publishes status read-only; the stub mirrors a lifecycle
  // transition through this cell so a case can end its in-flight turn.
  let current = status
  const agent = {
    id: session.id,
    session,
    inbox,
    get status() { return current },
    ctx,
    followup,
    inject,
  } as unknown as Agent
  ctx.agents.register(agent)
  return { session, agent, followup, inject, setStatus: (next: AgentStatus) => { current = next } }
}

/** A controllable producer: records forwarded cancel reasons, settles on demand. */
function producer(label = 'sleep 60') {
  let settle!: (outcome: JobOutcome) => void
  const cancels: (string | undefined)[] = []
  const spec = {
    kind: 'bash' as const,
    label,
    run: () => ({
      cancel: (reason?: string) => { cancels.push(reason) },
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      readOutput: () => '',
    }),
  }
  return { spec, cancels, settle: (outcome: JobOutcome) => { settle(outcome) } }
}

const remote = (ctx: Context) => createSessionTestRemote(ctx, {
  defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
  cwd: '/tmp',
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('sessions.killJob', () => {
  it('kills the owned live job and wakes the idle model with an inbox notice', async () => {
    const ctx = await composed()
    const { session, agent, followup, inject } = liveAgent(ctx, 'session-killjob')
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent })

    const result = await remote(ctx).killJob(request({ sessionId: session.id, jobId: id }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ result: 'requested' })

    // The registry forwarded the user stop as the cancel reason.
    expect(task.cancels).toEqual(['stopped by the user'])
    const snapshot = ctx.jobs.get(id, agent)
    expect(snapshot.status).toBe('stopping')
    // A user stop must not wait for a reader: the job is reported.
    expect(snapshot.reported).toBe(true)

    // An idle owner is woken so the stop is never an unclaimed notice.
    expect(followup).toHaveBeenCalledTimes(1)
    expect(inject).not.toHaveBeenCalled()
    const [message] = followup.mock.calls[0] as [UserMessage]
    expect(message.content).toEqual([{
      type: 'text',
      text: 'background job bash-1 (bash: sleep 60) was stopped by the user. Read its output with job_output.',
    }])
    expect(message.source).toMatchObject({
      kind: 'plugin',
      plugin: 'session-controller',
      form: 'notice',
      summary: 'bash sleep 60 stopped by the user',
    })
    expect([...agent.inbox.nextTurn].map(item => item.id)).toContain(message.id)
  })

  it('informs a busy model at its next step boundary', async () => {
    const ctx = await composed()
    const { session, agent, followup, inject, setStatus } = liveAgent(ctx, 'session-killjob-busy', 'running')
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent })

    const result = await remote(ctx).killJob(request({ sessionId: session.id, jobId: id }))
    expect(result.ok).toBe(true)
    expect(followup).not.toHaveBeenCalled()
    expect(inject).toHaveBeenCalledTimes(1)
    const [message] = inject.mock.calls[0] as [UserMessage]
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'session-controller', form: 'notice' })
    // The injected notice waits for the step boundary of the turn in flight.
    expect([...agent.inbox.nextStep].map(item => item.id)).toContain(message.id)

    // Let the in-flight turn end, then settle the job the producer owed.
    setStatus('idle')
    task.settle({ status: 'killed', detail: 'signal: SIGTERM' })
    await tick()
    expect(ctx.jobs.get(id, agent).status).toBe('killed')
  })

  it('answers already-finished without a notice or a cancel for a settled job', async () => {
    const ctx = await composed()
    const { session, agent, followup, inject } = liveAgent(ctx, 'session-killjob-settled')
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent })
    task.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    const result = await remote(ctx).killJob(request({ sessionId: session.id, jobId: id }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ result: 'already-finished' })
    expect(task.cancels).toEqual([])
    expect(followup).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
  })

  it('maps a job the session does not own to the registry fence error', async () => {
    const ctx = await composed()
    const { agent: aliceAgent } = liveAgent(ctx, 'session-killjob-alice')
    const { session: bob } = liveAgent(ctx, 'session-killjob-bob')
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: aliceAgent })

    const result = await remote(ctx).killJob(request({ sessionId: bob.id, jobId: id }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('gateway/internal')
      expect(result.error.message).toBe('job bash-1 belongs to another session')
    }
    expect(task.cancels).toEqual([])
  })

  it('answers not-found for a session with no attached agent', async () => {
    const ctx = await composed()

    const result = await remote(ctx).killJob(request({
      sessionId: sid('session-killjob-ghost'),
      jobId: JobId('bash-1'),
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('session/not-found')
      expect(result.error.message).toBe('session "session-killjob-ghost" not found (not attached)')
    }
  })

  it('fails loud when the composition mounts no job registry', async () => {
    const ctx = await composed(false)
    const { session } = liveAgent(ctx, 'session-killjob-no-jobs')

    const result = await remote(ctx).killJob(request({
      sessionId: session.id,
      jobId: JobId('bash-1'),
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('gateway/internal')
      expect(result.error.message).toBe(
        'background jobs are not mounted in this composition (load @deepseek-ai/dsh-jobs) for session "session-killjob-no-jobs"',
      )
    }
  })
})
