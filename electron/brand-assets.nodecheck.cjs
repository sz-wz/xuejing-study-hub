const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const assetsDir = path.join(__dirname, 'assets')

test('Windows icon contains all required PNG-backed ICO sizes', () => {
  const ico = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico'))
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  const count = ico.readUInt16LE(4)
  assert.equal(count, 9)
  const sizes = []
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16
    sizes.push(ico[entry] || 256)
    const bytes = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    assert.deepEqual([...ico.subarray(offset, offset + 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.ok(bytes > 100)
  }
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256])
})

test('packaged app and tray icons are generated project assets', () => {
  for (const filename of ['app-icon.png', 'tray-icon.png']) {
    const png = fs.readFileSync(path.join(__dirname, 'assets', filename))
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.ok(png.length > 500)
  }
  assert.deepEqual(fs.readFileSync(path.join(assetsDir, 'tray-icon.png')), fs.readFileSync(path.join(assetsDir, 'app-icon.png')), '托盘图标必须使用与应用一致的 image-1 品牌图标')
  assert.ok(fs.existsSync(path.join(root, 'src', 'assets', 'app-icon.png')), '渲染进程缺少统一应用图标')
})
