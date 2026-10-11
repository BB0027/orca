import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const { appMock, autoUpdaterMock, moduleFactories, resetUpdaterMocks } = await vi.hoisted(
  async () => (await import('./updater-test-harness')).createUpdaterMocks()
)
vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())
warmUpdaterModule()

describe('self-maintained builds', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    appMock.getVersion.mockReturnValue('1.4.224+custom.1')
  })

  it('refuses automatic, menu, pinned, local-file and direct installs', async () => {
    const updater = await loadUpdaterModule()
    const send = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The updater only reads webContents.send from this window fixture.
    updater.setupAutoUpdater({ webContents: { send } } as never)
    updater.checkForUpdates()
    updater.checkForUpdatesFromMenu()
    updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.225' })
    updater.checkForUpdatesFromMenu({ localBuild: true })
    updater.downloadUpdate()
    updater.quitAndInstall()
    expect(autoUpdaterMock.on).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'error', retryable: false })
    expect(updater.getRemoteServerUpdateSupport().automatic).toBe(false)
    expect(() => updater.checkForRemoteServerUpdate('local')).toThrow(
      'remote_update_manual_required'
    )
    expect(() => updater.downloadRemoteServerUpdate('local')).toThrow(
      'remote_update_manual_required'
    )
    expect(() => updater.installRemoteServerUpdate('local')).toThrow(
      'remote_update_manual_required'
    )
  })
})
