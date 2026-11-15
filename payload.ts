// The JSON API's payload shapes that do not depend on the server's live state,
// kept apart from server.ts (which starts serving on import) so tests can build
// exactly what a route returns.

// How a client should present the fleet: which process counts and session
// kinds to tally, and when a Claude session counts as idle. Both /api/fleet and
// /api/fleet/<machine> carry these, so a one-machine view renders like a row of
// the full one.
export interface ViewSettings {
  session_idle_s: number;
  watch: { counts: string[]; sessions: string[] };
}

// GET /api/fleet/<machine>: one machine's snapshot plus the view settings.
export function machinePayload<M extends object>(view: ViewSettings, machine: M) {
  return { updated_at: new Date().toISOString(), ...view, ...machine };
}
