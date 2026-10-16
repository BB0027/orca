import { useEffect } from 'react'
import { useAppStore } from '../store'
import {
  browserPageNeedsPaintRetention,
  onBrowserGuestPaintRetentionChange
} from './browser-pane/host-guest/browser-guest-paint-retention'
import {
  hasActiveBrowserPageDownload,
  installBrowserPageDownloadActivityTracking
} from './browser-pane/navigate/browser-page-download-activity'
import { webviewRegistry } from './browser-pane/host-guest/webview-registry'
import { createBrowserGuestIdleRetention } from './browser-pane/host-guest/browser-guest-idle-retention'
import { canDiscardBrowserGuest } from './browser-pane/host-guest/browser-guest-discard-probe'
import { browserTabVisibilityPageIds } from './browser-pane/host-guest/browser-guest-worktree-retention'
import { discardRetainedBrowserGuest } from '../store/slices/browser-webview-cleanup'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

export function useTerminalBrowserRetention(
  controller: Pick<TerminalParkingFoundation, 'browserGuestRetentionBudgetEnabled'>
): void {
  const enabled = controller.browserGuestRetentionBudgetEnabled
  useEffect(() => {
    if (!enabled) {
      return
    }
    const retention = createBrowserGuestIdleRetention({
      getGuests: () => webviewRegistry,
      isProtected: (id, guest) => {
        const state = useAppStore.getState()
        if (state.settings?.browserGuestWorktreeRetentionBudget === false) {
          return true
        }
        const activeTab = (state.browserTabsByWorktree[state.activeWorktreeId ?? ''] ?? []).find(
          (tab) => tab.id === state.activeBrowserTabId
        )
        if (
          state.activeTabType === 'browser' &&
          activeTab &&
          browserTabVisibilityPageIds(activeTab).includes(id)
        ) {
          return true
        }
        if (browserPageNeedsPaintRetention(id) || hasActiveBrowserPageDownload(id)) {
          return true
        }
        const bounds = guest.getBoundingClientRect()
        return bounds.width > 0 && bounds.height > 0
      },
      canDiscard: canDiscardBrowserGuest,
      discard: discardRetainedBrowserGuest
    })
    const sweep = (): void => {
      void retention.sweep()
    }
    const timer = setInterval(sweep, 15_000)
    const removeDownloadTracking = installBrowserPageDownloadActivityTracking(sweep)
    const removePaintRetentionTracking = onBrowserGuestPaintRetentionChange(sweep)
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeTabType !== previous.activeTabType ||
        state.activeBrowserTabId !== previous.activeBrowserTabId ||
        state.activeView !== previous.activeView
      ) {
        sweep()
      }
    })
    sweep()
    return () => {
      retention.dispose()
      clearInterval(timer)
      unsubscribe()
      removeDownloadTracking()
      removePaintRetentionTracking()
    }
  }, [enabled])
}
