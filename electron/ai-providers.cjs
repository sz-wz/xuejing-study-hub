const PROVIDERS = Object.freeze([
  { id: 'openai', label: 'OpenAI / GPT', baseUrl: 'https://api.openai.com/v1', description: '支持 Responses 与文件输入时直接分析原件' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', description: '使用 Chat Completions，本地分页后精炼' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', description: '使用 OpenAI 兼容接口，本地分页后精炼' },
  { id: 'custom', label: '其他兼容 API', baseUrl: '', description: '自动探测模型、文件与 Responses 能力' },
])

const PROVIDER_IDS = new Set(PROVIDERS.map((provider) => provider.id))

function cleanBaseUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
}

function inferProvider(baseUrl) {
  try {
    const host = new URL(cleanBaseUrl(baseUrl)).hostname.toLocaleLowerCase()
    if (host === 'api.openai.com' || host.endsWith('.openai.com')) return 'openai'
    if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek'
    if (host === 'generativelanguage.googleapis.com') return 'gemini'
  } catch { /* 无效地址交给配置校验显示。 */ }
  return 'custom'
}

function normalizeProvider(provider, baseUrl) {
  const inferred = inferProvider(baseUrl)
  if (inferred !== 'custom') return inferred
  return PROVIDER_IDS.has(provider) ? provider : 'custom'
}

function providerPresets() {
  return PROVIDERS.map((provider) => ({ ...provider }))
}

function authHeaders(config) {
  return { Authorization: `Bearer ${config.apiKey}` }
}

async function responseDetails(response) {
  try { return (await response.text()).replace(/\s+/g, ' ').slice(0, 320) } catch { return '' }
}

function normalizeModels(payload) {
  const source = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  return [...new Set(source.map((model) => String(model?.id ?? model?.name ?? '').replace(/^models\//, '').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
}

async function listProviderModels({ config, fetchImpl = fetch }) {
  const baseUrl = cleanBaseUrl(config?.baseUrl)
  const provider = normalizeProvider(config?.provider, baseUrl)
  if (!baseUrl || !config?.apiKey) throw new Error('请先填写 API 地址和密钥')
  let response
  try {
    response = await fetchImpl(`${baseUrl}/models`, { headers: authHeaders(config) })
  } catch (error) {
    throw new Error(`无法获取模型列表：${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.ok) {
    const models = normalizeModels(await response.json())
    if (models.length) return { provider, models, source: 'openai-compatible' }
  }
  const firstError = await responseDetails(response)
  if (provider === 'gemini') {
    const native = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': config.apiKey } })
    if (native.ok) {
      const models = normalizeModels(await native.json())
      if (models.length) return { provider, models, source: 'gemini-native' }
    }
    const details = await responseDetails(native)
    throw new Error(`Gemini 模型列表读取失败（HTTP ${native.status}）${details ? `：${details}` : ''}`)
  }
  throw new Error(`模型列表读取失败（HTTP ${response.status}）${firstError ? `：${firstError}` : ''}`)
}

function endpointAvailable(status) {
  return ![404, 405, 501].includes(Number(status))
}

async function probeOriginalEndpoints({ config, fetchImpl = fetch }) {
  const baseUrl = cleanBaseUrl(config.baseUrl)
  const form = new FormData()
  form.append('purpose', 'user_data')
  let filesStatus = 0
  let responsesStatus = 0
  try {
    const files = await fetchImpl(`${baseUrl}/files`, { method: 'POST', headers: authHeaders(config), body: form })
    filesStatus = files.status
  } catch { filesStatus = 0 }
  try {
    const responses = await fetchImpl(`${baseUrl}/responses`, { method: 'POST', headers: { ...authHeaders(config), 'Content-Type': 'application/json' }, body: '{}' })
    responsesStatus = responses.status
  } catch { responsesStatus = 0 }
  return {
    files: filesStatus > 0 && endpointAvailable(filesStatus),
    responses: responsesStatus > 0 && endpointAvailable(responsesStatus),
    filesStatus,
    responsesStatus,
  }
}

async function detectProviderCapabilities({ config, fetchImpl = fetch, latencyMs = 0 }) {
  const baseUrl = cleanBaseUrl(config?.baseUrl)
  const provider = normalizeProvider(config?.provider, baseUrl)
  let original = { files: false, responses: false, filesStatus: 0, responsesStatus: 0 }
  if (provider === 'openai' || provider === 'custom') original = await probeOriginalEndpoints({ config: { ...config, baseUrl }, fetchImpl })
  const nativeFileInput = original.files && original.responses
  return {
    provider,
    chat: true,
    files: original.files,
    responses: original.responses,
    refinementMode: nativeFileInput ? 'original-file' : 'structured-pages',
    detectedAt: new Date().toISOString(),
    latencyMs,
  }
}

function normalizeCapabilities(value, provider, baseUrl) {
  if (!value || typeof value !== 'object') return undefined
  const resolvedProvider = normalizeProvider(provider, baseUrl)
  return {
    provider: resolvedProvider,
    chat: value.chat === true,
    files: value.files === true,
    responses: value.responses === true,
    refinementMode: value.files === true && value.responses === true ? 'original-file' : 'structured-pages',
    detectedAt: typeof value.detectedAt === 'string' ? value.detectedAt : '',
    latencyMs: Number(value.latencyMs) || 0,
  }
}

function refinementModeForConfig(config) {
  const provider = normalizeProvider(config?.provider, config?.baseUrl)
  if (provider === 'deepseek' || provider === 'gemini') return 'structured-pages'
  if (provider === 'openai') return config?.capabilities?.refinementMode === 'structured-pages' ? 'structured-pages' : 'original-file'
  return config?.capabilities?.refinementMode === 'original-file' ? 'original-file' : 'structured-pages'
}

module.exports = { detectProviderCapabilities, inferProvider, listProviderModels, normalizeCapabilities, normalizeProvider, providerPresets, refinementModeForConfig }
