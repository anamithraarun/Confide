/**
 * db.js — SQLite database layer
 *
 * Responsibilities:
 *  - Open (or create) the SQLite database in Electron's userData directory
 *  - Run schema migrations on first launch
 *  - Export typed helper functions used by ipcMain handlers in main.js
 *
 * Rules:
 *  - All SQL uses parameterized statements — no string interpolation of user data
 *  - This module is ONLY imported by main.js (main process)
 *  - The database object never leaves this module
 */

const Database = require('better-sqlite3')
const path = require('path')
const { app } = require('electron')

// ─────────────────────────────────────────────────────────────────────────────
// Database state & initialization
// ─────────────────────────────────────────────────────────────────────────────

let db
let currentDbPath

/**
 * initDB(customPath?) — open the database and apply schema.
 * Can be called explicitly or lazily by getDb().
 */
function initDB(customPath) {
  if (customPath) {
    currentDbPath = customPath
  } else if (!currentDbPath) {
    try {
      currentDbPath = path.join(app.getPath('userData'), 'confide.db')
    } catch {
      // Fallback if app is not yet ready or in test environment
      const baseDir = process.env.APPDATA || (process.platform === 'darwin'
        ? path.join(process.env.HOME || '', 'Library', 'Application Support')
        : path.join(process.env.HOME || '', '.config'))
      currentDbPath = path.join(baseDir, 'confide', 'confide.db')
    }
  }

  if (db && db.open) {
    return currentDbPath
  }

  db = new Database(currentDbPath)

  // WAL mode — better performance for reads during writes
  db.pragma('journal_mode = WAL')
  // Enforce foreign key constraints
  db.pragma('foreign_keys = ON')

  // ── Schema ──────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'New Conversation',
      auto_titled INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, created_at);

    -- Phase 5: single-row business profile (MVP — one workspace only)
    -- id is always the fixed value 'default' so there can only ever be one row.
    CREATE TABLE IF NOT EXISTS business_profile (
      id                  TEXT PRIMARY KEY DEFAULT 'default',
      business_name       TEXT NOT NULL DEFAULT '',
      industry            TEXT NOT NULL DEFAULT '',
      description         TEXT NOT NULL DEFAULT '',
      target_customers    TEXT NOT NULL DEFAULT '',
      budget              TEXT NOT NULL DEFAULT '',
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- ─────────────────────────────────────────────────────────────────────────
    -- Phase 5 (memories): workspace-scoped memory store
    --
    -- Design intent — multi-workspace migration path:
    --   • business_id is the workspace identifier.  In the MVP it always holds
    --     the value of BUSINESS_ID_DEFAULT ('default'), which mirrors the single
    --     row in business_profile (id = 'default').
    --   • When multiple workspaces are added, a proper "businesses" table will
    --     replace business_profile.  At that point:
    --       1. Add a real FK:  REFERENCES businesses(id) ON DELETE CASCADE
    --       2. Replace every use of BUSINESS_ID_DEFAULT with the real
    --          businesses.id UUID from the user's active workspace.
    --       3. No other schema or function changes are needed — every query is
    --          already parameterised on business_id.
    --   • No FK is declared here yet because business_profile uses a sentinel
    --     string PK rather than the future UUID scheme, and SQLite FK checks
    --     would fail during the transition.  The column name and query pattern
    --     are identical to what the final schema will use.
    --
    -- source: where the memory came from (e.g. 'user', 'chat', 'document')
    -- ─────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      content     TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'user',
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memories_business
      ON memories(business_id, created_at);
  `)

  // ── Schema migrations ────────────────────────────────────────────────────
  const conversationCols = db.prepare(`PRAGMA table_info(conversations)`).all()
  const hasAutoTitled = conversationCols.some(c => c.name === 'auto_titled')
  if (!hasAutoTitled) {
    // Existing conversations created before this feature default to auto_titled = 1
    // so they do not receive automatic titles
    db.exec(`ALTER TABLE conversations ADD COLUMN auto_titled INTEGER NOT NULL DEFAULT 1`)
  }

  console.log(`[db] Opened database at: ${currentDbPath}`)
  return currentDbPath
}

/**
 * getDb() — returns the active database connection, auto-reopening if closed.
 */
function getDb() {
  if (!db || !db.open) {
    initDB()
  }
  return db
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — called from main.js IPC handlers
// All are synchronous (better-sqlite3 is synchronous by design).
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a simple unique ID (timestamp + random suffix) */
function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * createConversation(title?) → conversation row
 */
function createConversation(title = 'New Conversation') {
  const id = makeId()
  const d = getDb()
  d.prepare(`
    INSERT INTO conversations (id, title, auto_titled) VALUES (?, ?, 0)
  `).run(id, String(title).trim() || 'New Conversation')

  return d.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id)
}

/**
 * listConversations() → conversation[] (newest first)
 */
function listConversations() {
  return getDb().prepare(`
    SELECT * FROM conversations ORDER BY updated_at DESC
  `).all()
}

/**
 * getConversation(id) → conversation row | undefined
 */
function getConversation(id) {
  return getDb().prepare(`SELECT * FROM conversations WHERE id = ?`).get(id)
}

/**
 * getMessages(conversationId) → message[] (oldest first)
 */
function getMessages(conversationId) {
  return getDb().prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(conversationId)
}

/**
 * getRecentMessages(conversationId, limit) → message[] (chronological order)
 * Fetches at most the last `limit` messages for context windows.
 */
function getRecentMessages(conversationId, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
  return getDb().prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    ) ORDER BY created_at ASC
  `).all(conversationId, safeLimit)
}

