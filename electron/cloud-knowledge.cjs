const fsp = require('fs/promises')
const path = require('path')
const { detectProviderCapabilities, normalizeCapabilities, normalizeProvider, refinementModeForConfig } = require('./ai-providers.cjs')

const MAX_SOURCE_CHARS = 60_000
const MAX_CONCEPTS = 8
const MAX_LOCATION_BATCH_CHARS = 48_000
const MAX_LOCATION_BATCH_SEGMENTS = 24
const MAX_LOCATION_BATCHES = 24
const MAX_COURSE_NORMALIZATION_CONCEPTS = 240
const MIN_ALIAS_CONFIDENCE = 0.86
const MAX_PAGE_CARD_BATCH = 70
const MAX_PAGE_CARD_CHARS = 42_000
const MAX_ORIGINAL_FILE_BYTES = 120 * 1024 * 1024
const originalFileFallbacks = new Set()

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
  const provider = normalizeProvider(config?.provider, baseUrl)
  return { apiKey, model, baseUrl, provider, capabilities: normalizeCapabilities(config?.capabilities, provider, baseUrl) }
}

function extractJson(content) {
  const raw = String(content ?? '').trim().replace(/^[\x60]{3}(?:json)?\s*/i, '').replace(/\s*[\x60]{3}$/, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('云端模型没有返回可读取的 JSON 结果')
  return JSON.parse(raw.slice(start, end + 1))
}

function originalLocationKind(document) {
  const segmentKind = (Array.isArray(document?.segments) ? document.segments : []).find((segment) => ['pdf-page', 'pptx-slide', 'docx-section'].includes(segment?.kind))?.kind
  if (segmentKind) return segmentKind
  const extension = path.extname(String(document?.localPath ?? document?.title ?? '')).toLocaleLowerCase()
  return ['.ppt', '.pptx', '.pps', '.ppsx'].includes(extension) ? 'pptx-slide' : extension === '.pdf' ? 'pdf-page' : 'docx-section'
}

function originalMimeType(filename) {
  const extension = path.extname(filename).toLocaleLowerCase()
  return extension === '.pdf' ? 'application/pdf'
    : extension === '.pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : extension === '.ppt' ? 'application/vnd.ms-powerpoint'
        : extension === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : extension === '.doc' ? 'application/msword'
            : extension === '.odt' ? 'application/vnd.oasis.opendocument.text'
              : extension === '.odp' ? 'application/vnd.oasis.opendocument.presentation'
                : 'application/octet-stream'
}

function responseOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text
  for (const output of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if (typeof content?.text === 'string') return content.text
      if (typeof content?.output_text === 'string') return content.output_text
    }
  }
  return ''
}

async function cloudError(response, prefix, code) {
  const details = (await response.text()).replace(/\s+/g, ' ').slice(0, 360)
  const error = new Error(`${prefix}（HTTP ${response.status}）${details ? '：' + details : ''}`)
  if (code) error.code = code
  error.status = response.status
  throw error
}

function fileInputUnsupportedStatus(status) {
  return [400, 404, 405, 415, 422, 501].includes(Number(status))
}

