import type { PaneManagerHost } from './pane-manager-host'
import { applyPaneOpacity } from './pane-divider'
import { focusPanePreservingOverlays } from './pane-overlay-focus'
import { toPublicPane } from './pane-public-view'

export function activateManagedPane(
  host: PaneManagerHost,
  paneId: number,
  opts?: { focus?: boolean }
): void {
  const pane = host.panes.get(paneId)
  if (!pane) {
    return
  }
  const changed = host.getActivePaneId() !== paneId
  host.setActivePaneId(paneId)
  applyPaneOpacity(host.panes.values(), paneId, host.getStyleOptions())
  if (opts?.focus !== false) {
    focusPanePreservingOverlays(pane)
  }
  if (changed) {
    host.options.onActivePaneChange?.(toPublicPane(pane))
  }
}
