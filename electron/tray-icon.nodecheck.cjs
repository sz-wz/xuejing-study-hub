const test = require('node:test')
const assert = require('node:assert/strict')
const { createTrayIconPng } = require('./tray-icon.cjs')

test('tray icon is a non-empty PNG instead of a transparent SVG slot', () => {
  const png = createTrayIconPng()
  assert.ok(png.length > 500)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
})