function normalizeOriginalAnalysis(parsed, document, settings, bytes) {
  const kind = originalLocationKind(document)
  const pages = Math.max(0, Array.isArray(document?.segments) ? document.segments.filter((segment) => segment?.kind === kind).length : 0)
  const concepts = []
  const seen = new Set()
  for (const item of Array.isArray(parsed?.concepts) ? parsed.concepts : []) {
    const title = cleanCloudText(item?.title, 96)
    const evidence = cleanCloudText(item?.evidence, 280)
    const key = title.toLocaleLowerCase()
    if (title.length < 3 || seen.has(key)) continue
    seen.add(key)
    const locations = []
    const locationCandidates = []
    for (const range of Array.isArray(item?.ranges) ? item.ranges : []) {
      const start = Number(range?.start)
      const end = Number(range?.end ?? start)
      const confidence = Number(range?.confidence)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || (pages && end > pages)) continue
      const stored = {
        materialId: document.materialId,
        kind,
        start,
        end,
        confidence: Number(Math.max(0, Math.min(1, confidence || 0.6)).toFixed(2)),
        evidence: cleanCloudText(range?.reason || evidence, 280),
        method: 'ai-original-file',
      }
      if (stored.confidence >= 0.8) locations.push(stored)
      else if (stored.confidence >= 0.55) locationCandidates.push({ ...stored, candidate: true })
    }
    concepts.push({ title, evidence, aliases: (Array.isArray(item?.aliases) ? item.aliases : []).map((alias) => cleanCloudText(alias, 80)).filter(Boolean).slice(0, 6), locations, locationCandidates })
    if (concepts.length >= MAX_CONCEPTS) break
  }
  if (!concepts.length) throw new Error('云端模型未从原件中提取到可用知识点')
  const reportedAnalyzedPages = Number(parsed?.analyzedPages)
  const reportedTotalPages = Number(parsed?.totalPages)
  const totalPages = pages || (Number.isInteger(reportedTotalPages) && reportedTotalPages > 0 ? reportedTotalPages : 0)
  const analyzedPages = Number.isInteger(reportedAnalyzedPages) && reportedAnalyzedPages >= 0
    ? Math.min(totalPages || reportedAnalyzedPages, reportedAnalyzedPages)
    : totalPages
  return {
    summary: cleanCloudText(parsed?.summary, 180),
    concepts,
    model: settings.model,
    mode: 'original',
    analysisMethod: 'original-file',
    originalFile: { filename: path.basename(document.localPath), bytes, uploadedAt: new Date().toISOString() },
    coverage: {
      covered: analyzedPages,
      total: totalPages,
      percent: totalPages ? Math.min(100, Math.round(analyzedPages / totalPages * 100)) : 100,
      omittedRanges: [],
    },
    locationBatches: 0,
  }
}

function cleanCloudText(value, limit) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
}

function originalAnalysisPrompt(document) {
  const kind = originalLocationKind(document)
  const total = (Array.isArray(document?.segments) ? document.segments : []).filter((segment) => segment?.kind === kind).length
  const unit = kind === 'pptx-slide' ? '幻灯片' : kind === 'pdf-page' ? 'PDF物理页' : '文档章节'
  return [
    '你是大学本科课程资料分析助手。请完整分析随请求附带的整份原始课件，不得只看开头或目录。',
    '提取3到8个最值得复习的核心知识点。知识点应是概念、定理、方法、模型或技能，不要输出课程名、教师、邮箱、作业名称或泛化学习建议。',
    `每个知识点必须返回它在原件中的${unit}范围。start/end 使用从1开始的真实编号；允许一个知识点有多个不连续范围。`,
    '范围应覆盖定义、推导和紧邻解释，不要仅定位到出现公式的一页。confidence为0到1；不确定时降低置信度，不得编造页码。',
    `本地检测到的总${unit}数：${total || '未知'}。请返回 analyzedPages 和 totalPages，只有确实检查过的页面才能计入 analyzedPages。`,
    '只返回JSON，不要Markdown：{"summary":"资料摘要","analyzedPages":1,"totalPages":1,"concepts":[{"title":"知识点","aliases":["英文或别名"],"evidence":"原件中的简短证据","ranges":[{"start":1,"end":2,"confidence":0.92,"reason":"这一范围为何相关"}]}]}',
    `课程：${String(document?.courseName ?? '')}`,
    `原始文件名：${String(document?.title ?? path.basename(document?.localPath ?? ''))}`,
  ].join('\n')
}

