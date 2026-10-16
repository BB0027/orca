// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalBrowserRetention } from './use-terminal-browser-retention'

const mocks = vi.hoisted(() => ({
  guests: new Map<string, HTMLElement>(),
  downloads: new Set<string>(),
  driven: new Set<string>(),
  discard: vi.fn(),
  state: {
    settings: { browserGuestWorktreeRetentionBudget: true },
    activeWorktreeId: 'wt',
    activeTabType: 'terminal',
    activeBrowserTabId: 'browser',
    browserTabsByWorktree: { wt: [{ id: 'browser', pageIds: ['page'] }] }
  }
}))
vi.mock('../store', () => ({
  useAppStore: { getState: () => mocks.state, subscribe: () => () => {} }
}))
vi.mock('./browser-pane/host-guest/webview-registry', () => ({ webviewRegistry: mocks.guests }))
vi.mock('./browser-pane/host-guest/browser-guest-discard-probe', () => ({
  canDiscardBrowserGuest: async () => true
}))
vi.mock('./browser-pane/host-guest/browser-guest-paint-retention', () => ({
  browserPageNeedsPaintRetention: (id: string) => mocks.driven.has(id),
  onBrowserGuestPaintRetentionChange: () => () => {}
}))
vi.mock('./browser-pane/navigate/browser-page-download-activity', () => ({
  hasActiveBrowserPageDownload: (id: string) => mocks.downloads.has(id),
  installBrowserPageDownloadActivityTracking: () => () => {}
}))
vi.mock('../store/slices/browser-webview-cleanup', () => ({
  discardRetainedBrowserGuest: (id: string) => {
    mocks.discard(id)
    mocks.guests.delete(id)
  }
}))

describe('browser guest retention lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.guests.clear()
    mocks.downloads.clear()
    mocks.driven.clear()
    mocks.discard.mockClear()
    mocks.state.activeTabType = 'terminal'
    mocks.guests.set('page', document.createElement('div'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts a hidden page in the active worktree while retaining its tab state', async () => {
    const { unmount } = renderHook(() =>
      useTerminalBrowserRetention({ browserGuestRetentionBudgetEnabled: true })
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.discard).toHaveBeenCalledWith('page')
    expect(mocks.state.browserTabsByWorktree.wt[0].pageIds).toEqual(['page'])
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('protects a selected page before its DOM has been laid out', async () => {
    mocks.state.activeTabType = 'browser'
    const { unmount } = renderHook(() =>
      useTerminalBrowserRetention({ browserGuestRetentionBudgetEnabled: true })
    )
    await vi.advanceTimersByTimeAsync(180_000)
    expect(mocks.discard).not.toHaveBeenCalled()
    unmount()
  })

  it.each(['download', 'remote viewer'])('retains an active %s', async (reason) => {
    const protectedIds = reason === 'download' ? mocks.downloads : mocks.driven
    protectedIds.add('page')
    const { unmount } = renderHook(() =>
      useTerminalBrowserRetention({ browserGuestRetentionBudgetEnabled: true })
    )
    await vi.advanceTimersByTimeAsync(180_000)
    expect(mocks.discard).not.toHaveBeenCalled()
    protectedIds.clear()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.discard).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.discard).toHaveBeenCalledWith('page')
    unmount()
  })

  it('honors the existing opt-out', async () => {
    const { unmount } = renderHook(() =>
      useTerminalBrowserRetention({ browserGuestRetentionBudgetEnabled: false })
    )
    await vi.advanceTimersByTimeAsync(180_000)
    expect(mocks.discard).not.toHaveBeenCalled()
    unmount()
  })
})
