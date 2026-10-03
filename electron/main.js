const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
require('dotenv').config()

console.log('Gemini key loaded:', !!process.env.GEMINI_API_KEY)
const { GoogleGenAI } = require('@google/genai')
const Groq = require('groq-sdk')

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

/**
 * conversation:rename
 * Args: { conversationId: string, title: string }
 * Returns: { conversation } | { error }
 */
ipcMain.handle('conversation:rename', (_event, { conversationId, title } = {}) => {
  try {
    if (!conversationId) return { error: 'conversationId is required.' }
    if (!title || typeof title !== 'string' || title.trim() === '') {
      return { error: 'Title cannot be empty.' }
    }
    const conv = db.getConversation(conversationId)
    if (!conv) return { error: `Conversation "${conversationId}" not found.` }

    const updated = db.updateConversationTitle(conversationId, title.trim(), true)
    return { conversation: updated }
  } catch (err) {
    console.error('[ipc] conversation:rename error:', err)
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
    '- Format responses using Markdown when helpful: use headings, bullet points, numbered lists, bold, or code blocks to improve readability. Keep responses concise and easy to scan.',
  )

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Automatic Chat Title (Local Gemma 3 1B via Ollama)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * generateTitleWithOllama(prompt) → Promise<string | null>
 *
 * Chat titles must ALWAYS be generated locally using the existing Gemma/Ollama setup.
 * Calls local Gemma 3 1B via Ollama to generate a concise 3–4 word title.
 * Do NOT send conversation content to Gemini or any other external API.
 * Do NOT introduce another model, API, library, or service.
 * Do NOT include business profile, memories, or extra context.
 */
async function generateTitleWithOllama(prompt) {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a concise title generator. Generate a 3 to 4 word title describing the main topic of the conversation. Output ONLY the 3 to 4 word title. Do not include quotes, punctuation, numbering, bullet points, markdown, or any explanation.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        stream: false,
        options: { temperature: 0.3 }
      })
    })

    if (!res.ok) {
      console.warn(`[title] Ollama title generation HTTP error: ${res.status}`)
      return null
    }

    const data = await res.json()
    let rawTitle = data.message?.content?.trim() || ''

    // Clean up LLM output: remove quotes, markdown, prefixes, trailing dots/symbols
    rawTitle = rawTitle
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
      .replace(/^(title|topic):\s*/i, '')
      .replace(/[.#*`_]+$/g, '')
      .trim()

    // Clamp words to at most 4 words if model produced more
    const words = rawTitle.split(/\s+/).filter(Boolean)
    if (words.length > 4) {
      rawTitle = words.slice(0, 4).join(' ')
    }

    return rawTitle || null
  } catch (err) {
    console.warn('[title] Could not generate title with local Ollama/Gemma:', err.message)
    return null
  }
}

/**
 * maybeGenerateTitle(sender, conversationId, userPrompt)
 *
 * Checks if the conversation is a newly created conversation that has not been titled yet
 * (auto_titled === 0). If eligible, generates a title using local Gemma/Ollama, updates
 * the conversation in SQLite, and pushes 'conversation:title-updated' to the renderer.
 *
 * Generates the title only once per conversation.
 * Does not overwrite manual renames.
 */
async function maybeGenerateTitle(sender, conversationId, userPrompt) {
  try {
    const conv = db.getConversation(conversationId)
    if (!conv || conv.auto_titled !== 0) return

    const title = await generateTitleWithOllama(userPrompt)
    if (!title) return

    // Double-check conversation state before saving (in case user manually renamed while generating)
    const currentConv = db.getConversation(conversationId)
    if (!currentConv || currentConv.auto_titled !== 0) return

    db.updateConversationTitle(conversationId, title, false)

    try {
      sender.send('conversation:title-updated', { conversationId, title })
    } catch {
      // Sender window may be closed
    }
  } catch (err) {
    console.warn('[title] Error in maybeGenerateTitle:', err)
  }
}

