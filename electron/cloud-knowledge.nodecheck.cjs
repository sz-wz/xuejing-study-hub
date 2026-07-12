const assert = require('node:assert/strict')
const test = require('node:test')
const { chatWithCloud, refineKnowledgeWithCloud, testCloudConnection } = require('./cloud-knowledge.cjs')

test('使用 OpenAI 兼容接口精炼单份资料，并规范化返回知识点', async () => {
  let request
  const result = await refineKnowledgeWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    document: {
      title: 'fsm.pdf',
      courseName: 'Low-power IoT',
      outline: ['Finite state machine programming'],
      text: 'Finite state machines use states, transitions, and event handlers.',
    },
    fetchImpl: async (url, options) => {
      request = { url, options }
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '{"summary":"Finite state machine basics.","concepts":[{"title":"Finite state machine","evidence":"states and transitions"},{"title":"Event handlers","evidence":"event handlers"},{"title":"Finite state machine","evidence":"duplicate"}]}',
            },
          }],
        }),
      }
    },
  })

  assert.equal(request.url, 'https://example.test/v1/chat/completions')
  assert.equal(request.options.headers.Authorization, 'Bearer secret')
  assert.equal(JSON.parse(request.options.body).model, 'study-model')
  assert.equal(result.summary, 'Finite state machine basics.')
  assert.deepEqual(result.concepts, [
    { title: 'Finite state machine', evidence: 'states and transitions' },
    { title: 'Event handlers', evidence: 'event handlers' },
  ])
})

test('使用最小聊天请求测试 OpenAI 兼容 API 连通性', async () => {
  let request
  const result = await testCloudConnection({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }
    },
  })

  assert.equal(request.url, 'https://example.test/v1/chat/completions')
  assert.equal(JSON.parse(request.options.body).messages[0].content, 'Reply with exactly: OK')
  assert.equal(result.model, 'study-model')
  assert.ok(result.latencyMs >= 0)
})

test('复习会话只将当前选择的资料文本和最近对话发送给兼容 AI', async () => {
  let request
  const result = await chatWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    context: '离散时间卷积由输入序列和系统冲激响应计算。',
    messages: [{ role: 'user', content: '请解释这一页的卷积含义。' }],
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, json: async () => ({ model: 'study-model', choices: [{ message: { content: '卷积描述系统对输入的累积响应。' } }] }) }
    },
  })

  const body = JSON.parse(request.options.body)
  assert.equal(request.url, 'https://example.test/v1/chat/completions')
  assert.ok(body.messages.some((message) => message.content.includes('离散时间卷积')))
  assert.equal(body.messages.at(-1).content, '请解释这一页的卷积含义。')
  assert.equal(result.content, '卷积描述系统对输入的累积响应。')
})
