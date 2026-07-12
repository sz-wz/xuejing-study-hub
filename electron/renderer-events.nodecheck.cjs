const assert = require('node:assert/strict')
const test = require('node:test')
const { sendToRenderer } = require('./renderer-events.cjs')

test('渲染窗口销毁后，后台进度事件不会抛出主进程异常', () => {
  const destroyedWindow = { isDestroyed: () => true, webContents: { send: () => { throw new Error('should not send') } } }
  const destroyedContents = { isDestroyed: () => false, webContents: { isDestroyed: () => true, send: () => { throw new Error('should not send') } } }

  assert.equal(sendToRenderer(destroyedWindow, 'knowledge:progress', {}), false)
  assert.equal(sendToRenderer(destroyedContents, 'knowledge:progress', {}), false)
})

test('存活窗口会正常接收后台进度事件', () => {
  const received = []
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, payload) => received.push({ channel, payload }) } }

  assert.equal(sendToRenderer(window, 'knowledge:progress', { completed: 1 }), true)
  assert.deepEqual(received, [{ channel: 'knowledge:progress', payload: { completed: 1 } }])
})
