const DEFAULT_API_BASE = 'http://127.0.0.1:8787'

const apiInput = document.querySelector('#apiBaseUrl')
const saveButton = document.querySelector('#saveButton')
const testButton = document.querySelector('#testButton')
const statusElement = document.querySelector('#status')

function normalizeApiBase(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/, '')
}

function setStatus(message) {
  statusElement.textContent = message
}

function loadOptions() {
  chrome.storage.sync.get({ apiBaseUrl: DEFAULT_API_BASE }, (items) => {
    apiInput.value = normalizeApiBase(items.apiBaseUrl)
  })
}

function saveOptions() {
  const apiBaseUrl = normalizeApiBase(apiInput.value)
  chrome.storage.sync.set({ apiBaseUrl }, () => {
    setStatus(`已保存：${apiBaseUrl}`)
  })
}

async function testConnection() {
  const apiBaseUrl = normalizeApiBase(apiInput.value)
  setStatus('正在测试连接...')

  try {
    const response = await fetch(`${apiBaseUrl}/api/health`)
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`)
    }
    setStatus(`连接正常：${payload.model || '未配置模型'}，API Key ${payload.hasApiKey ? '已配置' : '未配置'}`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '连接失败')
  }
}

saveButton.addEventListener('click', saveOptions)
testButton.addEventListener('click', testConnection)
document.addEventListener('DOMContentLoaded', loadOptions)