async function refineOriginalFileWithCloud({ config, document, fetchImpl = fetch, onProgress, signal }) {
  const settings = normalizeConfig(config)
  if (!document?.localPath || !path.isAbsolute(document.localPath)) throw new Error('AI 原件精炼需要有效的本地文件路径')
  const stat = await fsp.stat(document.localPath)
  if (!stat.isFile()) throw new Error('AI 原件精炼找不到对应文件')
  if (stat.size > MAX_ORIGINAL_FILE_BYTES) throw new Error(`原件超过 ${Math.round(MAX_ORIGINAL_FILE_BYTES / 1024 / 1024)} MB，当前不支持整份上传`)
  onProgress?.({ completed: 0, total: 4, title: '正在读取课程资料原件…' })
  const buffer = await fsp.readFile(document.localPath)
  const filename = path.basename(document.localPath)
  const form = new FormData()
  form.append('purpose', 'user_data')
  form.append('file', new Blob([buffer], { type: originalMimeType(filename) }), filename)
  onProgress?.({ completed: 1, total: 4, title: '正在上传整份课程资料原件…' })
  let upload
  try {
    upload = await fetchImpl(settings.baseUrl + '/files', { method: 'POST', headers: { Authorization: 'Bearer ' + settings.apiKey }, body: form, signal })
  } catch (error) {
    if (error?.name === 'AbortError' && signal?.aborted) throw Object.assign(new Error('AI 精炼已由用户停止'), { code: 'AI_REFINEMENT_ABORTED' })
    throw error
  }
  if (!upload.ok) await cloudError(upload, '当前 API 不支持课程原件上传', fileInputUnsupportedStatus(upload.status) ? 'AI_FILE_INPUT_UNSUPPORTED' : '')
  const uploaded = await upload.json()
  const fileId = String(uploaded?.id ?? '')
  if (!fileId) throw new Error('文件上传接口未返回可用的 file id')
  try {
    onProgress?.({ completed: 2, total: 4, title: 'AI 正在完整分析原件与页码范围…' })
    const response = await fetchImpl(settings.baseUrl + '/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.1,
        input: [{ role: 'user', content: [{ type: 'input_text', text: originalAnalysisPrompt(document) }, { type: 'input_file', file_id: fileId }] }],
      }),
      signal,
    })
    if (!response.ok) await cloudError(response, '当前模型无法分析这类原始文件', fileInputUnsupportedStatus(response.status) ? 'AI_FILE_INPUT_UNSUPPORTED' : '')
    const payload = await response.json()
    const parsed = extractJson(responseOutputText(payload))
    onProgress?.({ completed: 3, total: 4, title: '正在校验知识点和原件页码…' })
    const result = normalizeOriginalAnalysis(parsed, document, settings, buffer.length)
    onProgress?.({ completed: 4, total: 4, title: '' })
    return result
  } catch (error) {
    if (error?.name === 'AbortError' && signal?.aborted) throw Object.assign(new Error('AI 精炼已由用户停止'), { code: 'AI_REFINEMENT_ABORTED' })
    throw error
  } finally {
    await fetchImpl(settings.baseUrl + '/files/' + encodeURIComponent(fileId), { method: 'DELETE', headers: { Authorization: 'Bearer ' + settings.apiKey } }).catch(() => {})
  }
}

function normalizeConcepts(concepts, options = {}) {
  const seen = new Set()
  const result = []
  for (const item of Array.isArray(concepts) ? concepts : []) {
    const title = typeof item?.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : ''
    const evidence = typeof item?.evidence === 'string' ? item.evidence.replace(/\s+/g, ' ').trim().slice(0, 240) : ''
    const key = title.toLocaleLowerCase()
    if (title.length < 3 || title.length > 96 || seen.has(key)) continue
    seen.add(key)
    const normalized = { title, evidence }
    const start = Number(item?.start)
    const end = Number(item?.end ?? start)
    if (options.locationKind && Number.isInteger(start) && Number.isInteger(end) && start >= options.minStart && end <= options.maxEnd && end >= start) {
      normalized.locationHints = [{ kind: options.locationKind, start, end }]
    }
    result.push(normalized)
    if (result.length >= (options.limit ?? MAX_CONCEPTS)) break
  }
  if (!result.length && !options.allowEmpty) throw new Error('云端模型未提取到可用的知识点，请更换模型或检查资料文本')
  return result
}

function stratifiedTextSample(value, limit = MAX_SOURCE_CHARS) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  const partLength = Math.floor(limit / 3)
  const middleStart = Math.max(0, Math.floor(text.length / 2 - partLength / 2))
  return [
    `[资料开头]\n${text.slice(0, partLength)}`,
    `[资料中段]\n${text.slice(middleStart, middleStart + partLength)}`,
    `[资料结尾]\n${text.slice(Math.max(0, text.length - partLength))}`,
  ].join('\n\n')
}

function knowledgePrompt(document) {
  const text = stratifiedTextSample(document.text)
  return [
    '你是大学本科课程的学习助手。请仅依据下面的一份课程资料，提取 3 到 8 个最值得复习的核心知识点。',
    '不要输出课程名称、讲师、邮箱、页码、章节编号、作业、例题标题或泛化提示语。',
    '每个知识点必须是学生可复习的概念、方法、定理、模型或技能；evidence 必须尽量使用资料中的连续原文短句，应用会用它在本地定位具体页码或幻灯片。',
    '只返回 JSON，不要 Markdown，格式为：{"summary":"不超过80字的资料摘要","concepts":[{"title":"知识点","evidence":"资料中的短证据"}]}。',
    '课程：' + String(document.courseName ?? ''),
    '资料标题：' + String(document.title ?? ''),
    '本地候选主题：' + (Array.isArray(document.outline) ? document.outline.join('；') : ''),
    '资料文本：\n' + text,
  ].join('\n')
}