/**
 * saveMessage({ conversationId, role, content }) → message row
 * Also bumps conversations.updated_at so the list stays sorted correctly.
 */
function saveMessage({ conversationId, role, content }) {
  const id = makeId()
  const d = getDb()

  d.prepare(`
    INSERT INTO messages (id, conversation_id, role, content)
    VALUES (?, ?, ?, ?)
  `).run(id, conversationId, role, content)

  // Bump the conversation's updated_at timestamp
  d.prepare(`
    UPDATE conversations
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(conversationId)

  return d.prepare(`SELECT * FROM messages WHERE id = ?`).get(id)
}

/**
 * deleteConversation(id) → { deleted: boolean }
 * CASCADE on the foreign key removes all messages automatically.
 */
function deleteConversation(id) {
  const result = getDb().prepare(`DELETE FROM conversations WHERE id = ?`).run(id)
  return { deleted: result.changes > 0 }
}

/**
 * updateConversationTitle(id, title, isManual) → conversation row | undefined
 * Updates the conversation title and marks auto_titled = 1.
 * When isManual is true (user renamed), also bumps updated_at.
 */
function updateConversationTitle(id, title, isManual = false) {
  const trimmed = String(title).trim()
  if (!trimmed) return undefined
  const d = getDb()

  if (isManual) {
    d.prepare(`
      UPDATE conversations
      SET title = ?, auto_titled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(trimmed, id)
  } else {
    d.prepare(`
      UPDATE conversations
      SET title = ?, auto_titled = 1
      WHERE id = ?
    `).run(trimmed, id)
  }

  return d.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace identity (Phase 5)
//
// BUSINESS_ID_DEFAULT is the workspace identifier used throughout the MVP.
// It mirrors the sentinel PK value in the business_profile table ('default').
//
// Multi-workspace migration:
//   Replace this constant's value with a real businesses.id UUID retrieved
//   from whichever workspace the user has selected.  Every db function that
//   accepts a businessId parameter will work correctly without code changes —
//   only the value passed in needs to change.
// ─────────────────────────────────────────────────────────────────────────────

const BUSINESS_ID_DEFAULT = 'default'

// ─────────────────────────────────────────────────────────────────────────────
// Memory helpers (Phase 5)
//
// All functions are parameterised on businessId so they work correctly in
// both the MVP (businessId === BUSINESS_ID_DEFAULT) and in a future
// multi-workspace build (businessId === some UUID from businesses.id).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * createMemory({ businessId, content, source? }) → { memory, duplicate }
 *
 * businessId — which workspace owns this memory.
 *              Use BUSINESS_ID_DEFAULT in the MVP.
 * content    — the text to remember (trimmed, non-empty required).
 * source     — provenance hint: 'user' | 'chat' | 'document' (default 'user').
 *
 * Duplicate check: before inserting, look for an existing row whose content
 * matches case-insensitively after trimming.  If found, return the existing
 * row with { duplicate: true } so the caller can surface a "already saved"
 * message without creating redundant entries.
 */
function createMemory({ businessId, content, source = 'user' } = {}) {
  if (!businessId) throw new Error('businessId is required.')
  if (!content || String(content).trim() === '') throw new Error('content is required.')

  const d = getDb()
  const trimmed = String(content).trim()

  // Simple case-insensitive duplicate check — no embeddings needed for MVP
  const existing = d.prepare(`
    SELECT * FROM memories
    WHERE business_id = ?
      AND lower(content) = lower(?)
    LIMIT 1
  `).get(String(businessId), trimmed)

  if (existing) return { memory: existing, duplicate: true }

  const id = makeId()
  d.prepare(`
    INSERT INTO memories (id, business_id, content, source)
    VALUES (?, ?, ?, ?)
  `).run(id, String(businessId), trimmed, String(source).trim() || 'user')

  return { memory: d.prepare(`SELECT * FROM memories WHERE id = ?`).get(id), duplicate: false }
}

/**
 * getRecentMemories(businessId, limit) → memory[] (oldest first, for prompt injection)
 *
 * Fetches at most `limit` memories for the context window.
 * Inner query takes the most recently created N rows; outer re-sorts to
 * chronological (oldest first) so the model reads them in natural order.
 *
 * Limit is clamped to [1, 50].  For gemma3:1b keep this small (default 10).
 */
function getRecentMemories(businessId, limit = 10) {
  if (!businessId) throw new Error('businessId is required.')
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10))
  return getDb().prepare(`
    SELECT * FROM (
      SELECT * FROM memories
      WHERE business_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    ) ORDER BY created_at ASC
  `).all(String(businessId), safeLimit)
}

