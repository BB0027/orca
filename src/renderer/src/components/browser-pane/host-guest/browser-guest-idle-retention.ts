export const HIDDEN_BROWSER_GUEST_LIMIT = 4
export const HIDDEN_BROWSER_GUEST_GRACE_MS = 30_000
export const HIDDEN_BROWSER_GUEST_TTL_MS = 120_000

type HiddenGuest = { id: string; hiddenSinceMs: number }

export function selectIdleBrowserGuests(guests: readonly HiddenGuest[], nowMs: number): string[] {
  return [...guests]
    .sort((a, b) => b.hiddenSinceMs - a.hiddenSinceMs || a.id.localeCompare(b.id))
    .filter((guest, index) => {
      const age = nowMs - guest.hiddenSinceMs
      return (
        age >= HIDDEN_BROWSER_GUEST_TTL_MS ||
        (index >= HIDDEN_BROWSER_GUEST_LIMIT && age >= HIDDEN_BROWSER_GUEST_GRACE_MS)
      )
    })
    .map((guest) => guest.id)
}

type RetentionDependencies<Guest> = {
  getGuests: () => ReadonlyMap<string, Guest>
  isProtected: (id: string, guest: Guest) => boolean
  canDiscard: (guest: Guest) => Promise<boolean>
  discard: (id: string) => void
  now?: () => number
}

export function createBrowserGuestIdleRetention<Guest>(deps: RetentionDependencies<Guest>) {
  const hidden = new Map<string, { guest: Guest; hiddenSinceMs: number }>()
  const now = deps.now ?? Date.now
  let running = false
  let disposed = false

  async function sweep(): Promise<void> {
    if (disposed) {
      return
    }
    const guests = deps.getGuests()
    for (const id of hidden.keys()) {
      if (!guests.has(id)) {
        hidden.delete(id)
      }
    }
    for (const [id, guest] of guests) {
      if (deps.isProtected(id, guest)) {
        hidden.delete(id)
      } else if (hidden.get(id)?.guest !== guest) {
        hidden.set(id, { guest, hiddenSinceMs: now() })
      }
    }
    if (running) {
      return
    }
    running = true
    try {
      const candidates = selectIdleBrowserGuests(
        [...hidden].map(([id, entry]) => ({ id, hiddenSinceMs: entry.hiddenSinceMs })),
        now()
      )
      for (const id of candidates) {
        const entry = hidden.get(id)
        if (disposed) {
          break
        }
        if (!entry) {
          continue
        }
        let safe = false
        try {
          safe = await deps.canDiscard(entry.guest)
        } catch {
          // An unreadable guest keeps its page state.
        }
        if (disposed) {
          break
        }
        const current = deps.getGuests().get(id)
        // Recheck after the asynchronous probe: activation and guest replacement can race it.
        if (current !== entry.guest || hidden.get(id) !== entry) {
          continue
        }
        if (deps.isProtected(id, entry.guest)) {
          hidden.delete(id)
        } else if (safe) {
          deps.discard(id)
          hidden.delete(id)
        }
      }
    } finally {
      running = false
    }
  }

  return {
    sweep,
    dispose: () => {
      disposed = true
      hidden.clear()
    }
  }
}