function buildLocationPlan(segments) {
  const source = (Array.isArray(segments) ? segments : []).filter((segment) => segment && typeof segment.text === 'string' && segment.text.trim() && ['pdf-page', 'pptx-slide'].includes(segment.kind))
  const batches = []
  let current = []
  let currentLength = 0
  for (const segment of source) {
    const text = segment.text.slice(0, MAX_LOCATION_BATCH_CHARS)
    if (current.length && (current.length >= MAX_LOCATION_BATCH_SEGMENTS || currentLength + text.length > MAX_LOCATION_BATCH_CHARS)) {
      batches.push(current)
      current = []
      currentLength = 0
      if (batches.length >= MAX_LOCATION_BATCHES) break
    }
    current.push({ ...segment, text })
    currentLength += text.length
  }
  if (current.length && batches.length < MAX_LOCATION_BATCHES) batches.push(current)
  const covered = batches.reduce((total, batch) => total + batch.length, 0)
  const omitted = source.slice(covered)
  const omittedRanges = []
  for (const segment of omitted) {
    const previous = omittedRanges.at(-1)
    const end = segment.end ?? segment.start
    if (previous && previous.kind === segment.kind && segment.start <= previous.end + 1) previous.end = Math.max(previous.end, end)
    else omittedRanges.push({ kind: segment.kind, start: segment.start, end })
  }
  return { batches, total: source.length, covered, omittedRanges }
}

function locationPrompt(document, batch, batchIndex, batchCount) {
  const label = batch[0]?.kind === 'pptx-slide' ? '幻灯片' : 'PDF 页'
  const contents = batch.map((segment) => `[${label} ${segment.start}${segment.end && segment.end !== segment.start ? '-' + segment.end : ''}]\n${segment.text}`).join('\n\n')
  return [
    '你是大学本科课程的学习助手。下面是一份课件中的一组连续页面。',
    `这是第 ${batchIndex + 1}/${batchCount} 组。请提取 1 到 4 个这组页面最值得复习的核心知识点。`,
    '不要输出课程名称、讲师、邮箱、页眉页脚、作业标题或泛化提示语。',
    'evidence 必须使用对应页面中的连续原文短句；start 和 end 必须使用下方真实页码，不能猜测或越界。',
    '只返回 JSON，不要 Markdown，格式为：{"summary":"本组不超过50字摘要","concepts":[{"title":"知识点","evidence":"页面原文","start":1,"end":2}]}。',
    '课程：' + String(document.courseName ?? ''),
    '资料标题：' + String(document.title ?? ''),
    contents,
  ].join('\n')
}

async function requestKnowledgeJson(settings, prompt, fetchImpl, { signal } = {}) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 120_000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
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
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError' && signal?.aborted) throw Object.assign(new Error('AI 精炼已由用户停止'), { code: 'AI_REFINEMENT_ABORTED' })
    if (error?.name === 'AbortError' && timedOut) throw new Error('云端精炼超时，请稍后重试或缩短资料内容')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
  if (!response.ok) {
    const details = (await response.text()).replace(/\s+/g, ' ').slice(0, 300)
    throw new Error('云端 API 请求失败（HTTP ' + response.status + '）：' + details)
  }
  const payload = await response.json()
  return extractJson(payload?.choices?.[0]?.message?.content)
}

function mergeBatchConcepts(batches) {
  const result = []
  const byTitle = new Map()
  let offset = 0
  while (result.length < MAX_CONCEPTS && batches.some((batch) => offset < batch.length)) {
    for (const batch of batches) {
      const concept = batch[offset]
      if (!concept) continue
      const key = concept.title.toLocaleLowerCase()
      const existing = byTitle.get(key)
      if (existing) {
        for (const hint of concept.locationHints ?? []) {
          if (!existing.locationHints?.some((current) => current.kind === hint.kind && current.start === hint.start && current.end === hint.end)) existing.locationHints = [...(existing.locationHints ?? []), hint]
        }
        continue
      }
      const stored = { ...concept, locationHints: [...(concept.locationHints ?? [])] }
      result.push(stored)
      byTitle.set(key, stored)
      if (result.length >= MAX_CONCEPTS) break
    }
    offset += 1
  }
  return result
}

