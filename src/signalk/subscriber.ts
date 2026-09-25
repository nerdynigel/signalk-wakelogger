import type { Delta, ServerAPI, Unsubscribes } from '@signalk/server-api'
import { SIGNALK_PATHS } from './paths'
import { OBSERVATION_PATHS } from '../race/observations'

export function subscribeToTelemetry(app: ServerAPI, callback: (delta: Delta) => void): () => void {
  const paths = [...new Set([...SIGNALK_PATHS, ...OBSERVATION_PATHS])]
  const unsubscribes: Unsubscribes = []
  app.subscriptionmanager.subscribe(
    {
      context: 'vessels.self' as never,
      subscribe: paths.map((path) => ({ path: path as never, policy: 'instant' as const, minPeriod: 100 })),
      sourcePolicy: 'preferred'
    },
    unsubscribes,
    (error) => app.error(`Wake Logger subscription error: ${safeError(error)}`),
    callback
  )
  return () => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
