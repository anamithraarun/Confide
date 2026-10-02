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
// IPC — Business Profile (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * profile:get
 * Args: none
 * Returns: { profile } | { profile: null } | { error }
 */
ipcMain.handle('profile:get', () => {
  try {
    const profile = db.getProfile()
    return { profile }
  } catch (err) {
    console.error('[ipc] profile:get error:', err)
    return { error: err.message }
  }
})

/**
 * profile:save
 * Args: { businessName, industry, description, targetCustomers, budget }
 * Returns: { profile } | { error }
 *
 * All fields are optional strings. businessName is required to be non-empty.
 */
ipcMain.handle('profile:save', (_event, args = {}) => {
  try {
    const { businessName, industry, description, targetCustomers, budget } = args

    if (!businessName || typeof businessName !== 'string' || businessName.trim() === '') {
      return { error: 'Business name is required.' }
    }

    const profile = db.saveProfile({
      businessName: businessName.trim(),
      industry:        (industry        ?? '').trim(),
      description:     (description     ?? '').trim(),
      targetCustomers: (targetCustomers ?? '').trim(),
      budget:          (budget          ?? '').trim(),
    })
    return { profile }
  } catch (err) {
    console.error('[ipc] profile:save error:', err)
    return { error: err.message }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// IPC — Memories (Phase 5)
//
// All handlers use db.BUSINESS_ID_DEFAULT as the workspace identifier.
//
// Multi-workspace migration path:
//   When a user can switch between workspaces, replace db.BUSINESS_ID_DEFAULT
//   here with the active workspace's businesses.id (e.g. resolved from a
//   session or user-preference store).  The db.createMemory / db.getMemories /
//   db.deleteMemory signatures stay unchanged — only the value passed as
//   businessId changes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * memory:create
 * Args: { content: string, source?: string }
 * Returns: { memory, duplicate: boolean } | { error }
 *
 * content   — the text to remember (required, non-empty).
 * source    — provenance tag: 'user' | 'chat' | 'document' (default 'user').
 * duplicate — true when the content already exists; the existing row is
 *             returned so the UI can show "already saved" without a new insert.
 */
ipcMain.handle('memory:create', (_event, args = {}) => {
  try {
    const { content, source = 'user' } = args

    if (!content || typeof content !== 'string' || content.trim() === '') {
      return { error: 'content is required.' }
    }

    const result = db.createMemory({
      businessId: db.BUSINESS_ID_DEFAULT,
      content: content.trim(),
      source,
    })
    // result = { memory, duplicate }
    return result
  } catch (err) {
    console.error('[ipc] memory:create error:', err)
    return { error: err.message }
  }
})

/**
 * memory:list
 * Args: none
 * Returns: { memories: [] } | { error }
 */
ipcMain.handle('memory:list', () => {
  try {
    const memories = db.getMemories(db.BUSINESS_ID_DEFAULT)  // MVP: default workspace
    return { memories }
  } catch (err) {
    console.error('[ipc] memory:list error:', err)
    return { error: err.message }
  }
})

/**
 * memory:delete
 * Args: { memoryId: string }
 * Returns: { deleted: boolean } | { error }
 */
ipcMain.handle('memory:delete', (_event, { memoryId } = {}) => {
  try {
    if (!memoryId) return { error: 'memoryId is required.' }
    const result = db.deleteMemory(memoryId)
    return result
  } catch (err) {
    console.error('[ipc] memory:delete error:', err)
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

// Maximum number of saved business memories injected into the system prompt.
// Keep this small — gemma3:1b has a limited context window.
// 10 memories × ~50 tokens avg = ~500 token overhead, well within budget.
const MAX_MEMORIES = 10

// Base system prompt — always included
const SYSTEM_PROMPT_BASE = 'You are Confide, a helpful, private local AI assistant for entrepreneurs and business owners. Always carefully read and use the conversation history to answer questions about what the user told you.'

/**
 * buildSystemContent(profile, memories) → string
 *
 * Assembles the full system message from:
 *   1. Base instructions (always present)
 *   2. BUSINESS PROFILE section (when a profile with a name exists)
 *   3. BUSINESS MEMORY section (when there are saved memories)
 *
 * Each section is clearly labelled so the model can distinguish structured
 * context from live conversation history.
 *
 * Prompt design notes for gemma3:1b:
 *   - Keep instructions short and action-oriented. Long "do not" lists cause
 *     the model to refuse or produce empty responses on simple statements.
 *   - Acknowledge declarative user messages naturally ("Got it", "Understood").
 *   - Only reference memory/profile when the question is relevant to them.
 */
function buildSystemContent(profile, memories) {
  const lines = [SYSTEM_PROMPT_BASE]

  // ── Business Profile ────────────────────────────────────────────────────
  if (profile && profile.business_name) {
    lines.push('', 'BUSINESS PROFILE:')
    if (profile.business_name)    lines.push(`Business name: ${profile.business_name}`)
    if (profile.industry)         lines.push(`Industry: ${profile.industry}`)
    if (profile.description)      lines.push(`Description: ${profile.description}`)
    if (profile.target_customers) lines.push(`Target customers: ${profile.target_customers}`)
    if (profile.budget)           lines.push(`Budget: ${profile.budget}`)
  }

  // ── Business Memory ─────────────────────────────────────────────────────
  if (memories && memories.length > 0) {
    lines.push('', 'BUSINESS MEMORY (facts saved from previous conversations):')
    memories.forEach(m => lines.push(`- ${m.content}`))
  }

  // ── Behavioural instructions ─────────────────────────────────────────────
  // Keep these brief — gemma3:1b performs better with short, positive guidance
  // than with long lists of prohibitions.
  lines.push(
    '',
    'Guidelines:',
    '- When the user states a fact or shares information, acknowledge it naturally.',
    '- When answering questions, draw on the business profile and saved memories above when relevant.',
    '- If you do not have enough information to answer, say so honestly.',
  )

  return lines.join('\n')
}

/**
 * ollama:chat
 * Args: { conversationId: string, prompt: string }
 *
 * Flow:
 *   1. Validate inputs
 *   2. Verify the conversation exists in SQLite
 *   3. Retrieve business profile  — for system prompt BUSINESS PROFILE section
 *   4. Retrieve saved memories    — for system prompt BUSINESS MEMORY section (Phase 6)
 *   5. Retrieve prior messages    — current conversation context
 *   6. Save the new user message to SQLite
 *   7. Build Ollama payload: [system(profile+memories), ...history, user]
 *   8. POST to Ollama /api/chat
 *   9. Save assistant response to SQLite
 *  10. Return both saved messages
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

  // ── Retrieve business profile ────────────────────────────────────────────
  let profile = null
  try {
    profile = db.getProfile()
  } catch (err) {
    console.warn('[ipc] ollama:chat — failed to retrieve business profile:', err)
    // Non-fatal: chat continues without profile context
  }

  // ── Retrieve saved business memories (Phase 6) ───────────────────────────
  let memories = []
  try {
    memories = db.getRecentMemories(db.BUSINESS_ID_DEFAULT, MAX_MEMORIES)
  } catch (err) {
    console.warn('[ipc] ollama:chat — failed to retrieve memories:', err)
    // Non-fatal: chat continues without memory context
  }

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
  // One structured system message contains: base instructions + business
  // profile + business memory.  Conversation history follows as normal
  // user/assistant turns so the model sees a clean turn structure.
  const systemContent = buildSystemContent(profile, memories)

  const messagesPayload = [
    { role: 'system', content: systemContent },
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

    // Guard: an empty response is treated as a failure so the user sees an
    // error rather than a silent blank bubble.  This can happen when a very
    // small model (gemma3:1b) is overwhelmed by a long system prompt.
    if (ollamaResponse.trim() === '') {
      return { error: 'Ollama returned an empty response. Try rephrasing your message.' }
    }
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
