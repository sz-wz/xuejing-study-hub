const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeAppBehavior } = require('./app-preferences.cjs')

test('background residency is opt-in and only accepts a strict boolean', () => {
  assert.deepEqual(normalizeAppBehavior(undefined), { keepRunningInTray: false })
  assert.deepEqual(normalizeAppBehavior({ keepRunningInTray: 'true' }), { keepRunningInTray: false })
  assert.deepEqual(normalizeAppBehavior({ keepRunningInTray: true }), { keepRunningInTray: true })
})