/**
 * getMemories(businessId) → memory[] (newest first)
 *
 * Returns all memories that belong to the given workspace.
 * In the MVP always pass BUSINESS_ID_DEFAULT.
 * In a multi-workspace build, pass the active workspace's businesses.id.
 */
function getMemories(businessId) {
  if (!businessId) throw new Error('businessId is required.')
  return getDb().prepare(`
    SELECT * FROM memories
    WHERE business_id = ?
    ORDER BY created_at DESC
  `).all(String(businessId))
}

/**
 * deleteMemory(id) → { deleted: boolean }
 *
 * Hard-deletes a single memory row by its primary key.
 * No cascade needed — memories have no child rows.
 */
function deleteMemory(id) {
  const result = getDb().prepare(`DELETE FROM memories WHERE id = ?`).run(id)
  return { deleted: result.changes > 0 }
}

// ─────────────────────────────────────────────────────────────────────────────
// Business Profile helpers (Phase 5)
// The table allows only one row, keyed by the fixed id 'default'.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getProfile() → profile row | null
 * Returns the single business profile row, or null if none has been saved yet.
 */
function getProfile() {
  const row = getDb().prepare(`SELECT * FROM business_profile WHERE id = 'default'`).get()
  return row ?? null
}

/**
 * saveProfile({ businessName, industry, description, targetCustomers, budget })
 * → profile row
 *
 * Upserts the single profile row. All fields are optional — omitted fields
 * keep their existing value (or empty string on first creation).
 */
function saveProfile({ businessName = '', industry = '', description = '', targetCustomers = '', budget = '' } = {}) {
  const d = getDb()

  d.prepare(`
    INSERT INTO business_profile (id, business_name, industry, description, target_customers, budget)
    VALUES ('default', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      business_name    = excluded.business_name,
      industry         = excluded.industry,
      description      = excluded.description,
      target_customers = excluded.target_customers,
      budget           = excluded.budget,
      updated_at       = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(
    String(businessName).trim(),
    String(industry).trim(),
    String(description).trim(),
    String(targetCustomers).trim(),
    String(budget).trim(),
  )

  return d.prepare(`SELECT * FROM business_profile WHERE id = 'default'`).get()
}

/**
 * closeDB() — close the connection cleanly on app quit.
 */
function closeDB() {
  if (db && db.open) {
    db.close()
    console.log('[db] Database closed.')
  }
}

module.exports = {
  initDB,
  closeDB,
  createConversation,
  listConversations,
  getConversation,
  getMessages,
  getRecentMessages,
  saveMessage,
  deleteConversation,
  updateConversationTitle,
  // Phase 5 — workspace identity
  BUSINESS_ID_DEFAULT,
  // Phase 5 — memories
  createMemory,
  getMemories,
  getRecentMemories,
  deleteMemory,
  // Phase 5 — business profile
  getProfile,
  saveProfile,
}
