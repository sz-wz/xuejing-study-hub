const MAX_SOURCE_CHARS = 60_000
const MAX_CONCEPTS = 8

function normalizeConfig(config) {
  const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
  const model = typeof config?.model === 'string' ? config.model.trim() : ''
  const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim().replace(/\/+$/, '') : ''
  if (!apiKey) throw new Error('请先在 AI 设置中保存云端 API 密钥')
  if (!model) throw new Error('请先填写云端模型名称')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('云端 API 地址无效')
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('云端 API 地址必须使用 HTTP(S)')
  return { apiKey, model, baseUrl }
}

function extractJson(content) {
  const raw = String(content ?? '').trim().replace(/^[\x60]{3}(?:json)?\s*/i, '').replace(/\s*[\x60]{3}$/, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('云端模型没有返回可读取的 JSON 结果')
  return JSON.parse(raw.slice(start, end + 1))
}

function normalizeConcepts(concepts) {
  const seen = new Set()
  const result = []
  for (const item of Array.isArray(concepts) ? concepts : []) {
    const title = typeof item?.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : ''
    const evidence = typeof item?.evidence === 'string' ? item.evidence.replace(/\s+/g, ' ').trim().slice(0, 240) : ''
    const key = title.toLocaleLowerCase()
    if (title.length < 3 || title.length > 96 || seen.has(key)) continue
    seen.add(key)
    result.push({ title, evidence })
    if (result.length >= MAX_CONCEPTS) break
  }
  if (!result.length) throw new Error('云端模型未提取到可用的知识点，请更换模型或检查资料文本')
  return result
}

function knowledgePrompt(document) {
  const text = String(document.text ?? '').slice(0, MAX_SOURCE_CHARS)
  return [
    '你是大学本科课程的学习助手。请仅依据下面的一份课程资料，提取 3 到 8 个最值得复习的核心知识点。',
    '不要输出课程名称、讲师、邮箱、页码、章节编号、作业、例题标题或泛化提示语。',
    '每个知识点必须是学生可复习的概念、方法、定理、模型或技能；evidence 必须是该资料中的短证据。',
    '只返回 JSON，不要 Markdown，格式为：{"summary":"不超过80字的资料摘要","concepts":[{"title":"知识点","evidence":"资料中的短证据"}]}。',
    '课程：' + String(document.courseName ?? ''),
    '资料标题：' + String(document.title ?? ''),
    '本地候选主题：' + (Array.isArray(document.outline) ? document.outline.join('；') : ''),
    '资料文本：\n' + text,
  ].join('\n')
}

async function refineKnowledgeWithCloud({ config, document, fetchImpl = fetch }) {
  const settings = normalizeConfig(config)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  let response
  try {
    response = await fetchImpl(settings.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: 'Return only valid JSON. Keep every claim grounded in the provided course material.' },
          { role: 'user', content: knowledgePrompt(document) },
        ],
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('云端精炼超时，请稍后重试或缩短资料内容')
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const details = (await response.text()).replace(/\s+/g, ' ').slice(0, 300)
    throw new Error('云端 API 请求失败（HTTP ' + response.status + '）：' + details)
  }
  const payload = await response.json()
  const parsed = extractJson(payload?.choices?.[0]?.message?.content)
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    concepts: normalizeConcepts(parsed.concepts),
    model: settings.model,
  }
}

async function testCloudConnection({ config, fetchImpl = fetch }) {
  const settings = normalizeConfig(config)
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let response
  try {
    response = await fetchImpl(settings.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('AI 连通性测试超时，请检查 API 地址、网络或模型名称')
    throw new Error('无法连接云端 API：' + (error instanceof Error ? error.message : String(error)))
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const details = (await response.text()).replace(/\s+/g, ' ').slice(0, 300)
    throw new Error('AI 连通性测试失败（HTTP ' + response.status + '）：' + details)
  }
  const payload = await response.json()
  if (typeof payload?.choices?.[0]?.message?.content !== 'string') throw new Error('AI 接口已响应，但返回格式不是 OpenAI 兼容的 chat/completions 格式')
  return { model: settings.model, latencyMs: Date.now() - startedAt }
}

async function chatWithCloud({ config, context, messages, fetchImpl = fetch }) {
  const source = String(context ?? '').trim().slice(0, MAX_SOURCE_CHARS)
  const history = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .slice(-12)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 8_000) }))
  const question = history.at(-1)
  if (!source) throw new Error('请先选择至少一份已解析资料，再向 AI 提问')
  if (!question || question.role !== 'user' || !question.content.trim()) throw new Error('请输入要询问的问题')
  const response = await fetchImpl(config.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.25,
      messages: [
        { role: 'system', content: '你是大学课程学习助手。仅基于用户提供的课程资料回答；不确定时明确说明。回答使用中文，优先解释概念、推导和学习步骤，可给出简短例题但不要编造资料中不存在的结论。' },
        { role: 'system', content: `当前选中的课程资料文本如下：\n${source}` },
        ...history,
      ],
    }),
  })
  if (!response.ok) {
    const details = (await response.text()).replace(/\s+/g, ' ').slice(0, 300)
    throw new Error(`AI 请求失败（HTTP ${response.status}）${details ? '：' + details : ''}`)
  }
  const payload = await response.json()
  const content = String(payload?.choices?.[0]?.message?.content ?? '').trim()
  if (!content) throw new Error('AI 没有返回可用回答，请稍后重试')
  return { content, model: payload?.model || config.model }
}

module.exports = { refineKnowledgeWithCloud, testCloudConnection, chatWithCloud, normalizeConcepts, extractJson }
