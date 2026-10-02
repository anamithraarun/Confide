import { useState, useEffect, useRef } from 'react'

/**
 * App — Phase 8: UI Redesign & Polish
 *
 * All data-layer logic (IPC calls, state management, streaming) is preserved
 * verbatim from Phases 4–7.  Only JSX structure and styles have changed.
 *
 * Architecture:
 *  - Left sidebar (260px): branding, New Chat, conversations, workspace section, status
 *  - Right panel: chat view OR Business Workspace panel (profile + memory tabs)
 */
export default function App() {
  // ── Core chat state ──────────────────────────────────────────────────────
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [bridgeOk, setBridgeOk] = useState(null)
  const messagesEndRef = useRef(null)

  // ── Workspace panel state ────────────────────────────────────────────────
  const [showProfile, setShowProfile] = useState(false)
  const [profileTab, setProfileTab] = useState('profile')   // 'profile' | 'memory'

  // ── Business Profile state ───────────────────────────────────────────────
  const [profile, setProfile] = useState(null)
  const [profileForm, setProfileForm] = useState({
    businessName: '', industry: '', description: '',
    targetCustomers: '', budget: '',
  })
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileSaved, setProfileSaved] = useState(false)

  // ── Memory state ─────────────────────────────────────────────────────────
  const [memories, setMemories] = useState([])
  const [pinState, setPinState] = useState({})   // msgId → 'idle'|'saving'|'saved'|'duplicate'
  const [memoryError, setMemoryError] = useState('')

  // ── Streaming state ──────────────────────────────────────────────────────
  const [streamingContent, setStreamingContent] = useState('')
  const [streamingConvId, setStreamingConvId] = useState(null)

  // ── Boot ─────────────────────────────────────────────────────────────────
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

  // ── Scroll to bottom on new messages ────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent])

  // ── Data loaders ─────────────────────────────────────────────────────────
  async function loadConversations() {
    const result = await window.confide.invoke('conversation:list')
    if (result.error) { setError(result.error); return }
    setConversations(result.conversations)
  }

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

  async function loadMemories() {
    const result = await window.confide.invoke('memory:list')
    if (result.error) return
    setMemories(result.memories)
  }

  // ── Conversation actions ──────────────────────────────────────────────────
  async function selectConversation(id) {
    setShowProfile(false)
    setActiveId(id)
    setError('')
    setPrompt('')
    const result = await window.confide.invoke('conversation:messages', { conversationId: id })
    if (result.error) { setError(result.error); setMessages([]) }
    else setMessages(result.messages)
  }

  async function handleNewChat() {
    const result = await window.confide.invoke('conversation:create', { title: 'New Conversation' })
    if (result.error) { setError(result.error); return }
    await loadConversations()
    await selectConversation(result.conversation.id)
  }

  async function handleDelete(id, e) {
    e.stopPropagation()
    const result = await window.confide.invoke('conversation:delete', { conversationId: id })
    if (result.error) { setError(result.error); return }
    if (activeId === id) { setActiveId(null); setMessages([]) }
    await loadConversations()
  }

  // ── Send (streaming) ─────────────────────────────────────────────────────
  async function handleSend() {
    const trimmed = prompt.trim()
    if (!trimmed || !activeId || loading) return

    setLoading(true)
    setError('')
    setPrompt('')
    setStreamingContent('')
    setStreamingConvId(activeId)

    const optimisticUser = { id: '__optimistic__', role: 'user', content: trimmed, created_at: new Date().toISOString() }
    setMessages(prev => [...prev, optimisticUser])

    const unsub = window.confide.on('ollama:stream', (data) => {
      if (data.conversationId !== activeId) return

      if (data.done) {
        unsub()
        setStreamingContent('')
        setStreamingConvId(null)
        setLoading(false)

        if (data.error) {
          setError(data.error)
          setMessages(prev => prev.filter(m => m.id !== '__optimistic__'))
          return
        }

        setMessages(prev => [
          ...prev.filter(m => m.id !== '__optimistic__'),
          data.userMessage,
          data.assistantMessage,
        ])
        loadConversations()
      } else if (data.chunk) {
        setStreamingContent(prev => prev + data.chunk)
      }
    })

    try {
      const result = await window.confide.invoke('ollama:chat', {
        conversationId: activeId,
        prompt: trimmed,
      })

      if (result.error) {
        unsub()
        setError(result.error)
        setStreamingContent('')
        setStreamingConvId(null)
        setLoading(false)
        setMessages(prev => prev.filter(m => m.id !== '__optimistic__'))
        return
      }

      if (result.userMessage) {
        setMessages(prev => [
          ...prev.filter(m => m.id !== '__optimistic__'),
          result.userMessage,
        ])
      }
    } catch (err) {
      unsub()
      setError(`IPC error: ${err.message}`)
      setStreamingContent('')
      setStreamingConvId(null)
      setLoading(false)
      setMessages(prev => prev.filter(m => m.id !== '__optimistic__'))
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && e.metaKey) handleSend()
  }

  // ── Workspace panel ───────────────────────────────────────────────────────
  function openProfile() {
    setShowProfile(true)
    setActiveId(null)
    setMessages([])
    setError('')
    setProfileError('')
    setProfileSaved(false)
    setMemoryError('')
  }

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

  async function handleSaveToMemory(content, msgId) {
    setPinState(prev => ({ ...prev, [msgId]: 'saving' }))
    setMemoryError('')

    const result = await window.confide.invoke('memory:create', { content, source: 'chat' })

    if (result.error) {
      setMemoryError(result.error)
      setPinState(prev => ({ ...prev, [msgId]: 'idle' }))
      return
    }

    setPinState(prev => ({ ...prev, [msgId]: result.duplicate ? 'duplicate' : 'saved' }))
    if (!result.duplicate) await loadMemories()
    setTimeout(() => setPinState(prev => ({ ...prev, [msgId]: 'idle' })), 2200)
  }

  async function handleDeleteMemory(memoryId) {
    setMemoryError('')
    const result = await window.confide.invoke('memory:delete', { memoryId })
    if (result.error) { setMemoryError(result.error); return }
    await loadMemories()
  }

  // ── Suggestion chip handler ───────────────────────────────────────────────
  async function handleSuggestion(text) {
    if (loading) return
    // Create a new chat if none is active, then send the suggestion
    if (!activeId) {
      const result = await window.confide.invoke('conversation:create', { title: 'New Conversation' })
      if (result.error) { setError(result.error); return }
      await loadConversations()
      await selectConversation(result.conversation.id)
      // Let state settle, then set prompt — user can review before sending
      setPrompt(text)
      return
    }
    setPrompt(text)
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  function PinButton({ msg }) {
    const state = pinState[msg.id] || 'idle'
    const isSaving = state === 'saving'
    let label = '📌'
    let title = 'Save to Business Memory'
    if (state === 'saving')    { label = '…'; title = 'Saving…' }
    if (state === 'saved')     { label = '✓'; title = 'Saved to memory' }
    if (state === 'duplicate') { label = '✓'; title = 'Already in memory' }

    return (
      <button
        className="pin-btn"
        style={{
          ...s.pinBtn,
          ...(state === 'saved' || state === 'duplicate' ? s.pinBtnSaved : {}),
        }}
        onClick={() => !isSaving && handleSaveToMemory(msg.content, msg.id)}
        title={title}
        disabled={isSaving}
        aria-label={title}
      >
        {label}
      </button>
    )
  }

  const activeConv = conversations.find(c => c.id === activeId)

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>

      {/* ═══════════════════════════════════════════════════════════════════
          LEFT SIDEBAR
      ═══════════════════════════════════════════════════════════════════ */}
      <aside style={s.sidebar}>

        {/* ── Branding ──────────────────────────────────────────────────── */}
        <div style={s.brand}>
          <div style={s.brandInner}>
            <div style={s.brandLogo}>C</div>
            <div>
              <div style={s.brandName}>Confide</div>
              <div style={s.brandSub}>Private AI workspace</div>
            </div>
          </div>
          <span
            style={bridgeOk === null ? s.statusDot : bridgeOk ? s.statusDotOk : s.statusDotErr}
            title={bridgeOk ? 'Connected' : 'Bridge error'}
          />
        </div>

        {/* ── New Chat ──────────────────────────────────────────────────── */}
        <div style={s.sidebarSection}>
          <button className="new-chat-btn" style={s.newChatBtn} onClick={handleNewChat}>
            <span style={s.newChatIcon}>＋</span>
            New Chat
          </button>
        </div>

        {/* ── Conversations ─────────────────────────────────────────────── */}
        <div style={s.sidebarSection}>
          <div style={s.sectionLabel}>Conversations</div>
          <div style={s.convList}>
            {conversations.length === 0 && (
              <p style={s.convEmpty}>No conversations yet</p>
            )}
            {conversations.map(conv => (
              <div
                key={conv.id}
                className="conv-item"
                style={{
                  ...s.convItem,
                  ...(conv.id === activeId && !showProfile ? s.convItemActive : {}),
                }}
                onClick={() => selectConversation(conv.id)}
                title={conv.title}
              >
                <span style={s.convIcon}>💬</span>
                <span style={s.convTitle}>{conv.title}</span>
                <button
                  className="conv-delete"
                  style={s.convDelete}
                  onClick={(e) => handleDelete(conv.id, e)}
                  title="Delete conversation"
                  aria-label="Delete conversation"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* ── Workspace section ─────────────────────────────────────────── */}
        <div style={{ ...s.sidebarSection, marginTop: 'auto' }}>
          <div style={s.sectionLabel}>Workspace</div>

          <button
            className="sidebar-btn"
            style={{
              ...s.workspaceBtn,
              ...(showProfile && profileTab === 'profile' ? s.workspaceBtnActive : {}),
            }}
            onClick={() => {
              openProfile()
              setProfileTab('profile')
            }}
          >
            <span style={s.workspaceBtnIcon}>🏢</span>
            <div style={s.workspaceBtnText}>
              <span style={s.workspaceBtnLabel}>Business Profile</span>
              {profile?.business_name && (
                <span style={s.workspaceBtnSub}>{profile.business_name}</span>
              )}
            </div>
            {!profile?.business_name && <span style={s.setupBadge}>Set up</span>}
          </button>

          <button
            className="sidebar-btn"
            style={{
              ...s.workspaceBtn,
              marginTop: 4,
              ...(showProfile && profileTab === 'memory' ? s.workspaceBtnActive : {}),
            }}
            onClick={() => {
              openProfile()
              setProfileTab('memory')
            }}
          >
            <span style={s.workspaceBtnIcon}>🧠</span>
            <div style={s.workspaceBtnText}>
              <span style={s.workspaceBtnLabel}>Business Memory</span>
              {memories.length > 0 && (
                <span style={s.workspaceBtnSub}>{memories.length} {memories.length === 1 ? 'fact' : 'facts'} saved</span>
              )}
            </div>
          </button>
        </div>

        {/* ── Local status footer ───────────────────────────────────────── */}
        <div style={s.statusFooter}>
          <div style={s.statusRow}>
            <span style={s.statusIcon}>🔒</span>
            <span style={s.statusText}>Private Mode</span>
          </div>
          <div style={s.statusMeta}>
            <span>AI processing: Local</span>
            <span style={s.statusDivider}>·</span>
            <span>Storage: Local</span>
          </div>
          <div style={s.statusMeta}>Model: Gemma 3 1B</div>
        </div>

      </aside>

      {/* ═══════════════════════════════════════════════════════════════════
          MAIN PANEL
      ═══════════════════════════════════════════════════════════════════ */}
      <div style={s.main}>

        {/* ── Business Workspace panel ──────────────────────────────────── */}
        {showProfile ? (
          <div style={s.workspacePanel}>

            {/* Header */}
            <div style={s.workspaceHeader}>
              <div>
                <h1 style={s.workspaceTitle}>Business Workspace</h1>
                <p style={s.workspaceSubtitle}>
                  Context stored locally · Used by the AI in every conversation
                </p>
              </div>
            </div>

            {/* Tabs */}
            <div style={s.tabs}>
              <button
                className={`tab-btn${profileTab === 'profile' ? ' tab-btn-active' : ''}`}
                style={{
                  ...s.tabBtn,
                  ...(profileTab === 'profile' ? s.tabBtnActive : {}),
                }}
                onClick={() => setProfileTab('profile')}
              >
                Business Profile
              </button>
              <button
                className={`tab-btn${profileTab === 'memory' ? ' tab-btn-active' : ''}`}
                style={{
                  ...s.tabBtn,
                  ...(profileTab === 'memory' ? s.tabBtnActive : {}),
                }}
                onClick={() => setProfileTab('memory')}
              >
                Business Memory
                {memories.length > 0 && (
                  <span style={s.tabBadge}>{memories.length}</span>
                )}
              </button>
            </div>

            {/* Tab content */}
            <div style={s.workspaceContent}>

              {/* ── Profile tab ─────────────────────────────────────── */}
              {profileTab === 'profile' && (
                <div style={s.formPanel}>
                  <p style={s.formDesc}>
                    Tell Confide about your business so the AI can give you more relevant answers.
                    This information is stored entirely on your device.
                  </p>

                  {profileError && (
                    <div style={s.alertError}>⚠ {profileError}</div>
                  )}
                  {profileSaved && (
                    <div style={s.alertSuccess}>✓ Profile saved — the AI will use this context in all new chats.</div>
                  )}

                  <form onSubmit={handleProfileSave} style={s.form}>
                    <div style={s.fieldGroup}>
                      <label style={s.label}>
                        Business name <span style={s.required}>*</span>
                      </label>
                      <input
                        className="field-input"
                        style={s.input}
                        type="text"
                        placeholder="e.g. Acme Corp"
                        value={profileForm.businessName}
                        onChange={e => setProfileForm(f => ({ ...f, businessName: e.target.value }))}
                        required
                      />
                    </div>

                    <div style={s.fieldGroup}>
                      <label style={s.label}>Industry</label>
                      <input
                        className="field-input"
                        style={s.input}
                        type="text"
                        placeholder="e.g. SaaS, E-commerce, Consulting…"
                        value={profileForm.industry}
                        onChange={e => setProfileForm(f => ({ ...f, industry: e.target.value }))}
                      />
                    </div>

                    <div style={s.fieldGroup}>
                      <label style={s.label}>Business description</label>
                      <textarea
                        className="field-input"
                        style={{ ...s.input, ...s.textarea }}
                        rows={4}
                        placeholder="What does your business do? What problem does it solve?"
                        value={profileForm.description}
                        onChange={e => setProfileForm(f => ({ ...f, description: e.target.value }))}
                      />
                    </div>

                    <div style={s.fieldGroup}>
                      <label style={s.label}>Target customers</label>
                      <input
                        className="field-input"
                        style={s.input}
                        type="text"
                        placeholder="e.g. Small business owners in the US"
                        value={profileForm.targetCustomers}
                        onChange={e => setProfileForm(f => ({ ...f, targetCustomers: e.target.value }))}
                      />
                    </div>

                    <div style={s.fieldGroup}>
                      <label style={s.label}>Budget / financial context</label>
                      <input
                        className="field-input"
                        style={s.input}
                        type="text"
                        placeholder="e.g. Bootstrap, $50k ARR, Series A…"
                        value={profileForm.budget}
                        onChange={e => setProfileForm(f => ({ ...f, budget: e.target.value }))}
                      />
                    </div>

                    <button
                      type="submit"
                      className="save-btn"
                      style={{
                        ...s.primaryBtn,
                        ...(profileSaving ? s.primaryBtnDisabled : {}),
                      }}
                      disabled={profileSaving}
                    >
                      {profileSaving ? 'Saving…' : 'Save profile'}
                    </button>
                  </form>
                </div>
              )}

              {/* ── Memory tab ──────────────────────────────────────── */}
              {profileTab === 'memory' && (
                <div style={s.formPanel}>
                  <p style={s.formDesc}>
                    Saved facts the AI will remember across all conversations.
                    Open any chat and click 📌 on a message to save it here.
                  </p>

                  {memoryError && (
                    <div style={s.alertError}>⚠ {memoryError}</div>
                  )}

                  {memories.length === 0 ? (
                    <div style={s.emptyMemory}>
                      <div style={s.emptyMemoryIcon}>🧠</div>
                      <p style={s.emptyMemoryTitle}>No memories yet</p>
                      <p style={s.emptyMemoryDesc}>
                        Pin messages in chat to save important business facts here.
                        Confide will reference them across all your conversations.
                      </p>
                    </div>
                  ) : (
                    <ul style={s.memoryList}>
                      {memories.map(mem => (
                        <li key={mem.id} style={s.memoryCard}>
                          <p style={s.memoryText}>{mem.content}</p>
                          <div style={s.memoryFooter}>
                            <span style={s.memoryDate}>
                              {new Date(mem.created_at).toLocaleDateString(undefined, {
                                month: 'short', day: 'numeric', year: 'numeric',
                              })}
                            </span>
                            <button
                              className="memory-delete"
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
                </div>
              )}

            </div>
          </div>

        ) : (
          /* ── Chat view ──────────────────────────────────────────────── */
          <div style={s.chatView}>

            {/* ── Chat header ─────────────────────────────────────────── */}
            <div style={s.chatHeader}>
              <div style={s.chatHeaderLeft}>
                {activeId && (
                  <>
                    <span style={s.chatHeaderIcon}>💬</span>
                    <span style={s.chatHeaderTitle}>
                      {activeConv?.title ?? 'Conversation'}
                    </span>
                  </>
                )}
              </div>
              <div style={s.chatHeaderRight}>
                <span style={s.modelBadge}>
                  <span style={s.modelDot} />
                  Gemma 3 1B · local
                </span>
              </div>
            </div>

            {/* ── Messages area ───────────────────────────────────────── */}
            <div style={s.messagesArea}>
              <div style={s.messagesFeed}>

                {/* Empty state — no conversation selected */}
                {!activeId && (
                  <div style={s.emptyState}>
                    <div style={s.emptyLogo}>C</div>
                    <h2 style={s.emptyTitle}>Welcome to Confide</h2>
                    <p style={s.emptySubtitle}>
                      Your private AI workspace for sensitive business decisions.
                      <br />All AI processing and data stays on your device.
                    </p>
                    <div style={s.suggestions}>
                      {[
                        'Help me analyze my business idea',
                        'Create a marketing strategy',
                        'Review my pricing strategy',
                        'Help me plan my next product launch',
                      ].map(text => (
                        <button
                          key={text}
                          className="suggestion-chip"
                          style={s.chip}
                          onClick={() => handleSuggestion(text)}
                        >
                          {text}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Empty conversation — started but no messages */}
                {activeId && messages.length === 0 && !loading && (
                  <div style={s.emptyConv}>
                    <p style={s.emptyConvText}>Start the conversation below.</p>
                  </div>
                )}

                {/* Message list */}
                {messages.map(msg => (
                  <div
                    key={msg.id}
                    style={msg.role === 'user' ? s.userMsg : s.assistantMsg}
                  >
                    {msg.role === 'user' ? (
                      /* User message */
                      <div style={s.userMsgInner}>
                        <div style={s.userMsgHeader}>
                          <span style={s.userLabel}>You</span>
                          {msg.id !== '__optimistic__' && <PinButton msg={msg} />}
                        </div>
                        <p style={s.msgText}>{msg.content}</p>
                      </div>
                    ) : (
                      /* Assistant message */
                      <div style={s.assistantMsgInner}>
                        <div style={s.assistantMsgHeader}>
                          <div style={s.aiAvatar}>AI</div>
                          <span style={s.assistantLabel}>Confide</span>
                          {msg.id !== '__optimistic__' && <PinButton msg={msg} />}
                        </div>
                        <p style={s.msgText}>{msg.content}</p>
                      </div>
                    )}
                  </div>
                ))}

                {/* Streaming / loading bubble */}
                {loading && (
                  <div style={s.assistantMsg}>
                    <div style={s.assistantMsgInner}>
                      <div style={s.assistantMsgHeader}>
                        <div style={s.aiAvatar}>AI</div>
                        <span style={s.assistantLabel}>Confide</span>
                        {streamingContent && (
                          <span style={s.generatingBadge}>generating</span>
                        )}
                      </div>
                      <p style={s.msgText}>
                        {streamingContent || (
                          <span style={s.thinkingText}>Thinking…</span>
                        )}
                        {streamingContent && (
                          <span style={s.streamCursor}>▋</span>
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {/* Error */}
                {error && (
                  <div style={s.errorBanner}>
                    <span style={s.errorIcon}>⚠</span>
                    <span>{error}</span>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* ── Composer ────────────────────────────────────────────── */}
            <div style={s.composerWrap}>
              <div style={s.composer}>
                <textarea
                  className="composer-textarea"
                  style={s.composerTextarea}
                  rows={1}
                  placeholder={
                    activeId
                      ? 'Message Confide… (⌘↩ to send)'
                      : 'Start a new chat to begin'
                  }
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={!activeId || loading}
                />
                <button
                  className="send-btn"
                  style={{
                    ...s.sendBtn,
                    ...(!activeId || loading || !prompt.trim() ? s.sendBtnDisabled : {}),
                  }}
                  onClick={handleSend}
                  disabled={!activeId || loading || !prompt.trim()}
                  title="Send (⌘↩)"
                  aria-label="Send message"
                >
                  {loading ? (
                    <span style={s.sendBtnSpinner}>…</span>
                  ) : (
                    <span style={s.sendBtnArrow}>↑</span>
                  )}
                </button>
              </div>
              <p style={s.composerHint}>
                ⌘↩ to send · 📌 to save a message to Business Memory
              </p>
            </div>

          </div>
        )}

      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens
// ─────────────────────────────────────────────────────────────────────────────
const color = {
  bg:           '#0d0d10',
  sidebar:      '#111116',
  surface:      '#18181f',
  surfaceHover: '#1e1e28',
  border:       'rgba(255, 255, 255, 0.07)',
  borderFocus:  '#7c5cfc',
  accent:       '#7c5cfc',
  accentLight:  '#a78bfa',
  accentDim:    'rgba(124, 92, 252, 0.15)',
  text:         '#f0f0f5',
  textSec:      '#8b8b9e',
  textMuted:    '#5a5a6e',
  success:      '#22c55e',
  successBg:    'rgba(34, 197, 94, 0.1)',
  error:        '#f87171',
  errorBg:      'rgba(248, 113, 113, 0.1)',
  userMsgBg:    '#1e1e2c',
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const s = {

  // ── Root layout ───────────────────────────────────────────────────────────
  root: {
    display: 'flex',
    height: '100vh',
    background: color.bg,
    color: color.text,
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },

  // ── Sidebar ───────────────────────────────────────────────────────────────
  sidebar: {
    width: 260,
    flexShrink: 0,
    background: color.sidebar,
    borderRight: `1px solid ${color.border}`,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    paddingTop: 44,      // macOS traffic lights clearance
  },

  // Branding
  brand: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 16px 12px',
    WebkitAppRegion: 'drag',
    flexShrink: 0,
  },
  brandInner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    WebkitAppRegion: 'drag',
  },
  brandLogo: {
    width: 32,
    height: 32,
    borderRadius: 9,
    background: `linear-gradient(135deg, ${color.accent}, #2563eb)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1rem',
    fontWeight: 700,
    color: '#fff',
    flexShrink: 0,
  },
  brandName: {
    fontSize: '0.95rem',
    fontWeight: 700,
    color: color.text,
    lineHeight: 1.2,
  },
  brandSub: {
    fontSize: '0.68rem',
    color: color.textMuted,
    lineHeight: 1.2,
  },
  statusDot: {
    width: 7, height: 7, borderRadius: '50%',
    background: color.textMuted, display: 'inline-block', flexShrink: 0,
  },
  statusDotOk: {
    width: 7, height: 7, borderRadius: '50%',
    background: color.success, display: 'inline-block', flexShrink: 0,
  },
  statusDotErr: {
    width: 7, height: 7, borderRadius: '50%',
    background: color.error, display: 'inline-block', flexShrink: 0,
  },

  // Sidebar sections
  sidebarSection: {
    padding: '8px 12px',
    flexShrink: 0,
  },
  sectionLabel: {
    fontSize: '0.68rem',
    fontWeight: 600,
    color: color.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    padding: '4px 4px 8px',
  },

  // New Chat button
  newChatBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 12px',
    background: `linear-gradient(135deg, ${color.accent}, #2563eb)`,
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    fontSize: '0.83rem',
    fontWeight: 600,
    cursor: 'pointer',
    WebkitAppRegion: 'no-drag',
    transition: 'opacity 0.15s',
  },
  newChatIcon: {
    fontSize: '1rem',
    lineHeight: 1,
  },

  // Conversation list
  convList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    maxHeight: 320,
    overflowY: 'auto',
    WebkitAppRegion: 'no-drag',
  },
  convEmpty: {
    fontSize: '0.78rem',
    color: color.textMuted,
    padding: '8px 4px',
    textAlign: 'center',
  },
  convItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 8px',
    borderRadius: 7,
    cursor: 'pointer',
    WebkitAppRegion: 'no-drag',
    transition: 'background 0.12s',
    position: 'relative',
  },
  convItemActive: {
    background: color.accentDim,
  },
  convIcon: {
    fontSize: '0.8rem',
    flexShrink: 0,
    opacity: 0.6,
  },
  convTitle: {
    flex: 1,
    fontSize: '0.82rem',
    color: color.textSec,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  convDelete: {
    background: 'none',
    border: 'none',
    color: color.textMuted,
    cursor: 'pointer',
    fontSize: '0.7rem',
    padding: '2px 4px',
    borderRadius: 4,
    lineHeight: 1,
    flexShrink: 0,
    WebkitAppRegion: 'no-drag',
  },

  // Workspace buttons
  workspaceBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '9px 10px',
    background: 'none',
    border: `1px solid ${color.border}`,
    borderRadius: 8,
    color: color.textSec,
    cursor: 'pointer',
    fontSize: '0.82rem',
    textAlign: 'left',
    WebkitAppRegion: 'no-drag',
    transition: 'background 0.12s, border-color 0.12s',
  },
  workspaceBtnActive: {
    background: color.accentDim,
    borderColor: `rgba(124, 92, 252, 0.35)`,
    color: color.text,
  },
  workspaceBtnIcon: {
    fontSize: '0.95rem',
    flexShrink: 0,
  },
  workspaceBtnText: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    overflow: 'hidden',
  },
  workspaceBtnLabel: {
    fontSize: '0.82rem',
    fontWeight: 500,
    color: 'inherit',
  },
  workspaceBtnSub: {
    fontSize: '0.7rem',
    color: color.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  setupBadge: {
    background: 'rgba(245, 158, 11, 0.15)',
    color: '#f59e0b',
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: '0.65rem',
    fontWeight: 600,
    flexShrink: 0,
  },

  // Status footer
  statusFooter: {
    padding: '12px 16px 16px',
    borderTop: `1px solid ${color.border}`,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  statusIcon: {
    fontSize: '0.8rem',
  },
  statusText: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: color.textSec,
  },
  statusMeta: {
    fontSize: '0.68rem',
    color: color.textMuted,
    display: 'flex',
    gap: 4,
    flexWrap: 'wrap',
  },
  statusDivider: {
    color: color.textMuted,
    opacity: 0.4,
  },

  // ── Main panel ────────────────────────────────────────────────────────────
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: color.bg,
  },

  // ── Business Workspace panel ──────────────────────────────────────────────
  workspacePanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  workspaceHeader: {
    padding: '28px 40px 0',
    flexShrink: 0,
    borderBottom: `1px solid ${color.border}`,
    paddingBottom: 0,
  },
  workspaceTitle: {
    fontSize: '1.2rem',
    fontWeight: 700,
    color: color.text,
    marginBottom: 4,
  },
  workspaceSubtitle: {
    fontSize: '0.82rem',
    color: color.textSec,
    marginBottom: 20,
  },

  // Tabs
  tabs: {
    display: 'flex',
    gap: 0,
    padding: '0 40px',
    borderBottom: `1px solid ${color.border}`,
    flexShrink: 0,
  },
  tabBtn: {
    padding: '10px 18px',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    fontSize: '0.83rem',
    fontWeight: 500,
    color: color.textSec,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    marginBottom: -1,
    transition: 'color 0.15s',
  },
  tabBtnActive: {
    color: color.accentLight,
    borderBottomColor: color.accent,
  },
  tabBadge: {
    background: color.accentDim,
    color: color.accentLight,
    borderRadius: 10,
    padding: '1px 7px',
    fontSize: '0.7rem',
    fontWeight: 600,
  },

  // Workspace content
  workspaceContent: {
    flex: 1,
    overflowY: 'auto',
    padding: '28px 40px',
  },
  formPanel: {
    maxWidth: 560,
  },
  formDesc: {
    fontSize: '0.85rem',
    color: color.textSec,
    lineHeight: 1.65,
    marginBottom: 24,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginBottom: 16,
  },
  label: {
    fontSize: '0.78rem',
    fontWeight: 600,
    color: color.textSec,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  required: {
    color: color.error,
  },
  input: {
    background: color.surface,
    border: `1px solid ${color.border}`,
    borderRadius: 8,
    padding: '9px 12px',
    color: color.text,
    fontSize: '0.88rem',
    fontFamily: 'inherit',
    outline: 'none',
    width: '100%',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  textarea: {
    resize: 'vertical',
    lineHeight: 1.55,
    minHeight: 90,
  },
  primaryBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '9px 22px',
    background: `linear-gradient(135deg, ${color.accent}, #2563eb)`,
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 8,
    transition: 'opacity 0.15s',
  },
  primaryBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },

  // Alerts
  alertError: {
    padding: '10px 14px',
    background: color.errorBg,
    border: `1px solid rgba(248, 113, 113, 0.3)`,
    borderRadius: 8,
    fontSize: '0.83rem',
    color: color.error,
    marginBottom: 16,
  },
  alertSuccess: {
    padding: '10px 14px',
    background: color.successBg,
    border: `1px solid rgba(34, 197, 94, 0.3)`,
    borderRadius: 8,
    fontSize: '0.83rem',
    color: color.success,
    marginBottom: 16,
  },

  // Memory list
  emptyMemory: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '40px 20px',
    gap: 12,
    textAlign: 'center',
  },
  emptyMemoryIcon: {
    fontSize: '2rem',
    opacity: 0.5,
  },
  emptyMemoryTitle: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: color.textSec,
  },
  emptyMemoryDesc: {
    fontSize: '0.83rem',
    color: color.textMuted,
    lineHeight: 1.6,
    maxWidth: 360,
  },
  memoryList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  memoryCard: {
    background: color.surface,
    border: `1px solid ${color.border}`,
    borderRadius: 10,
    padding: '14px 16px',
  },
  memoryText: {
    fontSize: '0.88rem',
    lineHeight: 1.6,
    color: color.text,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: '0 0 10px',
  },
  memoryFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  memoryDate: {
    fontSize: '0.72rem',
    color: color.textMuted,
  },
  memoryDeleteBtn: {
    background: 'none',
    border: `1px solid ${color.border}`,
    borderRadius: 5,
    padding: '2px 10px',
    fontSize: '0.72rem',
    color: color.error,
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s',
  },

  // ── Chat view ─────────────────────────────────────────────────────────────
  chatView: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },

  // Chat header
  chatHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '13px 24px',
    borderBottom: `1px solid ${color.border}`,
    flexShrink: 0,
    WebkitAppRegion: 'drag',
    minHeight: 52,
  },
  chatHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    WebkitAppRegion: 'no-drag',
    overflow: 'hidden',
  },
  chatHeaderIcon: {
    fontSize: '0.85rem',
    opacity: 0.6,
    flexShrink: 0,
  },
  chatHeaderTitle: {
    fontSize: '0.88rem',
    fontWeight: 600,
    color: color.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chatHeaderRight: {
    flexShrink: 0,
    WebkitAppRegion: 'no-drag',
  },
  modelBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: '0.72rem',
    color: color.textMuted,
    background: color.surface,
    border: `1px solid ${color.border}`,
    borderRadius: 20,
    padding: '3px 10px',
  },
  modelDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: color.success,
    flexShrink: 0,
  },

  // Messages area
  messagesArea: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    justifyContent: 'center',
  },
  messagesFeed: {
    width: '100%',
    maxWidth: 720,
    padding: '28px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },

  // Empty states
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '60px 20px 40px',
    gap: 12,
  },
  emptyLogo: {
    width: 56,
    height: 56,
    borderRadius: 16,
    background: `linear-gradient(135deg, ${color.accent}, #2563eb)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.5rem',
    fontWeight: 700,
    color: '#fff',
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: '1.3rem',
    fontWeight: 700,
    color: color.text,
  },
  emptySubtitle: {
    fontSize: '0.88rem',
    color: color.textSec,
    lineHeight: 1.7,
    maxWidth: 400,
  },
  suggestions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
    marginTop: 8,
  },
  chip: {
    background: color.surface,
    border: `1px solid ${color.border}`,
    borderRadius: 20,
    padding: '7px 16px',
    fontSize: '0.82rem',
    color: color.textSec,
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
  },
  emptyConv: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '80px 20px',
  },
  emptyConvText: {
    fontSize: '0.88rem',
    color: color.textMuted,
  },

  // Messages
  userMsg: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginBottom: 20,
    animation: 'fadeIn 0.18s ease-out',
  },
  userMsgInner: {
    maxWidth: '68%',
    background: color.userMsgBg,
    border: `1px solid rgba(255,255,255,0.08)`,
    borderRadius: '16px 16px 4px 16px',
    padding: '12px 16px',
  },
  userMsgHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  userLabel: {
    fontSize: '0.68rem',
    fontWeight: 700,
    color: '#60a5fa',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  assistantMsg: {
    display: 'flex',
    justifyContent: 'flex-start',
    marginBottom: 24,
    animation: 'fadeIn 0.18s ease-out',
  },
  assistantMsgInner: {
    maxWidth: '82%',
  },
  assistantMsgHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  aiAvatar: {
    width: 24,
    height: 24,
    borderRadius: 6,
    background: `linear-gradient(135deg, ${color.accent}, #2563eb)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.6rem',
    fontWeight: 700,
    color: '#fff',
    flexShrink: 0,
  },
  assistantLabel: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: color.accentLight,
  },
  generatingBadge: {
    fontSize: '0.65rem',
    color: color.textMuted,
    background: color.surface,
    border: `1px solid ${color.border}`,
    borderRadius: 10,
    padding: '1px 7px',
    marginLeft: 4,
  },
  msgText: {
    fontSize: '0.9rem',
    lineHeight: 1.7,
    color: color.text,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
  },
  thinkingText: {
    color: color.textMuted,
    fontStyle: 'italic',
  },
  streamCursor: {
    display: 'inline-block',
    marginLeft: 1,
    color: color.accentLight,
    animation: 'blink 0.9s step-start infinite',
  },

  // Error banner
  errorBanner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '12px 16px',
    background: color.errorBg,
    border: `1px solid rgba(248, 113, 113, 0.25)`,
    borderRadius: 10,
    fontSize: '0.83rem',
    color: color.error,
    marginBottom: 16,
  },
  errorIcon: {
    flexShrink: 0,
    marginTop: 1,
  },

  // ── Composer ──────────────────────────────────────────────────────────────
  composerWrap: {
    padding: '12px 24px 16px',
    borderTop: `1px solid ${color.border}`,
    flexShrink: 0,
  },
  composer: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 10,
    background: color.surface,
    border: `1px solid ${color.border}`,
    borderRadius: 12,
    padding: '10px 10px 10px 16px',
    transition: 'border-color 0.15s',
  },
  composerTextarea: {
    flex: 1,
    background: 'none',
    border: 'none',
    outline: 'none',
    color: color.text,
    fontSize: '0.9rem',
    lineHeight: 1.55,
    resize: 'none',
    fontFamily: 'inherit',
    minHeight: 22,
    maxHeight: 160,
    overflowY: 'auto',
    padding: 0,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 9,
    background: `linear-gradient(135deg, ${color.accent}, #2563eb)`,
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'opacity 0.15s',
  },
  sendBtnDisabled: {
    opacity: 0.3,
    cursor: 'not-allowed',
  },
  sendBtnArrow: {
    color: '#fff',
    fontSize: '1rem',
    lineHeight: 1,
    fontWeight: 700,
  },
  sendBtnSpinner: {
    color: '#fff',
    fontSize: '0.9rem',
    lineHeight: 1,
  },
  composerHint: {
    fontSize: '0.68rem',
    color: color.textMuted,
    textAlign: 'center',
    marginTop: 7,
  },

  // ── Pin button ────────────────────────────────────────────────────────────
  pinBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '0.72rem',
    color: color.textMuted,
    padding: '1px 3px',
    lineHeight: 1,
    opacity: 0.45,
    transition: 'opacity 0.15s, color 0.15s',
    marginLeft: 4,
  },
  pinBtnSaved: {
    color: color.success,
    opacity: 1,
  },
}
