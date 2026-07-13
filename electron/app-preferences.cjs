function normalizeAppBehavior(value) {
  const source = value && typeof value === 'object' ? value : {}
  return { keepRunningInTray: source.keepRunningInTray === true }
}

module.exports = { normalizeAppBehavior }
