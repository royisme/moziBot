const DEFAULT_PORT = 9222
const RELAY_TOKEN_CONTEXT = 'mozi-extension-relay-v1'

function clampPort(value) {
  const n = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_PORT
  if (n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function updateRelayUrl(port) {
  const el = document.getElementById('relay-url')
  if (!el) return
  el.textContent = `http://127.0.0.1:${port}/`
}

async function deriveRelayToken(relayAuthToken, port) {
  const t = String(relayAuthToken || '').trim()
  if (!t) return ''
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(t),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(`${RELAY_TOKEN_CONTEXT}:${port}`),
  )
  const bytes = new Uint8Array(sig)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function relayHeaders(port, token) {
  const relayToken = await deriveRelayToken(token, port)
  if (!relayToken) return {}
  return { 'x-mozibot-relay-token': relayToken }
}

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

async function checkRelayReachable(port, token) {
  const url = `http://127.0.0.1:${port}/json/version`
  const trimmedToken = String(token || '').trim()
  if (!trimmedToken) {
    setStatus('error', 'Relay auth token required. Save your relay auth token to connect.')
    return
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 1200)
  try {
    const headers = await relayHeaders(port, trimmedToken)
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    })
    if (res.status === 401) {
      setStatus('error', 'Relay auth token rejected. Check token and save again.')
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setStatus('ok', `Relay reachable and authenticated at http://127.0.0.1:${port}/`)
  } catch {
    setStatus(
      'error',
      `Relay not reachable/authenticated at http://127.0.0.1:${port}/. Start Mozi browser relay and verify token.`,
    )
  } finally {
    clearTimeout(t)
  }
}

async function load() {
  const stored = await chrome.storage.local.get(['relayPort', 'relayAuthToken'])
  const port = clampPort(stored.relayPort)
  const token = String(stored.relayAuthToken || '').trim()
  document.getElementById('port').value = String(port)
  document.getElementById('token').value = token
  updateRelayUrl(port)
  await checkRelayReachable(port, token)
}

async function save() {
  const portInput = document.getElementById('port')
  const tokenInput = document.getElementById('token')
  const port = clampPort(portInput.value)
  const token = String(tokenInput.value || '').trim()
  await chrome.storage.local.set({ relayPort: port, relayAuthToken: token })
  portInput.value = String(port)
  tokenInput.value = token
  updateRelayUrl(port)
  await checkRelayReachable(port, token)
}

document.getElementById('save').addEventListener('click', () => void save())
void load()