async function refineKnowledgeWithCloud({ config, document, fetchImpl = fetch, onProgress, mode = 'deep', checkpoint, onCheckpoint, signal }) {
  const settings = normalizeConfig(config)
  if (mode === 'quick') {
    const parsed = await requestKnowledgeJson(settings, knowledgePrompt(document), fetchImpl, { signal })
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
      concepts: normalizeConcepts(parsed.concepts),
      model: settings.model,
      mode: 'quick',
      locationBatches: 0,
    }
  }
  const locationPlan = buildLocationPlan(document.segments)
  const locationBatches = locationPlan.batches
  if (locationBatches.length) {
    const checkpointResults = Array.isArray(checkpoint?.results) ? checkpoint.results : []
    const nextBatch = Number.isInteger(checkpoint?.nextBatch) ? Math.max(0, Math.min(locationBatches.length, checkpoint.nextBatch)) : 0
    const results = checkpointResults.slice(0, nextBatch).map((result) => ({
      summary: typeof result?.summary === 'string' ? result.summary : '',
      concepts: Array.isArray(result?.concepts) ? result.concepts : [],
    }))
    for (let index = nextBatch; index < locationBatches.length; index += 1) {
      const batch = locationBatches[index]
      onProgress?.({ completed: index, total: locationBatches.length, title: `正在分析页面组 ${index + 1}/${locationBatches.length}…` })
      const parsed = await requestKnowledgeJson(settings, locationPrompt(document, batch, index, locationBatches.length), fetchImpl, { signal })
      results.push({
        summary: typeof parsed.summary === 'string' ? parsed.summary.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
        concepts: normalizeConcepts(parsed.concepts, { locationKind: batch[0].kind, minStart: Math.min(...batch.map((segment) => segment.start)), maxEnd: Math.max(...batch.map((segment) => segment.end ?? segment.start)), limit: 4, allowEmpty: true }),
      })
      await onCheckpoint?.({ nextBatch: index + 1, results })
    }
    const concepts = mergeBatchConcepts(results.map((result) => result.concepts))
    if (!concepts.length) throw new Error('云端模型未提取到可用的页级知识点，请更换模型或检查资料文本')
    onProgress?.({ completed: locationBatches.length, total: locationBatches.length, title: '正在合并并校验页级知识索引…' })
    return {
      summary: results.map((result) => result.summary).filter(Boolean).join('；').slice(0, 160), concepts, model: settings.model, mode: 'deep', locationBatches: locationBatches.length,
      coverage: { covered: locationPlan.covered, total: locationPlan.total, percent: locationPlan.total ? Math.round(locationPlan.covered / locationPlan.total * 100) : 0, omittedRanges: locationPlan.omittedRanges },
    }
  }
  const parsed = await requestKnowledgeJson(settings, knowledgePrompt(document), fetchImpl, { signal })
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    concepts: normalizeConcepts(parsed.concepts),
    model: settings.model,
    mode: 'deep',
    locationBatches: 0,
  }
}

async function refineStructuredDocumentWithCloud({ config, document, fetchImpl = fetch, onProgress, checkpoint, onCheckpoint, signal }) {
  const result = await refineKnowledgeWithCloud({ config, document, fetchImpl, onProgress, mode: 'deep', checkpoint, onCheckpoint, signal })
  return {
    ...result,
    mode: 'original',
    analysisMethod: 'structured-pages',
    inputStrategy: 'local-structured-pages',
  }
}

function originalFallbackKey(settings) {
  return `${settings.baseUrl}|${settings.model}`.toLocaleLowerCase()
}

