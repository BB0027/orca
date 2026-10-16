// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserDocumentCanBeDiscarded,
  canDiscardBrowserGuest
} from './browser-guest-discard-probe'

describe('browser guest discard safety', () => {
  beforeEach(() => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    document.body.innerHTML = ''
  })
  afterEach(() => {
    window.onbeforeunload = null
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('allows a read-only document', () => {
    document.body.innerHTML = '<p>Report</p>'
    expect(browserDocumentCanBeDiscarded()).toBe(true)
  })

  it.each([
    '<input value="draft">',
    '<textarea>draft</textarea>',
    '<select></select>',
    '<div contenteditable="true">draft</div>',
    '<div role="textbox"></div>',
    '<iframe></iframe>'
  ])('preserves editable or embedded content: %s', (html) => {
    document.body.innerHTML = html
    expect(browserDocumentCanBeDiscarded()).toBe(false)
  })

  it('preserves a page with an unload handler', () => {
    window.onbeforeunload = () => ''
    expect(browserDocumentCanBeDiscarded()).toBe(false)
  })

  it('rejects an old document result after navigation', async () => {
    const guest = Object.assign(document.createElement('div'), {
      isLoading: () => false,
      executeJavaScript: async () => {
        guest.dispatchEvent(new Event('did-start-navigation'))
        return true
      }
    })
    expect(await canDiscardBrowserGuest(guest)).toBe(false)
  })

  it('times out without discarding an unresponsive document', async () => {
    vi.useFakeTimers()
    const guest = Object.assign(document.createElement('div'), {
      isLoading: () => false,
      executeJavaScript: vi.fn(() => new Promise<boolean>(() => {}))
    })
    const probe = canDiscardBrowserGuest(guest)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await probe).toBe(false)
    expect(await canDiscardBrowserGuest(guest)).toBe(false)
    expect(guest.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
