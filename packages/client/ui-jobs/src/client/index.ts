/**
 * Background-job plugin, browser half: contributes one session-header action
 * that renders this session's `ctx.jobs` records. Job rows arrive entirely
 * through the `jobsBySession` list mirror; stopping a job routes through the
 * session face, whose Host command tells the session's model.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the `ctx.sessions` declaration merge and the `ISession` face
// (whose stop verb the inject closure calls).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { JobListAction, type JobListActionInjected } from './JobListAction.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, NS, zh, type JobKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}

export type { JobListActionProps } from './JobListAction.tsx'

/** Required services for locale registration and header-slot contribution. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.sessions
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-job: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'job-list',
      // After the subagent catalog: session lineage reads before process work.
      order: 20,
      locale: NS,
      inject: (sessionId): JobListActionInjected => ({
        killJob: (jobId: string) => {
          const session = sessions.binding(sessionId)?.session
          if (session === undefined) return
          void session.killJob(jobId).catch(() => {
            // A stop failure is published through the Session promptError; the
            // row itself updates from the jobs control frame the Host
            // broadcasts after the registry settles the kill.
          })
        },
      }),
    }, JobListAction),
  )
}
