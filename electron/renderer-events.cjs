function sendToRenderer(window, channel, payload) {
  try {
    if (!window || window.isDestroyed?.()) return false
    const contents = window.webContents
    if (!contents || contents.isDestroyed?.() || typeof contents.send !== 'function') return false
    contents.send(channel, payload)
    return true
  } catch {
    return false
  }
}

module.exports = { sendToRenderer }
