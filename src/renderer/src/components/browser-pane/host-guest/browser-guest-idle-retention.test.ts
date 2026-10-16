import { describe, expect, it, vi } from 'vitest'
import {
  createBrowserGuestIdleRetention,
  selectIdleBrowserGuests
} from './browser-guest-idle-retention'

function fixture() {
  let now = 0
  const guests = new Map([['page', {}]])
  const protectedIds = new Set<string>()
  const canDiscard = vi.fn(async (_guest: object) => true)
  const discard = vi.fn((id: string) => {
    guests.delete(id)
  })
  const retention = createBrowserGuestIdleRetention({
    getGuests: () => guests,
    isProtected: (id) => protectedIds.has(id),
    canDiscard,
    discard,
    now: () => now
  })
  return {
    ...retention,
    guests,
    protectedIds,
    canDiscard,
    discard,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('browser guest page budget', () => {
  it('limits individual hidden pages, with a grace period for quick returns', () => {
    const guests = Array.from({ length: 6 }, (_, i) => ({ id: `page-${i}`, hiddenSinceMs: i }))
    expect(selectIdleBrowserGuests(guests, 29_999)).toEqual([])
    expect(selectIdleBrowserGuests(guests, 30_005)).toEqual(['page-1', 'page-0'])
  })

  it('expires even the last hidden page after two minutes', async () => {
    const f = fixture()
    await f.sweep()
    f.advance(119_999)
    await f.sweep()
    expect(f.discard).not.toHaveBeenCalled()
    f.advance(1)
    await f.sweep()
    expect(f.discard).toHaveBeenCalledWith('page')
  })

  it('keeps visible, downloading or remotely driven guests outside eviction', async () => {
    const f = fixture()
    f.protectedIds.add('page')
    await f.sweep()
    f.advance(1_000_000)
    await f.sweep()
    expect(f.canDiscard).not.toHaveBeenCalled()
    f.protectedIds.clear()
    await f.sweep()
    expect(f.discard).not.toHaveBeenCalled()
  })

  it('rechecks protection after the asynchronous document probe', async () => {
    const f = fixture()
    await f.sweep()
    f.advance(120_000)
    let resolve!: (safe: boolean) => void
    f.canDiscard.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const pending = f.sweep()
    f.protectedIds.add('page')
    resolve(true)
    await pending
    expect(f.discard).not.toHaveBeenCalled()
  })

  it('fences a late probe when a page is shown then hidden during an in-flight pass', async () => {
    const f = fixture()
    await f.sweep()
    f.advance(120_000)
    let resolve!: (safe: boolean) => void
    f.canDiscard.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const pending = f.sweep()
    f.protectedIds.add('page')
    await f.sweep()
    f.protectedIds.clear()
    await f.sweep()
    expect(f.canDiscard).toHaveBeenCalledTimes(1)
    resolve(true)
    await pending
    expect(f.discard).not.toHaveBeenCalled()
  })

  it('does not discard a replacement guest that reuses the page ID', async () => {
    const f = fixture()
    await f.sweep()
    f.advance(120_000)
    f.canDiscard.mockImplementation(async () => {
      f.guests.set('page', {})
      return true
    })
    await f.sweep()
    expect(f.discard).not.toHaveBeenCalled()
  })

  it('keeps editable or unreadable pages', async () => {
    const f = fixture()
    await f.sweep()
    f.advance(120_000)
    f.canDiscard.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('guest gone'))
    await f.sweep()
    await f.sweep()
    expect(f.discard).not.toHaveBeenCalled()
  })

  it('cancels in-flight disposal on teardown', async () => {
    const f = fixture()
    await f.sweep()
    f.advance(120_000)
    f.canDiscard.mockImplementation(async () => {
      f.dispose()
      return true
    })
    await f.sweep()
    expect(f.discard).not.toHaveBeenCalled()
  })
})
