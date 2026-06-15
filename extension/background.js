const DEFAULT_API_BASE = 'http://127.0.0.1:8787'

function normalizeApiBase(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/, '')
}

function getApiBase() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ apiBaseUrl: DEFAULT_API_BASE }, (items) => {
      resolve(normalizeApiBase(items.apiBaseUrl))
    })
  })
}

async function fetchApi(path, options) {
  const apiBase = await getApiBase()
  return fetch(`${apiBase}${path}`, options)
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'fetch-image-data-url') {
    fetch(message.url, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Image fetch failed: ${response.status}`)
        }

        const contentType = response.headers.get('content-type') || 'image/png'
        const buffer = await response.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ''
        const chunkSize = 0x8000

        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
        }

        sendResponse({
          ok: true,
          dataUrl: `data:${contentType};base64,${btoa(binary)}`,
        })
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Image fetch failed',
        })
      })
    return true
  }

  if (message?.type === 'capture-visible-tab') {
    chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message })
        return
      }
      sendResponse({ ok: true, dataUrl })
    })
    return true
  }

  if (message?.type === 'fetch-pdf-data-url') {
    fetch(message.url, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`PDF fetch failed: ${response.status}`)
        }

        const contentType = response.headers.get('content-type') || 'application/pdf'
        const buffer = await response.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ''
        const chunkSize = 0x8000

        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
        }

        sendResponse({
          ok: true,
          dataUrl: `data:${contentType};base64,${btoa(binary)}`,
        })
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'PDF fetch failed',
        })
      })
    return true
  }

  if (message?.type === 'request-figure-context') {
    fetchApi('/api/browser/figure-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null)
        sendResponse({ ok: response.ok, status: response.status, payload })
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          status: 0,
          payload: { error: error instanceof Error ? error.message : '请求本地上下文服务失败' },
        })
      })
    return true
  }

  if (message?.type === 'save-analysis') {
    fetchApi('/api/analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null)
        sendResponse({ ok: response.ok, status: response.status, payload })
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          status: 0,
          payload: { error: error instanceof Error ? error.message : '保存解析结果失败' },
        })
      })
    return true
  }

  if (message?.type === 'get-analysis') {
    fetchApi(`/api/analysis/${encodeURIComponent(message.id)}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => null)
        sendResponse({ ok: response.ok, status: response.status, payload })
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          status: 0,
          payload: { error: error instanceof Error ? error.message : '读取历史解析失败' },
        })
      })
    return true
  }

  if (message?.type === 'analyze-figure') {
    fetchApi('/api/analyze-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null)
        sendResponse({ ok: response.ok, status: response.status, payload })
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          status: 0,
          payload: { error: error instanceof Error ? error.message : '请求本地解析服务失败' },
        })
      })
    return true
  }

  return false
})
