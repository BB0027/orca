import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

describe('DSH first launch', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'passes the task at launch without a delayed paste on %s',
    (platform) => {
      const plan = buildAgentStartupPlan({
        agent: 'dsh',
        prompt: 'Review this folder',
        cmdOverrides: {},
        platform
      })
      expect(plan?.launchCommand).toContain('dsh-tui . -- ')
      expect(plan?.launchCommand).toContain('Review this folder')
      expect(plan?.followupPrompt).toBeNull()
      expect(TUI_AGENT_CONFIG.dsh.draftPasteReadySignal).toBe('dsh-composer-prompt')
    }
  )

  it('keeps command-shaped prompts literal on remote hosts', () => {
    const plan = buildAgentStartupPlan({
      agent: 'dsh',
      prompt: '--help',
      cmdOverrides: {},
      platform: 'linux',
      isRemote: true
    })
    expect(plan?.launchCommand).toBe("dsh-tui . -- '--help'")
    expect(plan?.followupPrompt).toBeNull()
  })

  it('keeps an interactive launch free of prompt arguments', () => {
    const plan = buildAgentStartupPlan({
      agent: 'dsh',
      prompt: '',
      cmdOverrides: {},
      platform: 'win32',
      allowEmptyPromptLaunch: true
    })
    expect(plan?.launchCommand).toBe('dsh-tui .')
    expect(plan?.followupPrompt).toBeNull()
  })
})
