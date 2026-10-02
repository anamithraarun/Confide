import { useState, useEffect, useRef } from 'react'

/**
 * App — Phase 6: Cross-Chat Business Memory
 *
 * Architecture:
 *  - Left sidebar: conversation list + New Chat button + Business Workspace button
 *  - Right panel (chat): message bubbles with per-message "Save to memory" pin button
 *  - Right panel (workspace): tabbed — "Profile" tab (Phase 5) | "Memory" tab (Phase 6)
 *
 * All data flows through window.confide IPC — SQLite is the source of truth.
 */
export default function App() {
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [bridgeOk, setBridgeOk] = useState(null)
  const messagesEndRef = useRef(null)

  // ── Business Workspace panel state ───────────────────────────────────────
  const [showProfile, setShowProfile] = useState(false)
  const [profileTab, setProfileTab] = useState('profile')   // 'profile' | 'memory'

  // ── Business Profile state (Phase 5) ─────────────────────────────────────
  const [profile, setProfile] = useState(null)
  const [profileForm, setProfileForm] = useState({
    businessName: '', industry: '', description: '',
    targetCustomers: '', budget: '',
  })
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileSaved, setProfileSaved] = useState(false)

  // ── Memory state (Phase 6) ───────────────────────────────────────────────
  const [memories, setMemories] = useState([])
  // pinState: Map of msgId → 'idle' | 'saving' | 'saved' | 'duplicate'
  const [pinState, setPinState] = useState({})
  const [memoryError, setMemoryError] = useState('')

  // ── Bridge check + initial data load ────────────────────────────────────
  useEffect(() => {
    if (typeof window.confide === 'undefined') {
      setBridgeOk(false)
      return
    }
    window.confide.invoke('ping')
      .then(() => setBridgeOk(true))
      .catch(() => setBridgeOk(false))

    loadConversations()
    loadProfile()
    loadMemories()
  }, [])

  // ── Scroll to bottom whenever messages change ────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Load conversation list ───────────────────────────────────────────────
  async function loadConversations() {
    const result = await window.confide.invoke('conversation:list')
    if (result.error) { setError(result.error); return }
    setConversations(result.conversations)
  }

  // ── Load business profile ────────────────────────────────────────────────
  async function loadProfile() {
    const result = await window.confide.invoke('profile:get')
    if (result.error) return
    const p = result.profile
    setProfile(p)
    if (p) {
      setProfileForm({
        businessName:    p.business_name    ?? '',
        industry:        p.industry         ?? '',
        description:     p.description      ?? '',
        targetCustomers: p.target_customers ?? '',
        budget:          p.budget           ?? '',
      })
    }
  }

  // ── Load memories (Phase 6) ──────────────────────────────────────────────
  async function loadMemories() {
    const result = await window.confide.invoke('memory:list')
    if (result.error) return   // non-fatal
    setMemories(result.memories)
  }

  // ── Select a conversation ────────────────────────────────────────────────
  async function selectConversation(id) {
    setShowProfile(false)
    setActiveId(id)
    setError('')
    setPrompt('')
    const result = await window.confide.invoke('conversation:messages', { conversationId: id })
    if (result.error) { setError(result.error); setMessages([]) }
    else setMessages(result.messages)
  }

  // ── Create a new conversation ────────────────────────────────────────────
  async function handleNewChat() {
    const result = await window.confide.invoke('conversation:create', { title: 'New Conversation' })
    if (result.error) { setError(result.error); return }
    await loadConversations()
    await selectConversation(result.conversation.id)
  }

  // ── Delete a conversation ────────────────────────────────────────────────
  async function handleDelete(id, e) {
    e.stopPropagation()
    const result = await window.confide.invoke('conversation:delete', { conversationId: id })
    if (result.error) { setError(result.error); return }
    if (activeId === id) { setActiveId(null); setMessages([]) }
    await loadConversations()
  }

  // ── Send prompt → Ollama ─────────────────────────────────────────────────
  async function handleSend() {
    const trimmed = prompt.trim()
    if (!trimmed || !activeId || loading) return

    setLoading(true)
    setError('')
    setPrompt('')

    const optimisticUser = { id: '__optimistic__', role: 'user', content: trimmed, created_at: new Date().toISOString() }
    setMessages(prev => [...prev, optimisticUser])

    try {
      const result = await window.confide.invoke('ollama:chat', {
        conversationId: activeId,
        prompt: trimmed,
      })

      if (result.error) {
        setError(result.error)
        setMessages(prev => prev.filter(m => m.id !== '__optimistic__'))
      } else {
        setMessages(prev => [
          ...prev.filter(m => m.id !== '__optimistic__'),
          result.userMessage,
          result.assistantMessage,
        ])
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

  // ── Open workspace panel ─────────────────────────────────────────────────
  function openProfile() {
    setShowProfile(true)
    setActiveId(null)
    setMessages([])
    setError('')
    setProfileError('')
    setProfileSaved(false)
    setMemoryError('')
  }

  // ── Save business profile ────────────────────────────────────────────────
  async function handleProfileSave(e) {
    e.preventDefault()
    setProfileSaving(true)
    setProfileError('')
    setProfileSaved(false)

    const result = await window.confide.invoke('profile:save', {
      businessName:    profileForm.businessName,
      industry:        profileForm.industry,
      description:     profileForm.description,
      targetCustomers: profileForm.targetCustomers,
      budget:          profileForm.budget,
    })

    setProfileSaving(false)
    if (result.error) { setProfileError(result.error); return }
    setProfile(result.profile)
    setProfileSaved(true)
    setTimeout(() => setProfileSaved(false), 2500)
  }

  // ── Save a message to Business Memory (Phase 6) ──────────────────────────
  async function handleSaveToMemory(content, msgId) {
    setPinState(prev => ({ ...prev, [msgId]: 'saving' }))
    setMemoryError('')

    const result = await window.confide.invoke('memory:create', {
      content,
      source: 'chat',
    })

    if (result.error) {
      setMemoryError(result.error)
      setPinState(prev => ({ ...prev, [msgId]: 'idle' }))
      return
    }

    // result = { memory, duplicate }
    setPinState(prev => ({ ...prev, [msgId]: result.duplicate ? 'duplicate' : 'saved' }))
    if (!result.duplicate) await loadMemories()
    // Reset pin back to idle after a moment
    setTimeout(() => setPinState(prev => ({ ...prev, [msgId]: 'idle' })), 2200)
  }

  // ── Delete a memory (Phase 6) ────────────────────────────────────────────
  async function handleDeleteMemory(memoryId) {
    setMemoryError('')
    const result = await window.confide.invoke('memory:delete', { memoryId })
    if (result.error) { setMemoryError(result.error); return }
    await loadMemories()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render helpers
  // ─────────────────────────────────────────────────────────────────────────

  // Pin button rendered next to every real (non-optimistic) message
  function PinButton({ msg }) {
    const state = pinState[msg.id] || 'idle'
    const isSaving = state === 'saving'

    let label = '📌'
    let title = 'Save to Business Memory'
    if (state === 'saving')   { label = '…';  title = 'Saving…' }
    if (state === 'saved')    { label = '✓';  title = 'Saved to memory' }
    if (state === 'duplicate'){ label = '✓';  title = 'Already in memory' }

    return (
      <button
        style={
          state === 'saved' || state === 'duplicate'
            ? { ...s.pinBtn, ...s.pinBtnSaved }
            : s.pinBtn
        }
        onClick={() => !isSaving && handleSaveToMemory(msg.content, msg.id)}
        title={title}
        disabled={isSaving}
        aria-label={title}
      >
        {label}
      </button>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside style={s.sidebar}>
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
              >×</button>
            </div>
          ))}
        </div>

        {/* Business Workspace button — pinned to sidebar bottom */}
        <div style={s.sidebarBottom}>
          <button
            style={showProfile ? { ...s.profileBtn, ...s.profileBtnActive } : s.profileBtn}
            onClick={openProfile}
            title="Business Workspace"
          >
            <span style={s.profileBtnIcon}>🏢</span>
            <span style={s.profileBtnLabel}>
              {profile?.business_name ? profile.business_name : 'Set up workspace'}
            </span>
            {!profile?.business_name && <span style={s.profileBtnBadge}>!</span>}
          </button>
          {memories.length > 0 && (
            <div style={s.memoryBadgeRow}>
              <span style={s.memoryBadge}>📌 {memories.length} {memories.length === 1 ? 'memory' : 'memories'}</span>
            </div>
          )}
        </div>
      </aside>

      {/* ── Main panel ──────────────────────────────────────────────────── */}
      <div style={s.panel}>

        {/* ── Business Workspace panel ──────────────────────────────────── */}
        {showProfile ? (
          <>
            <header style={s.header}>
              <span style={s.headerTitle}>Business Workspace</span>
              <span style={s.model}>local · private</span>
            </header>

            <main style={{ ...s.messages, display: 'block', overflowY: 'auto' }}>
              <div style={s.profilePanel}>

                {/* Tabs */}
                <div style={s.profileTabs}>
                  <button
                    style={profileTab === 'profile' ? { ...s.profileTabBtn, ...s.profileTabBtnActive } : s.profileTabBtn}
                    onClick={() => setProfileTab('profile')}
                  >
                    Business Profile
                  </button>
                  <button
                    style={profileTab === 'memory' ? { ...s.profileTabBtn, ...s.profileTabBtnActive } : s.profileTabBtn}
                    onClick={() => setProfileTab('memory')}
                  >
                    Business Memory
                    {memories.length > 0 && (
                      <span style={s.tabCount}>{memories.length}</span>
                    )}
                  </button>
                </div>

                {/* ── Profile tab ─────────────────────────────────────────── */}
                {profileTab === 'profile' && (
                  <>
                    <p style={s.profileIntro}>
                      Your business information is stored locally and used to give the AI context
                      when you chat. It never leaves your device.
                    </p>

                    {profileError && (
                      <div style={s.errorBox}>
                        <strong style={{ color: '#f87171' }}>Error: </strong>
                        <code style={s.errorText}>{profileError}</code>
                      </div>
                    )}

                    {profileSaved && (
                      <div style={s.successBox}>
                        ✓ Profile saved — Confide will use this context in all new chats.
                      </div>
                    )}

                    <form onSubmit={handleProfileSave} style={s.profileForm}>
                      <label style={s.fieldLabel}>
                        Business name <span style={s.required}>*</span>
                      </label>
                      <input
                        style={s.fieldInput}
                        type="text"
                        placeholder="e.g. Acme Corp"
                        value={profileForm.businessName}
                        onChange={e => setProfileForm(f => ({ ...f, businessName: e.target.value }))}
                        required
                      />

                      <label style={s.fieldLabel}>Industry</label>
                      <input
                        style={s.fieldInput}
                        type="text"
                        placeholder="e.g. SaaS, E-commerce, Consulting…"
                        value={profileForm.industry}
                        onChange={e => setProfileForm(f => ({ ...f, industry: e.target.value }))}
                      />

                      <label style={s.fieldLabel}>Business description</label>
                      <textarea
                        style={{ ...s.fieldInput, ...s.fieldTextarea }}
                        rows={4}
                        placeholder="What does your business do? What problem does it solve?"
                        value={profileForm.description}
                        onChange={e => setProfileForm(f => ({ ...f, description: e.target.value }))}
                      />

                      <label style={s.fieldLabel}>Target customers</label>
                      <input
                        style={s.fieldInput}
                        type="text"
                        placeholder="e.g. Small business owners in the US"
                        value={profileForm.targetCustomers}
                        onChange={e => setProfileForm(f => ({ ...f, targetCustomers: e.target.value }))}
                      />

                      <label style={s.fieldLabel}>Budget / financial context</label>
                      <input
                        style={s.fieldInput}
                        type="text"
                        placeholder="e.g. Bootstrap, $50k ARR, Series A…"
                        value={profileForm.budget}
                        onChange={e => setProfileForm(f => ({ ...f, budget: e.target.value }))}
                      />

                      <button
                        type="submit"
                        style={profileSaving ? { ...s.saveBtn, ...s.sendBtnDisabled } : s.saveBtn}
                        disabled={profileSaving}
                      >
                        {profileSaving ? 'Saving…' : 'Save profile'}
                      </button>
                    </form>
                  </>
                )}

                {/* ── Memory tab (Phase 6) ─────────────────────────────────── */}
                {profileTab === 'memory' && (
                  <>
                    <p style={s.profileIntro}>
                      Saved facts the AI will remember across all conversations.
                      Pin any message with 📌 in chat to save it here.
                    </p>

                    {memoryError && (
                      <div style={s.errorBox}>
                        <strong style={{ color: '#f87171' }}>Error: </strong>
                        <code style={s.errorText}>{memoryError}</code>
                      </div>
                    )}

                    {memories.length === 0 ? (
                      <p style={{ ...s.profileIntro, marginTop: 24 }}>
                        No memories saved yet. Open a chat and click 📌 on any message to save it.
                      </p>
                    ) : (
                      <ul style={s.memoryList}>
                        {memories.map(mem => (
                          <li key={mem.id} style={s.memoryItem}>
                            <p style={s.memoryContent}>{mem.content}</p>
                            <div style={s.memoryMeta}>
                              <span style={s.memoryDate}>
                                {new Date(mem.created_at).toLocaleDateString(undefined, {
                                  month: 'short', day: 'numeric', year: 'numeric',
                                })}
                              </span>
                              <button
                                style={s.memoryDeleteBtn}
                                onClick={() => handleDeleteMemory(mem.id)}
                                title="Delete this memory"
                              >
                                Delete
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}

              </div>
            </main>
          </>
        ) : (
          /* ── Chat view (Phase 1–4 preserved, Phase 6 pin buttons added) ── */
          <>
            <header style={s.header}>
              <span style={s.headerTitle}>
                {activeId
                  ? (conversations.find(c => c.id === activeId)?.title ?? 'Conversation')
                  : 'Select or create a conversation'}
              </span>
              <span style={s.model}>gemma3:1b · local</span>
            </header>

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
                  <div style={s.bubbleHeader}>
                    <span style={msg.role === 'user' ? s.roleUser : s.roleAssistant}>
                      {msg.role === 'user' ? 'You' : 'gemma3:1b'}
                    </span>
                    {/* Only real (persisted) messages can be pinned */}
                    {msg.id !== '__optimistic__' && (
                      <PinButton msg={msg} />
                    )}
                  </div>
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
          </>
        )}

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

  // Sidebar bottom — business profile button
  sidebarBottom: {
    padding: '8px 12px 16px',
    borderTop: '1px solid #1e1e2e',
    flexShrink: 0,
  },
  profileBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '9px 10px',
    background: 'none',
    border: '1px solid #1e1e2e',
    borderRadius: '8px',
    color: '#9ca3af',
    cursor: 'pointer',
    fontSize: '0.8rem',
    textAlign: 'left',
    WebkitAppRegion: 'no-drag',
  },
  profileBtnActive: {
    background: '#1e1e2e',
    borderColor: '#7c3aed',
    color: '#e0e0e0',
  },
  profileBtnIcon: {
    fontSize: '0.9rem',
    flexShrink: 0,
  },
  profileBtnLabel: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  profileBtnBadge: {
    background: '#f59e0b',
    color: '#000',
    borderRadius: '50%',
    width: 16,
    height: 16,
    fontSize: '0.65rem',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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

  // Business Profile panel (Phase 5)
  profilePanel: {
    maxWidth: '560px',
    margin: '0 auto',
    padding: '8px 0 40px',
  },
  profileIntro: {
    fontSize: '0.85rem',
    color: '#6b7280',
    lineHeight: 1.6,
    marginBottom: '24px',
  },
  profileForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  fieldLabel: {
    fontSize: '0.78rem',
    fontWeight: 600,
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginTop: '12px',
  },
  required: {
    color: '#f87171',
  },
  fieldInput: {
    background: '#1a1a24',
    border: '1px solid #2a2a3a',
    borderRadius: '8px',
    padding: '9px 12px',
    color: '#e0e0e0',
    fontSize: '0.88rem',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  fieldTextarea: {
    resize: 'vertical',
    lineHeight: 1.5,
  },
  saveBtn: {
    marginTop: '20px',
    padding: '10px 24px',
    background: 'linear-gradient(135deg, #7c3aed, #2563eb)',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  successBox: {
    padding: '10px 14px',
    background: '#052e16',
    border: '1px solid #16a34a',
    borderRadius: '8px',
    fontSize: '0.82rem',
    color: '#86efac',
    marginBottom: '8px',
  },

  // ── Phase 6: message bubble header + pin button ──────────────────────────
  bubbleHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '6px',
  },
  pinBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '0.75rem',
    color: '#4b5563',
    padding: '0 2px',
    lineHeight: 1,
    flexShrink: 0,
    opacity: 0.5,
    transition: 'opacity 0.15s',
  },
  pinBtnSaved: {
    color: '#34d399',
    opacity: 1,
  },

  // ── Phase 6: memory count badge below workspace button ───────────────────
  memoryBadgeRow: {
    marginTop: '6px',
    textAlign: 'center',
  },
  memoryBadge: {
    fontSize: '0.7rem',
    color: '#6b7280',
    letterSpacing: '0.02em',
  },

  // ── Phase 6: profile panel tabs ──────────────────────────────────────────
  profileTabs: {
    display: 'flex',
    gap: '4px',
    marginBottom: '20px',
    borderBottom: '1px solid #1e1e2e',
    paddingBottom: '0',
  },
  profileTabBtn: {
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    padding: '8px 14px',
    fontSize: '0.83rem',
    fontWeight: 500,
    color: '#6b7280',
    cursor: 'pointer',
    marginBottom: '-1px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  profileTabBtnActive: {
    color: '#a78bfa',
    borderBottomColor: '#7c3aed',
  },
  tabCount: {
    background: '#2a2a3a',
    color: '#a78bfa',
    borderRadius: '10px',
    padding: '1px 6px',
    fontSize: '0.7rem',
    fontWeight: 600,
  },

  // ── Phase 6: memory list ──────────────────────────────────────────────────
  memoryList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  memoryItem: {
    background: '#1a1a24',
    border: '1px solid #2a2a3a',
    borderRadius: '8px',
    padding: '12px 14px',
  },
  memoryContent: {
    margin: '0 0 8px',
    fontSize: '0.88rem',
    lineHeight: 1.55,
    color: '#e0e0e0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  memoryMeta: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  memoryDate: {
    fontSize: '0.72rem',
    color: '#4b5563',
  },
  memoryDeleteBtn: {
    background: 'none',
    border: '1px solid #3f3f50',
    borderRadius: '5px',
    padding: '2px 10px',
    fontSize: '0.72rem',
    color: '#f87171',
    cursor: 'pointer',
  },
}
