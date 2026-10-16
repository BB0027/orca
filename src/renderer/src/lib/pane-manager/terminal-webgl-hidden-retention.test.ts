import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal, PaneManagerOptions } from './pane-manager-types'
import { resumePaneRendering, suspendPaneRendering } from './pane-rendering-control'
import { PaneManager } from './pane-manager'
import { primeTerminalWebglAddon } from './pane-webgl-renderer'
import {
  releaseHiddenWebglRetention,
  resetHiddenWebglRetentionForTest,
  retainedHiddenWebglOwnerCountForTest,
  tryRetainHiddenPanesWebgl,
  type HiddenWebglRetentionOwner
} from './terminal-webgl-hidden-retention'

function createPane(withAddon = true): ManagedPaneInternal {
  return {
    // options mirrors the real Terminal: suspend parks cursorBlink here.
    terminal: { blur: vi.fn(), options: { cursorBlink: true } },
    webglAddon: withAddon
      ? ({ dispose: vi.fn() } as unknown as ManagedPaneInternal['webglAddon'])
      : null,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    webglAttachFailedSinceRecovery: false,
    gpuRenderingEnabled: true,
    pendingWebglRefreshRafId: null
  } as unknown as ManagedPaneInternal
}

function retentionFor(owner: HiddenWebglRetentionOwner, panes: ManagedPaneInternal[]) {
  return { owner, livePanes: () => panes }
}

// panes is private, and the retention branch is only reachable through a mounted pane.
function managerWithPane(pane: ManagedPaneInternal, options: Partial<PaneManagerOptions>) {
  const manager = new PaneManager({} as HTMLElement, options as PaneManagerOptions)
  Object.assign(manager, { panes: new Map([[1, pane]]) })
  return manager
}