async function refineDocumentWithCloud({ config, document, fetchImpl = fetch, onProgress, checkpoint, onCheckpoint, signal }) {
  const settings = normalizeConfig(config)
  const fallbackKey = originalFallbackKey(settings)
  const preferredMode = originalFileFallbacks.has(fallbackKey) ? 'structured-pages' : refinementModeForConfig(settings)
  if (preferredMode === 'original-file') {
    try {
      return await refineOriginalFileWithCloud({ config: settings, document, fetchImpl, onProgress, signal })
    } catch (error) {
      if (error?.code !== 'AI_FILE_INPUT_UNSUPPORTED') throw error
      originalFileFallbacks.add(fallbackKey)
      onProgress?.({ completed: 0, total: 1, title: '原件接口不可用，已自动切换为本地分页兼容精炼…' })
    }
  }
  return refineStructuredDocumentWithCloud({ config: settings, document, fetchImpl, onProgress, checkpoint, onCheckpoint, signal })
}

function normalizeAliasGroups(groups, concepts) {
  const knownTitles = new Map((Array.isArray(concepts) ? concepts : []).map((concept) => [String(concept?.title ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase(), String(concept?.title ?? '').replace(/\s+/g, ' ').trim()]).filter(([key]) => key))
  const claimed = new Set()
  const normalized = []
  const candidates = (Array.isArray(groups) ? groups : []).map((group) => ({
    canonical: typeof group?.canonical === 'string' ? group.canonical.replace(/\s+/g, ' ').trim().slice(0, 96) : '',
    aliases: Array.isArray(group?.aliases) ? group.aliases.map((alias) => String(alias).replace(/\s+/g, ' ').trim()).filter(Boolean) : [],
    confidence: Number(group?.confidence),
  })).filter((group) => group.canonical.length >= 3 && group.confidence >= MIN_ALIAS_CONFIDENCE).sort((left, right) => right.confidence - left.confidence)

  for (const group of candidates) {
    const sourceTitles = [...new Set([group.canonical, ...group.aliases].map((title) => knownTitles.get(title.toLocaleLowerCase())).filter(Boolean))]
    const available = sourceTitles.filter((title) => !claimed.has(title.toLocaleLowerCase()))
    if (available.length < 2) continue
    available.forEach((title) => claimed.add(title.toLocaleLowerCase()))
    normalized.push({ canonical: group.canonical, aliases: available, confidence: Number(group.confidence.toFixed(2)) })
  }
  return normalized
}

async function normalizeCourseConceptsWithCloud({ config, courses, fetchImpl = fetch, onProgress, signal }) {
  const settings = normalizeConfig(config)
  const source = (Array.isArray(courses) ? courses : []).filter((course) => course?.courseId && Array.isArray(course.concepts) && course.concepts.length > 1)
  const results = []
  for (let index = 0; index < source.length; index += 1) {
    const course = source[index]
    const concepts = course.concepts.slice(0, MAX_COURSE_NORMALIZATION_CONCEPTS).map((concept) => ({
      title: String(concept.title ?? '').slice(0, 96),
      summary: String(concept.summary ?? '').slice(0, 120),
      sourceIds: Array.isArray(concept.sourceIds) ? concept.sourceIds.slice(0, 12) : [],
      locations: Array.isArray(concept.locations) ? concept.locations.slice(0, 12).map((location) => ({ materialId: location.materialId, kind: location.kind, start: location.start, end: location.end })) : [],
    }))
    onProgress?.({ completed: index, total: source.length, title: `正在归并 ${course.courseName || course.courseId} 的同义知识点…` })
    const prompt = [
      '你负责整理一门大学课程的知识点标题。只合并明确表示同一概念、定理、方法或模型的标题；上下位概念、相关概念和仅仅共享单词的标题不得合并。',
      '不要补充新知识，不要根据常识猜测。canonical 可使用最清晰的标准名称；aliases 必须来自给定 title。',
      '只返回 JSON：{"groups":[{"canonical":"标准名称","aliases":["原始标题A","原始标题B"],"confidence":0.95}]}。不确定或置信度低于 0.86 时不要输出该组。',
      `课程：${course.courseName || course.courseId}`,
      `知识点元数据（不含课件全文）：${JSON.stringify(concepts)}`,
    ].join('\n')
    const parsed = await requestKnowledgeJson(settings, prompt, fetchImpl, { signal })
    results.push({ courseId: course.courseId, courseName: course.courseName ?? '', groups: normalizeAliasGroups(parsed.groups, concepts), model: settings.model })
  }
  onProgress?.({ completed: source.length, total: source.length, title: '' })
  return results
}

function pageCardBatches(cards) {
  const batches = []
  let current = []
  let characters = 0
  for (const card of Array.isArray(cards) ? cards : []) {
    const stored = {
      kind: card.kind,
      start: Number(card.start),
      end: Number(card.end ?? card.start),
      heading: String(card.heading ?? '').slice(0, 140),
      snippet: String(card.snippet ?? '').slice(0, 620),
    }
    const length = stored.heading.length + stored.snippet.length + 40
    if (current.length && (current.length >= MAX_PAGE_CARD_BATCH || characters + length > MAX_PAGE_CARD_CHARS)) {
      batches.push(current)
      current = []
      characters = 0
    }
    current.push(stored)
    characters += length
  }
  if (current.length) batches.push(current)
  return batches
}

function normalizePageMappings(mappings, concepts, batch) {
  const first = batch[0]
  const last = batch.at(-1)
  if (!first || !last) return []
  const result = []
  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    const conceptIndex = Number(mapping?.conceptIndex)
    if (!Number.isInteger(conceptIndex) || conceptIndex < 0 || conceptIndex >= concepts.length) continue
    const ranges = []
    for (const range of Array.isArray(mapping?.ranges) ? mapping.ranges : []) {
      const start = Number(range?.start)
      const end = Number(range?.end ?? start)
      const confidence = Number(range?.confidence)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < first.start || end > last.end || end < start) continue
      ranges.push({ kind: first.kind, start, end, confidence: Number(Math.max(0, Math.min(1, confidence || 0.6)).toFixed(2)), reason: String(range?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) })
    }
    if (ranges.length) result.push({ conceptIndex, ranges: ranges.slice(0, 4) })
  }
  return result
}