/**
 * ollama:chat — Phase 7: streaming
 * Args: { conversationId: string, prompt: string }
 *
 * Flow:
 *   1.  Validate inputs + verify conversation exists
 *   2.  Retrieve business profile, memories, conversation history (unchanged)
 *   3.  Save the user message to SQLite
 *   4.  Return { streaming: true, userMessage } immediately so the renderer
 *       can replace its optimistic bubble with the real DB row right away
 *   5.  POST to Ollama /api/chat with stream: true
 *   6.  Read NDJSON chunks; push each token to the renderer via
 *       event.sender.send('ollama:stream', { conversationId, chunk })
 *   7.  When Ollama signals done, save the accumulated full response to SQLite
 *       as a single assistant message
 *   8.  Push { conversationId, done: true, userMessage, assistantMessage }
 *       so the renderer can swap the live streaming bubble for the persisted row
 *
 * On any error after the handler has already returned { streaming: true }:
 *   Push { conversationId, done: true, error } so the renderer can display it.
 *
 * Returns: { streaming: true, userMessage } | { error }
 */
ipcMain.handle('ollama:chat', async (event, { conversationId, prompt } = {}) => {
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
  }

  // ── Retrieve saved business memories ────────────────────────────────────
  let memories = []
  try {
    memories = db.getRecentMemories(db.BUSINESS_ID_DEFAULT, MAX_MEMORIES)
  } catch (err) {
    console.warn('[ipc] ollama:chat — failed to retrieve memories:', err)
  }

  // ── Retrieve conversation history ────────────────────────────────────────
  let previousMessages = []
  try {
    previousMessages = db.getRecentMessages(conversationId, MAX_CONTEXT_MESSAGES)
  } catch (err) {
    console.warn('[ipc] ollama:chat — failed to retrieve previous messages:', err)
  }

  // ── Save user message ────────────────────────────────────────────────────
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

  // Trigger automatic title generation locally via Ollama/Gemma (runs asynchronously)
  maybeGenerateTitle(event.sender, conversationId, trimmedPrompt)

  // ── Build Ollama payload ─────────────────────────────────────────────────
  const systemContent = buildSystemContent(profile, memories)
  const messagesPayload = [
    { role: 'system', content: systemContent },
    ...previousMessages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
    { role: 'user', content: trimmedPrompt },
  ]

  // ── Return immediately so the renderer can display the user message ──────
  // The rest of the work (streaming + saving) happens asynchronously.
  // We use a self-invoking async function so the handle can return first.
  ;(async () => {
    // Helper: push a terminal event to the renderer so it always exits loading
    const sendDone = (payload) => {
      try {
        event.sender.send('ollama:stream', { conversationId, done: true, ...payload })
      } catch {
        // Renderer may have been destroyed (window closed mid-stream) — ignore
      }
    }

    let res
    try {
      res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: messagesPayload,
          stream: true,
          options: { temperature: 0.3 },
        }),
      })
    } catch (err) {
      if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
        return sendDone({ error: 'Ollama is not running. Start it with: ollama serve' })
      }
      return sendDone({ error: `Unexpected error: ${err.message}` })
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      if (res.status === 404) {
        return sendDone({ error: `Model "${OLLAMA_MODEL}" not found. Run: ollama pull ${OLLAMA_MODEL}` })
      }
      return sendDone({ error: `Ollama error ${res.status}: ${text}` })
    }

    // ── Stream NDJSON chunks ─────────────────────────────────────────────
    // Ollama sends newline-delimited JSON: one object per line, each with
    // { message: { role, content }, done: false } until the final
    // { message: { content: '' }, done: true, ... }.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let accumulated = ''
    let buffer = ''

    try {
      while (true) {
        const { value, done: readerDone } = await reader.read()
        if (readerDone) break

        buffer += decoder.decode(value, { stream: true })

        // Process every complete newline-delimited JSON line in the buffer
        const lines = buffer.split('\n')
        // Keep the last (potentially incomplete) fragment in the buffer
        buffer = lines.pop()

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          let parsed
          try {
            parsed = JSON.parse(trimmed)
          } catch {
            console.warn('[stream] Could not parse Ollama line:', trimmed)
            continue
          }

          const chunk = parsed.message?.content ?? ''
          if (chunk) {
            accumulated += chunk
            // Push chunk to renderer — fire-and-forget, renderer accumulates
            try {
              event.sender.send('ollama:stream', { conversationId, chunk })
            } catch {
              // Renderer destroyed mid-stream
              return
            }
          }

          if (parsed.done) break
        }
      }
    } catch (err) {
      console.error('[stream] Error reading Ollama stream:', err)
      return sendDone({ error: `Stream read error: ${err.message}` })
    } finally {
      reader.releaseLock()
    }

    // ── Empty-response guard ─────────────────────────────────────────────
    if (accumulated.trim() === '') {
      return sendDone({ error: 'Ollama returned an empty response. Try rephrasing your message.' })
    }

    // ── Save the complete assistant response as ONE SQLite message ────────
    let assistantMessage
    try {
      assistantMessage = db.saveMessage({
        conversationId,
        role: 'assistant',
        content: accumulated,
      })
    } catch (err) {
      console.error('[stream] Failed to save assistant message:', err)
      return sendDone({ error: `Response received but failed to save: ${err.message}` })
    }

    // ── Signal completion ────────────────────────────────────────────────
    sendDone({ userMessage, assistantMessage })
  })()

  // Return to the renderer immediately with the saved user message
  return { streaming: true, userMessage }
})
// IPC — Groq Online Mode (with Browser Search)
ipcMain.handle('groq:chat', async (event, { conversationId, prompt } = {}) => {
  if (!conversationId) return { error: 'conversationId is required.' }

  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return { error: 'Prompt must be a non-empty string.' }
  }

  const conv = db.getConversation(conversationId)
  if (!conv) {
    return { error: `Conversation "${conversationId}" not found.` }
  }

  const apiKey = process.env.GROQ_API_KEY

  if (!apiKey || apiKey.trim() === '') {
    return {
      error: 'Groq API key is not configured. Please add GROQ_API_KEY=your_key to your .env file and restart the application.',
    }
  }

  const trimmedPrompt = prompt.trim()

  // ── Save user message to SQLite ──────────────────────────────────────────
  let userMessage

  try {
    userMessage = db.saveMessage({
      conversationId,
      role: 'user',
      content: trimmedPrompt,
    })
  } catch (err) {
    console.error('[ipc] groq:chat — failed to save user message:', err)
    return { error: `Failed to save message: ${err.message}` }
  }

  // Chat titles must ALWAYS be generated locally using the existing Gemma/Ollama setup
  maybeGenerateTitle(event.sender, conversationId, trimmedPrompt)

  // ── Call Groq API with Browser Search ─────────────────────────────────────
  try {
    const groq = new Groq({
      apiKey: apiKey.trim(),
    })

    const response = await groq.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages: [
        {
          role: 'user',
          content: trimmedPrompt,
        },
      ],
      tools: [
        {
          type: 'browser_search',
        },
      ],
      tool_choice: 'required',
      stream: true,
    })

   let responseText = ''

try {
  for await (const chunk of response) {
    const token = chunk.choices?.[0]?.delta?.content || ''

    if (token) {
      responseText += token

      event.sender.send('groq:stream', {
        conversationId,
        chunk: token,
      })
    }
  }
} catch (streamErr) {
  console.error('[ipc] groq:chat — streaming error:', streamErr)

  event.sender.send('groq:stream', {
    conversationId,
    done: true,
    error: streamErr.message,
  })

  return { error: `Groq streaming error: ${streamErr.message}` }
}

if (!responseText.trim()) {
  event.sender.send('groq:stream', {
    conversationId,
    done: true,
  })

  return { error: 'Groq returned an empty response.' }
}

// Save the complete assistant response after streaming finishes
const assistantMessage = db.saveMessage({
  conversationId,
  role: 'assistant',
  content: responseText,
})

event.sender.send('groq:stream', {
  conversationId,
  done: true,
})

return {
  userMessage,
  assistantMessage,
  sources: [],
}


  } catch (err) {
    console.error('[ipc] groq:chat — error:', err)
    return { error: `Groq API Error: ${err.message}` }
  }
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
