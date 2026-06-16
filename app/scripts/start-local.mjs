import { spawn } from 'node:child_process'

const healthUrl = 'http://127.0.0.1:8787/api/health'

async function isBackendReady() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return false
    const payload = await response.json().catch(() => null)
    return Boolean(payload?.ok)
  } catch {
    return false
  }
}

function run(command, args, options = {}) {
  return spawn(command, args, {
    stdio: options.stdio ?? 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
}

async function waitForBackend() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isBackendReady()) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

if (await isBackendReady()) {
  console.log('Backend is already running at http://127.0.0.1:8787')
} else {
  console.log('Starting backend at http://127.0.0.1:8787')
  const backend = run('node', ['server.js'], {
    stdio: 'ignore',
    detached: true,
  })
  backend.unref()

  if (!(await waitForBackend())) {
    console.error('Backend did not start. Run npm run server in app and check the terminal error.')
    process.exit(1)
  }
}

console.log('Starting web app at http://127.0.0.1:5173')
const frontend = run('npm', ['run', 'dev', '--', '--host', '127.0.0.1'])
frontend.on('exit', (code) => {
  process.exit(code ?? 0)
})
