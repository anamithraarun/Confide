const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────
const isDev = !app.isPackaged

// ─────────────────────────────────────────────────────────────────────────────
// Database — imported after app is ready so app.getPath('userData') is valid
// ─────────────────────────────────────────────────────────────────────────────
const db = require('./db')

// ─────────────────────────────────────────────────────────────────────────────
// Main window
// ─────────────────────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset', // macOS native traffic lights
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC — Utility
// ─────────────────────────────────────────────────────────────────────────────

/** ping → pong. Verifies the IPC bridge is alive. */
ipcMain.handle('ping', async () => {
  return { status: 'pong', timestamp: Date.now() }
})

// ─────────────────────────────────────────────────────────────────────────────
// IPC — Conversations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * conversation:create
 * Args: { title?: string }
 * Returns: { conversation } | { error }
 */
ipcMain.handle('conversation:create', (_event, { title } = {}) => {
  try {
    const conversation = db.createConversation(title)
    return { conversation }
  } catch (err) {
    console.error('[ipc] conversation:create error:', err)
    return { error: err.message }
  }
})

/**
 * conversation:list
 * Args: none
 * Returns: { conversations: [] } | { error }
 */
ipcMain.handle('conversation:list', () => {
  try {
    const conversations = db.listConversations()
    return { conversations }
  } catch (err) {
    console.error('[ipc] conversation:list error:', err)
    return { error: err.message }
  }
})

/**
 * conversation:messages
 * Args: { conversationId: string }
 * Returns: { messages: [] } | { error }
 */
ipcMain.handle('conversation:messages', (_event, { conversationId } = {}) => {
  try {
    if (!conversationId) return { error: 'conversationId is required.' }

    // Verify conversation exists
    const conv = db.getConversation(conversationId)
    if (!conv) return { error: `Conversation "${conversationId}" not found.` }

    const messages = db.getMessages(conversationId)
    return { messages }
  } catch (err) {
    console.error('[ipc] conversation:messages error:', err)
    return { error: err.message }
  }
})

/**
 * conversation:delete
 * Args: { conversationId: string }
 * Returns: { deleted: boolean } | { error }
 */
ipcMain.handle('conversation:delete', (_event, { conversationId } = {}) => {
  try {
    if (!conversationId) return { error: 'conversationId is required.' }
    const result = db.deleteConversation(conversationId)
    return result
  } catch (err) {
    console.error('[ipc] conversation:delete error:', err)
    return { error: err.message }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// IPC — Ollama (with SQLite persistence & conversation context)
// ─────────────────────────────────────────────────────────────────────────────
const OLLAMA_BASE = 'http://127.0.0.1:11434'
const OLLAMA_MODEL = 'gemma3:1b'

// Maximum number of prior messages sent as context (easy to configure or tune)
const MAX_CONTEXT_MESSAGES = 20

// System prompt guiding the local model to reference previous conversation context
const SYSTEM_PROMPT = 'You are Confide, a helpful, private local AI assistant. Always carefully read and use the conversation history to answer questions about what the user told you.'

/**
 * ollama:chat
 * Args: { conversationId: string, prompt: string }
 *
 * Flow:
 *   1. Validate inputs
 *   2. Verify the conversation exists in SQLite
 *   3. Retrieve prior messages from SQLite (up to MAX_CONTEXT_MESSAGES)
 *   4. Save the new user message to SQLite
 *   5. Build conversation context messages array [system, ...history, user]
 *   6. Send context to Ollama /api/chat
 *   7. Save the assistant response to SQLite
 *   8. Return both saved messages
 *
 * Returns: { userMessage, assistantMessage } | { error }
 */
ipcMain.handle('ollama:chat', async (_event, { conversationId, prompt } = {}) => {
  // ── Guards ──────────────────────────────────────────────────────────────
  if (!conversationId) return { error: 'conversationId is required.' }
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return { error: 'Prompt must be a non-empty string.' }
  }

  const conv = db.getConversation(conversationId)
  if (!conv) return { error: `Conversation "${conversationId}" not found.` }

  const trimmedPrompt = prompt.trim()

  // ── Retrieve conversation history before saving the new prompt ───────────
  let previousMessages = []
  try {
    previousMessages = db.getRecentMessages(conversationId, MAX_CONTEXT_MESSAGES)
  } catch (err) {
    console.warn('[ipc] ollama:chat — failed to retrieve previous messages:', err)
    // Non-fatal: proceed with current prompt only
  }

  // ── Save user message ───────────────────────────────────────────────────
  let userMessage
  try {
    userMessage = db.saveMessage({
      conversationId,
      role: 'user',
      content: trimmedPrompt,
    })
  } catch (err) {
    console.error('[ipc] ollama:chat — failed to save user message:', err)
    return { error: `Failed to save message: ${err.message}` }
  }

  // ── Build context payload for Ollama /api/chat ──────────────────────────
  const messagesPayload = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...previousMessages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
    { role: 'user', content: trimmedPrompt },
  ]

  // ── Call Ollama /api/chat ───────────────────────────────────────────────
  let ollamaResponse
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: messagesPayload,
        stream: false,
        options: {
          temperature: 0.3,
        },
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      if (res.status === 404) {
        return { error: `Model "${OLLAMA_MODEL}" not found. Run: ollama pull ${OLLAMA_MODEL}` }
      }
      return { error: `Ollama error ${res.status}: ${text}` }
    }

    const data = await res.json()
    ollamaResponse = data.message?.content ?? ''
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
      return { error: 'Ollama is not running. Start it with: ollama serve' }
    }
    return { error: `Unexpected error: ${err.message}` }
  }

  // ── Save assistant message ──────────────────────────────────────────────
  let assistantMessage
  try {
    assistantMessage = db.saveMessage({
      conversationId,
      role: 'assistant',
      content: ollamaResponse,
    })
  } catch (err) {
    console.error('[ipc] ollama:chat — failed to save assistant message:', err)
    // Return the response even if saving failed — don't lose it
    return {
      error: `Response received but failed to save: ${err.message}`,
      response: ollamaResponse,
    }
  }

  return { userMessage, assistantMessage }
})

// ─────────────────────────────────────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Init DB first — must happen after app.getPath('userData') is available
  try {
    const dbPath = db.initDB()
    console.log(`[app] Database ready: ${dbPath}`)
  } catch (err) {
    console.error('[app] FATAL: Could not open database:', err)
    // App can still open — DB features will fail gracefully via IPC error returns
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    db.closeDB()
    app.quit()
  }
})

app.on('before-quit', () => {
  db.closeDB()
})
