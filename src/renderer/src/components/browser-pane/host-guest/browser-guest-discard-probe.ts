// Conservative: editable documents and embedded frames keep their live state, even when pristine.
export function browserDocumentCanBeDiscarded(): boolean {
  if (document.readyState !== 'complete' || typeof window.onbeforeunload === 'function') {
    return false
  }
  if (
    document.querySelector(
      'textarea, select, input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"]), [contenteditable]:not([contenteditable="false"]), [role="textbox"], iframe, frame'
    )
  ) {
    return false
  }
  return ![...document.querySelectorAll('video, audio')].some(
    (media) => media instanceof HTMLMediaElement && !media.paused && !media.ended
  )
}

const pendingDocumentProbes = new WeakSet<object>()

export async function canDiscardBrowserGuest(
  webview: Pick<Electron.WebviewTag, 'isLoading' | 'executeJavaScript'> &
    Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let navigated = false
  const onNavigation = (): void => {
    navigated = true
  }
  try {
    if (webview.isLoading() || pendingDocumentProbes.has(webview)) {
      return false
    }
    webview.addEventListener('did-start-navigation', onNavigation)
    pendingDocumentProbes.add(webview)
    // A timeout must not stack another IPC request onto a renderer that is still unresponsive.
    const documentProbe = Promise.resolve()
      .then(() => webview.executeJavaScript(`(${browserDocumentCanBeDiscarded.toString()})()`))
      .then(
        (value) => {
          pendingDocumentProbes.delete(webview)
          return value === true
        },
        () => {
          pendingDocumentProbes.delete(webview)
          return false
        }
      )
    const safe = await Promise.race([
      documentProbe,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3_000)
      })
    ])
    return safe && !navigated && !webview.isLoading()
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    webview.removeEventListener('did-start-navigation', onNavigation)
  }
}
