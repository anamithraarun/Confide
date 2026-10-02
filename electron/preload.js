/**
 * preload.js — Secure IPC bridge
 *
 * Runs in a privileged context with access to both Node.js and the renderer.
 * Uses contextBridge to expose a safe, named API (window.confide) to React.
 *
 * Rules:
 *  - Only explicitly listed channels are accessible from the renderer.
 *  - The renderer never receives a reference to ipcRenderer directly.
 *  - All exposed functions are typed and named — no wildcard channels.
 */

const { contextBridge, ipcRenderer } = require('electron')

// ─────────────────────────────────────────────────────────────────────────────
// Allowlists — keep these in sync with ipcMain handlers in main.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Channels the renderer may invoke (request → response).
 * Maps to ipcMain.handle() registrations in main.js.
 */
const INVOKE_CHANNELS = [
  'ping',
  // Ollama
  'ollama:chat',
  // Conversations & messages
  'conversation:create',
  'conversation:list',
  'conversation:messages',
  'conversation:delete',
]

/**
 * Channels the renderer may listen to (main → renderer push events).
 * Maps to win.webContents.send() calls in main.js.
 */
const LISTEN_CHANNELS = [
  // Future: 'chat:token', 'chat:done', 'system:status', etc.
]

// ─────────────────────────────────────────────────────────────────────────────
// Bridge API exposed as window.confide
// ─────────────────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('confide', {
  /**
   * invoke(channel, ...args) → Promise<any>
   * Sends a request to the main process and awaits a response.
   * Only channels listed in INVOKE_CHANNELS are allowed.
   */
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`[confide] Blocked IPC channel: "${channel}"`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  /**
   * on(channel, callback) → unsubscribe function
   * Subscribes to push events from the main process.
   * Only channels listed in LISTEN_CHANNELS are allowed.
   * Returns a cleanup function to call on component unmount.
   */
  on: (channel, callback) => {
    if (!LISTEN_CHANNELS.includes(channel)) {
      console.warn(`[confide] Blocked listener channel: "${channel}"`)
      return () => {}
    }
    const handler = (_event, ...args) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
})
