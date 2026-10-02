import { useState, useEffect, useRef } from 'react'

/**
 * App — Phase 3: SQLite-backed multi-conversation UI
 *
 * Architecture:
 *  - Left sidebar: conversation list + New Chat button
 *  - Right panel: messages for active conversation + prompt input
 *
 * All data flows through window.confide IPC — React holds no source-of-truth state,
 * SQLite is the source of truth.
 */
export default function App() {
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)        // active conversation id
  const [messages, setMessages] = useState([])
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [bridgeOk, setBridgeOk] = useState(null)
  const messagesEndRef = useRef(null)

  // ── Bridge check + initial conversation load ─────────────────────────────
  useEffect(() => {
    if (typeof window.confide === 'undefined') {
      setBridgeOk(false)
      return
    }
    window.confide.invoke('ping')
      .then(() => setBridgeOk(true))
      .catch(() => setBridgeOk(false))

    loadConversations()
  }, [])

  // ── Scroll to bottom whenever messages change ────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Load conversation list from SQLite ───────────────────────────────────
  async function loadConversations() {
    const result = await window.confide.invoke('conversation:list')
    if (result.error) {
      setError(result.error)
      return
    }
    setConversations(result.conversations)
  }

  // ── Select a conversation and load its messages ──────────────────────────
  async function selectConversation(id) {
    setActiveId(id)
    setError('')
    setPrompt('')
    const result = await window.confide.invoke('conversation:messages', { conversationId: id })
    if (result.error) {
      setError(result.error)
      setMessages([])
    } else {
      setMessages(result.messages)
    }
  }

  // ── Create a new conversation ────────────────────────────────────────────
  async function handleNewChat() {
    const result = await window.confide.invoke('conversation:create', { title: 'New Conversation' })
    if (result.error) {
      setError(result.error)
      return
    }
    await loadConversations()
    await selectConversation(result.conversation.id)
  }

  // ── Delete a conversation ────────────────────────────────────────────────
  async function handleDelete(id, e) {
    e.stopPropagation() // don't also trigger selectConversation
    const result = await window.confide.invoke('conversation:delete', { conversationId: id })
    if (result.error) {
      setError(result.error)
      return
    }
    if (activeId === id) {
      setActiveId(null)
      setMessages([])
    }
    await loadConversations()
  }

  // ── Send prompt → Ollama → save both messages ────────────────────────────
  async function handleSend() {
    const trimmed = prompt.trim()
    if (!trimmed || !activeId || loading) return

    setLoading(true)
    setError('')
    setPrompt('')

    // Optimistically append the user message to the UI immediately
    const optimisticUser = { id: '__optimistic__', role: 'user', content: trimmed, created_at: new Date().toISOString() }
    setMessages(prev => [...prev, optimisticUser])

    try {
      const result = await window.confide.invoke('ollama:chat', {
        conversationId: activeId,
        prompt: trimmed,
      })

      if (result.error) {
        setError(result.error)
        // Remove the optimistic message on error
        setMessages(prev => prev.filter(m => m.id !== '__optimistic__'))
      } else {
        // Replace optimistic + add real messages from DB
        setMessages(prev => [
          ...prev.filter(m => m.id !== '__optimistic__'),
          result.userMessage,
          result.assistantMessage,
        ])
        // Refresh sidebar (updated_at changed)
        await loadConversations()
      }
    } catch (err) {
      setError(`IPC error: ${err.message}`)
      setMessages(prev => prev.filter(m => m.id !== '__optimistic__'))
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && e.metaKey) handleSend()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside style={s.sidebar}>
        {/* Traffic-light drag region */}
        <div style={s.sidebarTop}>
          <span style={s.appName}>Confide</span>
          <span style={bridgeOk === null ? s.dot : bridgeOk ? s.dotOk : s.dotErr} />
        </div>

        <button style={s.newChatBtn} onClick={handleNewChat}>
          + New Chat
        </button>

        <div style={s.convList}>
          {conversations.length === 0 && (
            <p style={s.empty}>No conversations yet</p>
          )}
          {conversations.map(conv => (
            <div
              key={conv.id}
              style={conv.id === activeId ? { ...s.convItem, ...s.convItemActive } : s.convItem}
              onClick={() => selectConversation(conv.id)}
            >
              <span style={s.convTitle}>{conv.title}</span>
              <button
                style={s.deleteBtn}
                onClick={(e) => handleDelete(conv.id, e)}
                title="Delete conversation"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main panel ──────────────────────────────────────────────────── */}
      <div style={s.panel}>
        {/* Header */}
        <header style={s.header}>
          <span style={s.headerTitle}>
            {activeId
              ? (conversations.find(c => c.id === activeId)?.title ?? 'Conversation')
              : 'Select or create a conversation'}
          </span>
          <span style={s.model}>gemma3:1b · local</span>
        </header>

        {/* Messages */}
        <main style={s.messages}>
          {!activeId && (
            <p style={s.placeholder}>← Create a new chat to get started</p>
          )}

          {activeId && messages.length === 0 && !loading && (
            <p style={s.placeholder}>Send a message to begin</p>
          )}

          {messages.map(msg => (
            <div
              key={msg.id}
              style={msg.role === 'user' ? s.userBubble : s.assistantBubble}
            >
              <span style={msg.role === 'user' ? s.roleUser : s.roleAssistant}>
                {msg.role === 'user' ? 'You' : 'gemma3:1b'}
              </span>
              <p style={s.msgText}>{msg.content}</p>
            </div>
          ))}

          {loading && (
            <div style={s.assistantBubble}>
              <span style={s.roleAssistant}>gemma3:1b</span>
              <p style={{ ...s.msgText, color: '#6b7280' }}>Thinking…</p>
            </div>
          )}

          {error && (
            <div style={s.errorBox}>
              <strong style={{ color: '#f87171' }}>Error: </strong>
              <code style={s.errorText}>{error}</code>
            </div>
          )}

          <div ref={messagesEndRef} />
        </main>

        {/* Input */}
        <footer style={s.footer}>
          <textarea
            style={s.textarea}
            rows={3}
            placeholder={activeId ? 'Enter your prompt… (⌘↩ to send)' : 'Select a conversation first'}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeId || loading}
          />
          <button
            style={(!activeId || loading || !prompt.trim()) ? { ...s.sendBtn, ...s.sendBtnDisabled } : s.sendBtn}
            onClick={handleSend}
            disabled={!activeId || loading || !prompt.trim()}
          >
            {loading ? '…' : 'Send ⌘↩'}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const s = {
  root: {
    display: 'flex',
    height: '100vh',
    background: '#0f0f13',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: '#e0e0e0',
    overflow: 'hidden',
  },

  // Sidebar
  sidebar: {
    width: '220px',
    flexShrink: 0,
    background: '#13131a',
    borderRight: '1px solid #1e1e2e',
    display: 'flex',
    flexDirection: 'column',
  },
  sidebarTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '20px 16px 12px',
    // Extra top padding for macOS traffic lights
    paddingTop: '52px',
    WebkitAppRegion: 'drag',
  },
  appName: {
    fontSize: '0.95rem',
    fontWeight: 700,
    background: 'linear-gradient(135deg, #a78bfa, #60a5fa)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  dot:    { width: 8, height: 8, borderRadius: '50%', background: '#4b5563', display: 'inline-block' },
  dotOk:  { width: 8, height: 8, borderRadius: '50%', background: '#34d399', display: 'inline-block' },
  dotErr: { width: 8, height: 8, borderRadius: '50%', background: '#f87171', display: 'inline-block' },

  newChatBtn: {
    margin: '0 12px 12px',
    padding: '9px 12px',
    background: 'linear-gradient(135deg, #7c3aed, #2563eb)',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
    WebkitAppRegion: 'no-drag',
  },

  convList: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 8px',
  },
  empty: {
    fontSize: '0.78rem',
    color: '#4b5563',
    textAlign: 'center',
    marginTop: '24px',
  },
  convItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px',
    borderRadius: '8px',
    cursor: 'pointer',
    marginBottom: '2px',
    gap: '6px',
  },
  convItemActive: {
    background: '#1e1e2e',
  },
  convTitle: {
    fontSize: '0.82rem',
    color: '#c4b5fd',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    color: '#4b5563',
    cursor: 'pointer',
    fontSize: '1rem',
    lineHeight: 1,
    padding: '0 2px',
    flexShrink: 0,
  },

  // Main panel
  panel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 24px',
    borderBottom: '1px solid #1e1e2e',
    flexShrink: 0,
    // Extra left space for macOS traffic lights when sidebar is present
    WebkitAppRegion: 'drag',
  },
  headerTitle: {
    fontSize: '0.9rem',
    fontWeight: 600,
    color: '#e0e0e0',
    WebkitAppRegion: 'no-drag',
  },
  model: {
    fontSize: '0.72rem',
    color: '#4b5563',
    letterSpacing: '0.06em',
  },

  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  placeholder: {
    color: '#4b5563',
    fontSize: '0.88rem',
    textAlign: 'center',
    marginTop: '80px',
  },

  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '72%',
    background: '#1e1e2e',
    border: '1px solid #2a2a3a',
    borderRadius: '12px 12px 2px 12px',
    padding: '12px 16px',
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    maxWidth: '80%',
    background: '#13131a',
    border: '1px solid #1e1e2e',
    borderRadius: '2px 12px 12px 12px',
    padding: '12px 16px',
  },
  roleUser: {
    display: 'block',
    fontSize: '0.68rem',
    color: '#60a5fa',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '6px',
  },
  roleAssistant: {
    display: 'block',
    fontSize: '0.68rem',
    color: '#a78bfa',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '6px',
  },
  msgText: {
    margin: 0,
    fontSize: '0.9rem',
    lineHeight: 1.65,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },

  errorBox: {
    padding: '12px 16px',
    background: '#1a0a0a',
    border: '1px solid #7f1d1d',
    borderRadius: '8px',
    fontSize: '0.82rem',
  },
  errorText: {
    color: '#fca5a5',
    fontFamily: 'ui-monospace, "SF Mono", monospace',
    fontSize: '0.8rem',
  },

  footer: {
    display: 'flex',
    gap: '10px',
    padding: '14px 24px',
    borderTop: '1px solid #1e1e2e',
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    background: '#1a1a24',
    border: '1px solid #2a2a3a',
    borderRadius: '10px',
    padding: '10px 14px',
    color: '#e0e0e0',
    fontSize: '0.88rem',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    resize: 'none',
    outline: 'none',
    lineHeight: 1.5,
  },
  sendBtn: {
    background: 'linear-gradient(135deg, #7c3aed, #2563eb)',
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    padding: '0 20px',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  sendBtnDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
  },
}
