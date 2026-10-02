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
      currentDbPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'confide', 'confide.db')
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
  `)

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
    INSERT INTO conversations (id, title) VALUES (?, ?)
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
}
