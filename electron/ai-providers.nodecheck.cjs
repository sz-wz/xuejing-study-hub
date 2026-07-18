const assert = require('node:assert/strict')
const test = require('node:test')
const { detectProviderCapabilities, inferProvider, listProviderModels, normalizeProvider, refinementModeForConfig } = require('./ai-providers.cjs')

test('常用官方 API 地址会自动识别供应商', () => {
  assert.equal(inferProvider('https://api.openai.com/v1'), 'openai')
  assert.equal(inferProvider('https://api.deepseek.com'), 'deepseek')
  assert.equal(inferProvider('https://generativelanguage.googleapis.com/v1beta/openai/'), 'gemini')
  assert.equal(normalizeProvider('', 'https://gateway.example/v1'), 'custom')
  assert.equal(normalizeProvider('openai', 'https://api.deepseek.com'), 'deepseek')
})

test('OpenAI 兼容模型列表会被规范化和排序', async () => {
  const calls = []
  const result = await listProviderModels({
    config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'secret' },
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization })
      return { ok: true, json: async () => ({ object: 'list', data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] }) }
    },
  })
  assert.deepEqual(result.models, ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.deepEqual(calls, [{ url: 'https://api.deepseek.com/models', authorization: 'Bearer secret' }])
})

test('Gemini OpenAI 兼容模型列表不可用时回退官方原生 models 接口', async () => {
  const calls = []
  const result = await listProviderModels({
    config: { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'gemini-key' },
    fetchImpl: async (url, options) => {
      calls.push({ url, key: options.headers['x-goog-api-key'] })
      if (url.endsWith('/openai/models')) return { ok: false, status: 404, text: async () => 'not found' }
      return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-pro' }, { name: 'models/gemini-flash' }] }) }
    },
  })
  assert.deepEqual(result.models, ['gemini-flash', 'gemini-pro'])
  assert.equal(result.source, 'gemini-native')
  assert.deepEqual(calls[1], { url: 'https://generativelanguage.googleapis.com/v1beta/models', key: 'gemini-key' })
})

test('DeepSeek 和 Gemini 不尝试不存在的 OpenAI 文件端点', async () => {
  let calls = 0
  const deepseek = await detectProviderCapabilities({ config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'secret' }, fetchImpl: async () => { calls += 1 } })
  const gemini = await detectProviderCapabilities({ config: { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'secret' }, fetchImpl: async () => { calls += 1 } })
  assert.equal(calls, 0)
  assert.equal(deepseek.refinementMode, 'structured-pages')
  assert.equal(gemini.refinementMode, 'structured-pages')
})

test('自定义 API 只有同时存在 files 和 responses 才使用原件直传', async () => {
  const native = await detectProviderCapabilities({
    config: { provider: 'custom', baseUrl: 'https://gateway.test/v1', apiKey: 'secret' },
    fetchImpl: async (url) => ({ status: url.endsWith('/files') ? 400 : 422 }),
  })
  assert.equal(native.refinementMode, 'original-file')
  const chatOnly = await detectProviderCapabilities({
    config: { provider: 'custom', baseUrl: 'https://gateway.test/v1', apiKey: 'secret' },
    fetchImpl: async (url) => ({ status: url.endsWith('/files') ? 404 : 400 }),
  })
  assert.equal(chatOnly.refinementMode, 'structured-pages')
  assert.equal(refinementModeForConfig({ provider: 'custom', capabilities: chatOnly }), 'structured-pages')
})