async function mapConceptPagesWithCloud({ config, document, concepts, cards, fetchImpl = fetch, onProgress, signal }) {
  const settings = normalizeConfig(config)
  const sourceConcepts = (Array.isArray(concepts) ? concepts : []).slice(0, MAX_CONCEPTS).map((concept, index) => ({ index, title: String(concept?.title ?? '').slice(0, 96), evidence: String(concept?.evidence ?? '').slice(0, 240) }))
  if (!sourceConcepts.length) return []
  const batches = pageCardBatches(cards)
  const collected = new Map(sourceConcepts.map((concept) => [concept.index, []]))
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    onProgress?.({ completed: index, total: batches.length, title: `正在映射页面卡片 ${index + 1}/${batches.length}…` })
    const prompt = [
      '你负责把已经确定的课程知识点映射到资料页面。知识点名称可能是中文，而页面标题可能是英文；请按语义、公式和章节连续性判断。',
      '只选择确实讲解该知识点的页面。定义、推导和直接应用可以组成连续范围；仅在目录中提到、只有相同单词或只是前后无关例题时不要选择。',
      '允许一个知识点对应多个不连续范围。confidence 使用 0 到 1；低于 0.55 的结果不要输出。',
      '只返回 JSON：{"mappings":[{"conceptIndex":0,"ranges":[{"start":12,"end":13,"confidence":0.93,"reason":"Linear Phase System"}]}]}。',
      `课程：${String(document?.courseName ?? '')}`,
      `资料：${String(document?.title ?? '')}`,
      `知识点：${JSON.stringify(sourceConcepts)}`,
      `页面卡片：${JSON.stringify(batch)}`,
    ].join('\n')
    const parsed = await requestKnowledgeJson(settings, prompt, fetchImpl, { signal })
    for (const mapping of normalizePageMappings(parsed.mappings, sourceConcepts, batch)) collected.get(mapping.conceptIndex).push(...mapping.ranges)
  }
  onProgress?.({ completed: batches.length, total: batches.length, title: '' })
  return sourceConcepts.map((concept) => ({ conceptIndex: concept.index, ranges: collected.get(concept.index) ?? [] }))
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
  const latencyMs = Date.now() - startedAt
  const capabilities = await detectProviderCapabilities({ config: settings, fetchImpl, latencyMs })
  return { model: settings.model, latencyMs, capabilities }
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

module.exports = { refineDocumentWithCloud, refineOriginalFileWithCloud, refineStructuredDocumentWithCloud, refineKnowledgeWithCloud, mapConceptPagesWithCloud, normalizeCourseConceptsWithCloud, testCloudConnection, chatWithCloud, normalizeConcepts, normalizeAliasGroups, normalizePageMappings, normalizeOriginalAnalysis, extractJson }