describe('terminal-webgl-hidden-retention', () => {
  beforeEach(() => {
    resetHiddenWebglRetentionForTest()
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetHiddenWebglRetentionForTest()
    vi.useRealTimers()
  })

  it('suspend retains live WebGL addons and still defers attachment', () => {
    const owner = {}
    const panes = [createPane(), createPane()]
    suspendPaneRendering(panes, retentionFor(owner, panes))
    expect(panes.every((pane) => pane.webglAttachmentDeferred)).toBe(true)
    expect(panes.every((pane) => pane.webglAddon != null)).toBe(true)
    expect(panes.every((pane) => vi.mocked(pane.terminal.blur).mock.calls.length === 1)).toBe(true)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(1)
  })

  it('suspend without retention context disposes addons (window-level callers unchanged)', () => {
    const panes = [createPane()]
    const addon = panes[0].webglAddon
    suspendPaneRendering(panes)
    expect(addon?.dispose).toHaveBeenCalled()
    expect(panes[0].webglAddon).toBeNull()
  })

  it('disposes a floating manager context on hide so reopen cannot reuse a corrupt atlas', () => {
    const pane = createPane()
    const addon = pane.webglAddon
    managerWithPane(pane, { retainHiddenWebgl: false }).suspendRendering()
    expect(addon?.dispose).toHaveBeenCalledTimes(1)
    expect(pane.webglAddon).toBeNull()
    expect(pane.webglAttachmentDeferred).toBe(true)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
  })

  // Why: pins the option's polarity — an inverted default would silently strand
  // every ordinary worktree on the dispose branch.
  it('retains an ordinary manager context on hide', () => {
    const pane = createPane()
    managerWithPane(pane, {}).suspendRendering()
    expect(pane.webglAddon).not.toBeNull()
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(1)
  })

  it('does not extend the hidden deadline when a suspended manager hides again', () => {
    const pane = createPane()
    const manager = managerWithPane(pane, {})
    manager.suspendRendering()
    vi.advanceTimersByTime(20_000)
    manager.suspendRendering()
    vi.advanceTimersByTime(10_000)
    expect(pane.webglAddon).toBeNull()
  })

  it('resumes a warm tab without rebuilding and cancels its expiry', () => {
    const pane = createPane()
    const addon = pane.webglAddon
    const manager = managerWithPane(pane, {})
    manager.suspendRendering()
    vi.advanceTimersByTime(29_999)
    expect(manager.resumeRetainedRendering()).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(pane.webglAddon).toBe(addon)
    expect(pane.webglAttachmentDeferred).toBe(false)
  })

  it('requires a full resume after a hidden context expires', () => {
    const pane = createPane()
    const manager = managerWithPane(pane, {})
    manager.suspendRendering()
    vi.advanceTimersByTime(30_000)
    expect(manager.resumeRetainedRendering()).toBe(false)
    expect(pane.webglAttachmentDeferred).toBe(true)
  })

  // Why: the retained branch's blur is already pinned above; only the dispose branch changed.
  it('blurs a suspended pane on the dispose branch', () => {
    const panes = [createPane()]
    suspendPaneRendering(panes)
    expect(panes[0].terminal.blur).toHaveBeenCalledTimes(1)
  })

  it('evicts the least-recently-hidden owner over the context cap', () => {
    const ownerA = {}
    const panesA = [createPane(), createPane(), createPane()]
    const addonsA = panesA.map((pane) => pane.webglAddon)
    suspendPaneRendering(panesA, retentionFor(ownerA, panesA))

    const ownerB = {}
    const panesB = [createPane(), createPane(), createPane()]
    suspendPaneRendering(panesB, retentionFor(ownerB, panesB))

    // A(3) + B(3) fits the cap of 6; C(2) forces A out.
    const ownerC = {}
    const panesC = [createPane(), createPane()]
    suspendPaneRendering(panesC, retentionFor(ownerC, panesC))

    expect(panesA.every((pane) => pane.webglAddon === null)).toBe(true)
    for (const addon of addonsA) {
      expect(addon?.dispose).toHaveBeenCalled()
    }
    expect(panesB.every((pane) => pane.webglAddon != null)).toBe(true)
    expect(panesC.every((pane) => pane.webglAddon != null)).toBe(true)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(2)
  })

  it('re-suspending an owner refreshes its LRU position', () => {
    const ownerA = {}
    const panesA = [createPane(), createPane(), createPane()]
    suspendPaneRendering(panesA, retentionFor(ownerA, panesA))
    const ownerB = {}
    const panesB = [createPane(), createPane(), createPane()]
    suspendPaneRendering(panesB, retentionFor(ownerB, panesB))

    // Touch A again: B becomes the eviction candidate.
    suspendPaneRendering(panesA, retentionFor(ownerA, panesA))
    const ownerC = {}
    const panesC = [createPane()]
    suspendPaneRendering(panesC, retentionFor(ownerC, panesC))

    expect(panesB.every((pane) => pane.webglAddon === null)).toBe(true)
    expect(panesA.every((pane) => pane.webglAddon != null)).toBe(true)
  })

  it('does not retain when the owner has no live addons', () => {
    const owner = {}
    const panes = [createPane(false)]
    suspendPaneRendering(panes, retentionFor(owner, panes))
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
  })

  it('does not retain a single owner wider than the whole cap', () => {
    const owner = {}
    const panes = Array.from({ length: 7 }, () => createPane())
    const addons = panes.map((pane) => pane.webglAddon)
    suspendPaneRendering(panes, retentionFor(owner, panes))
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
    for (const addon of addons) {
      expect(addon?.dispose).toHaveBeenCalled()
    }
  })

  it('resume releases retention bookkeeping and keeps the live addon', () => {
    const owner = {}
    const panes = [createPane()]
    suspendPaneRendering(panes, retentionFor(owner, panes))
    resumePaneRendering(panes, owner)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
    expect(panes[0].webglAddon).not.toBeNull()
    expect(panes[0].webglAttachmentDeferred).toBe(false)
    // Released owner no longer counts toward the cap: three more 3-pane owners fit.
    const others = [{}, {}]
    for (const other of others) {
      const otherPanes = [createPane(), createPane(), createPane()]
      suspendPaneRendering(otherPanes, retentionFor(other, otherPanes))
      expect(otherPanes.every((pane) => pane.webglAddon != null)).toBe(true)
    }
  })

  it('releaseHiddenWebglRetention never disposes addons (destroy path owns that)', () => {
    const owner = {}
    const panes = [createPane()]
    expect(tryRetainHiddenPanesWebgl(owner, () => panes)).toBe(true)
    releaseHiddenWebglRetention(owner)
    expect(panes[0].webglAddon).not.toBeNull()
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
  })

  it('eviction accounting survives addons disposed after retention (GPU toggle off)', () => {
    const ownerA = {}
    const panesA = [createPane(), createPane(), createPane(), createPane()]
    suspendPaneRendering(panesA, retentionFor(ownerA, panesA))
    // GPU-off path disposes retained addons directly.
    for (const pane of panesA) {
      pane.webglAddon = null
    }
    const ownerB = {}
    const panesB = Array.from({ length: 6 }, () => createPane())
    suspendPaneRendering(panesB, retentionFor(ownerB, panesB))
    expect(panesB.every((pane) => pane.webglAddon != null)).toBe(true)
  })

  it('releases all six hidden contexts after 30 seconds without another tab switch', () => {
    const panes = Array.from({ length: 6 }, () => createPane())
    const addons = panes.map((pane) => pane.webglAddon)
    for (const pane of panes) {
      const manager = managerWithPane(pane, {})
      manager.suspendRendering()
    }

    vi.advanceTimersByTime(29_999)
    expect(panes.every((pane) => pane.webglAddon != null)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(panes.every((pane) => pane.webglAddon === null)).toBe(true)
    expect(panes.every((pane) => pane.webglAttachmentDeferred)).toBe(true)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    for (const addon of addons) {
      expect(addon?.dispose).toHaveBeenCalledTimes(1)
    }
  })

  it('cancels expiry when the user returns before the deadline', () => {
    const pane = createPane()
    const addon = pane.webglAddon
    const manager = managerWithPane(pane, {})
    manager.suspendRendering()
    vi.advanceTimersByTime(29_999)
    manager.resumeRendering()
    vi.advanceTimersByTime(60_000)

    expect(pane.webglAddon).toBe(addon)
    expect(addon?.dispose).not.toHaveBeenCalled()
    expect(pane.webglAttachmentDeferred).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the driver context and canvas backing store on expiry', () => {
    const pane = createPane()
    const loseContext = vi.fn()
    const canvas = { width: 1920, height: 1080 }
    Object.assign(pane.webglAddon!, {
      _renderer: { _gl: { getExtension: () => ({ loseContext }) }, _canvas: canvas }
    })
    managerWithPane(pane, {}).suspendRendering()
    vi.advanceTimersByTime(30_000)

    expect(loseContext).toHaveBeenCalledTimes(1)
    expect(canvas).toEqual({ width: 0, height: 0 })
    expect(pane.webglAddon).toBeNull()
  })

  it('reattaches and refreshes an expired pane without replacing the terminal', async () => {
    await primeTerminalWebglAddon()
    const pane = createPane()
    const terminal = pane.terminal
    const oldAddon = pane.webglAddon
    Object.assign(terminal, { rows: 24, loadAddon: vi.fn(), refresh: vi.fn() })
    pane.terminalGpuAcceleration = 'on'
    const manager = managerWithPane(pane, {})
    manager.suspendRendering()
    vi.advanceTimersByTime(30_000)
    expect(pane.webglAddon).toBeNull()

    manager.resumeRendering()
    expect(pane.terminal).toBe(terminal)
    expect(pane.webglAddon).not.toBeNull()
    expect(pane.webglAddon).not.toBe(oldAddon)
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23)
    expect(terminal.options.cursorBlink).toBe(true)
    expect(pane.webglAttachmentDeferred).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not let an earlier hide expire a newly hidden generation', () => {
    const pane = createPane()
    const manager = managerWithPane(pane, {})
    manager.suspendRendering()
    vi.advanceTimersByTime(20_000)
    manager.resumeRendering()
    manager.suspendRendering()

    vi.advanceTimersByTime(10_000)
    expect(pane.webglAddon).not.toBeNull()
    vi.advanceTimersByTime(20_000)
    expect(pane.webglAddon).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels expiry when retention is released for destruction', () => {
    const owner = {}
    const panes = [createPane()]
    const addon = panes[0].webglAddon
    suspendPaneRendering(panes, retentionFor(owner, panes))
    releaseHiddenWebglRetention(owner)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(addon?.dispose).not.toHaveBeenCalled()
  })

  it('cancels evicted timers without expiring newer owners early', () => {
    const older = Array.from({ length: 6 }, () => createPane())
    suspendPaneRendering(older, retentionFor({}, older))
    vi.advanceTimersByTime(20_000)
    const newer = [createPane()]
    suspendPaneRendering(newer, retentionFor({}, newer))
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(newer[0].webglAddon).not.toBeNull()
    vi.advanceTimersByTime(20_000)
    expect(newer[0].webglAddon).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
