const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { chatWithCloud, mapConceptPagesWithCloud, normalizeCourseConceptsWithCloud, refineDocumentWithCloud, refineKnowledgeWithCloud, refineOriginalFileWithCloud, testCloudConnection } = require('./cloud-knowledge.cjs')

test('统一 AI 精炼上传整份原件并一次返回知识点和页码范围', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-original-refine-'))
  try {
    const filePath = path.join(sandbox, 'lecture.pdf')
    await fs.writeFile(filePath, Buffer.from('%PDF-1.7\noriginal-binary-course-file'))
    const requests = []
    const result = await refineOriginalFileWithCloud({
      config: { baseUrl: 'https://example.test/v1', model: 'file-model', apiKey: 'secret' },
      document: { materialId: 'lecture', title: 'lecture.pdf', localPath: filePath, courseName: 'Signals', text: 'THIS_LOCAL_TEXT_MUST_NOT_BE_SENT', segments: Array.from({ length: 6 }, (_, index) => ({ kind: 'pdf-page', start: index + 1, end: index + 1, text: `page ${index + 1}` })) },
      fetchImpl: async (url, options) => {
        requests.push({ url, options })
        if (url.endsWith('/files') && options.method === 'POST') {
          assert.equal(options.body.get('purpose'), 'user_data')
          assert.equal(options.body.get('file').name, 'lecture.pdf')
          return { ok: true, json: async () => ({ id: 'file-123' }) }
        }
        if (url.endsWith('/responses')) return { ok: true, json: async () => ({ output_text: JSON.stringify({ summary: '课程原件摘要', analyzedPages: 6, totalPages: 6, concepts: [{ title: '群延迟', aliases: ['Group Delay'], evidence: 'Group delay definition', ranges: [{ start: 2, end: 4, confidence: 0.93, reason: '定义、推导与例子' }, { start: 6, end: 6, confidence: 0.66, reason: '补充应用' }] }] }) }) }
        if (url.endsWith('/files/file-123') && options.method === 'DELETE') return { ok: true, json: async () => ({ deleted: true }) }
        throw new Error('unexpected request ' + url)
      },
    })
    const responseBody = JSON.parse(requests.find((request) => request.url.endsWith('/responses')).options.body)
    assert.equal(responseBody.input[0].content[1].file_id, 'file-123')
    assert.doesNotMatch(JSON.stringify(responseBody), /THIS_LOCAL_TEXT_MUST_NOT_BE_SENT/)
    assert.equal(requests.filter((request) => request.url.endsWith('/responses')).length, 1)
    assert.equal(result.mode, 'original')
    assert.deepEqual(result.concepts[0].locations.map((location) => [location.start, location.end]), [[2, 4]])
    assert.deepEqual(result.concepts[0].locationCandidates.map((location) => [location.start, location.end]), [[6, 6]])
    assert.equal(result.coverage.percent, 100)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('原件上传接口不兼容时明确报错且不降级发送提取文本', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-original-unsupported-'))
  try {
    const filePath = path.join(sandbox, 'lecture.pptx')
    await fs.writeFile(filePath, 'pptx bytes')
    const urls = []
    await assert.rejects(refineOriginalFileWithCloud({
      config: { baseUrl: 'https://example.test/v1', model: 'chat-only-model', apiKey: 'secret' },
      document: { materialId: 'lecture', title: 'lecture.pptx', localPath: filePath, courseName: 'Signals', text: 'do not send', segments: [] },
      fetchImpl: async (url) => { urls.push(url); return { ok: false, status: 404, text: async () => 'not found' } },
    }), /不支持课程原件上传/)
    assert.deepEqual(urls, ['https://example.test/v1/files'])
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('DeepSeek 自动使用本地分页兼容精炼而不请求 files', async () => {
  const urls = []
  const result = await refineDocumentWithCloud({
    config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.test', model: 'deepseek-model', apiKey: 'secret' },
    document: { materialId: 'lecture', title: 'lecture.pdf', localPath: 'D:\\lecture.pdf', courseName: 'Signals', text: 'convolution', segments: [{ kind: 'pdf-page', start: 1, end: 1, text: 'Convolution integral and LTI system response' }] },
    fetchImpl: async (url) => {
      urls.push(url)
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '卷积', concepts: [{ title: '卷积积分', evidence: 'Convolution integral', start: 1, end: 1 }] }) } }] }) }
    },
  })
  assert.deepEqual(urls, ['https://api.deepseek.test/chat/completions'])
  assert.equal(result.mode, 'original')
  assert.equal(result.analysisMethod, 'structured-pages')
  assert.deepEqual(result.concepts[0].locationHints.map((location) => [location.start, location.end]), [[1, 1]])
})

test('原件端点实际拒绝文件时自动回退，并在后续文件中记住兼容模式', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-original-auto-fallback-'))
  try {
    const filePath = path.join(sandbox, 'lecture.pdf')
    await fs.writeFile(filePath, '%PDF-1.7')
    const urls = []
    const config = { provider: 'openai', baseUrl: 'https://fallback-once.test/v1', model: 'file-model', apiKey: 'secret', capabilities: { files: true, responses: true, refinementMode: 'original-file' } }
    const document = { materialId: 'lecture', title: 'lecture.pdf', localPath: filePath, courseName: 'Signals', text: 'Fourier transform', segments: [{ kind: 'pdf-page', start: 1, end: 1, text: 'Fourier transform pair' }] }
    const fetchImpl = async (url) => {
      urls.push(url)
      if (url.endsWith('/files')) return { ok: false, status: 404, text: async () => 'not found' }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '傅里叶变换', concepts: [{ title: '傅里叶变换对', evidence: 'Fourier transform pair', start: 1, end: 1 }] }) } }] }) }
    }
    await refineDocumentWithCloud({ config, document, fetchImpl })
    await refineDocumentWithCloud({ config, document: { ...document, materialId: 'lecture-2' }, fetchImpl })
    assert.equal(urls.filter((url) => url.endsWith('/files')).length, 1)
    assert.equal(urls.filter((url) => url.endsWith('/chat/completions')).length, 2)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('轻量页码映射只发送知识点和页面卡片并保留连续范围', async () => {
  let requestBody
  const result = await mapConceptPagesWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    document: { title: 'signals.pdf', courseName: 'Signals' },
    concepts: [{ title: '群延迟', evidence: 'τ(ω)' }, { title: '线性相位系统', evidence: 'Y(jω)' }],
    cards: [
      { kind: 'pdf-page', start: 12, end: 12, heading: 'Linear Phase System', snippet: 'frequency response and time delay' },
      { kind: 'pdf-page', start: 13, end: 13, heading: 'Non-linear Phase System', snippet: 'phase distortion' },
      { kind: 'pdf-page', start: 14, end: 14, heading: 'Group Delay', snippet: 'group delay definition' },
      { kind: 'pdf-page', start: 15, end: 15, heading: 'Group Delay', snippet: 'example' },
      { kind: 'pdf-page', start: 16, end: 16, heading: 'Group Delay', snippet: 'derivation' },
    ],
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ mappings: [
        { conceptIndex: 0, ranges: [{ start: 14, end: 16, confidence: 0.94, reason: 'Group Delay' }] },
        { conceptIndex: 1, ranges: [{ start: 12, end: 13, confidence: 0.9, reason: 'Linear Phase System' }] },
      ] }) } }] }) }
    },
  })
  const prompt = requestBody.messages.at(-1).content
  assert.match(prompt, /页面卡片/)
  assert.doesNotMatch(prompt, /整份课件全文/)
  assert.deepEqual(result.map((mapping) => mapping.ranges.map((range) => [range.start, range.end])), [[[14, 16]], [[12, 13]]])
})

test('课程级归并只上传知识点元数据并忽略低置信度或重叠分组', async () => {
  let prompt = ''
  const result = await normalizeCourseConceptsWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    courses: [{ courseId: 'signals', courseName: 'Signals', concepts: [
      { title: 'Properties of LTI Systems', summary: 'system properties', sourceIds: ['a'], locations: [{ materialId: 'a', kind: 'pdf-page', start: 2, end: 4 }] },
      { title: 'LTI System Properties', summary: 'same topic', sourceIds: ['b'], locations: [{ materialId: 'b', kind: 'pptx-slide', start: 7, end: 7 }] },
      { title: 'LTI Stability', summary: 'different topic', sourceIds: ['c'] },
    ] }],
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages.at(-1).content
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ groups: [
        { canonical: 'LTI System Properties', aliases: ['Properties of LTI Systems', 'LTI System Properties'], confidence: 0.97 },
        { canonical: 'LTI Stability', aliases: ['LTI System Properties', 'LTI Stability'], confidence: 0.65 },
      ] }) } }] }) }
    },
  })
  assert.match(prompt, /知识点元数据/)
  assert.doesNotMatch(prompt, /课件全文内容/)
  assert.deepEqual(result[0].groups, [{ canonical: 'LTI System Properties', aliases: ['LTI System Properties', 'Properties of LTI Systems'], confidence: 0.97 }])
})

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
  const requests = []
  const result = await testCloudConnection({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      if (!url.endsWith('/chat/completions')) return { status: 404 }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }
    },
  })

  const request = requests[0]
  assert.equal(request.url, 'https://example.test/v1/chat/completions')
  assert.equal(JSON.parse(request.options.body).messages[0].content, 'Reply with exactly: OK')
  assert.equal(result.model, 'study-model')
  assert.ok(result.latencyMs >= 0)
  assert.equal(result.capabilities.refinementMode, 'structured-pages')
})

test('长 PDF/PPTX 按页面组精炼并保留模型返回的页码提示', async () => {
  let requests = 0
  const segments = Array.from({ length: 25 }, (_, index) => ({ kind: 'pptx-slide', start: index + 1, end: index + 1, text: `Slide ${index + 1} concept ${index + 1}` }))
  const result = await refineKnowledgeWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    document: { title: 'large.pptx', courseName: '课程', text: '', segments },
    fetchImpl: async (_url, options) => {
      requests += 1
      const prompt = JSON.parse(options.body).messages.at(-1).content
      const second = prompt.includes('[幻灯片 25]')
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: second ? '第二组' : '第一组', concepts: [{ title: second ? '尾页主题' : '首页主题', evidence: second ? 'Slide 25 concept 25' : 'Slide 1 concept 1', start: second ? 25 : 1, end: second ? 25 : 1 }] }) } }] }) }
    },
  })

  assert.equal(requests, 2)
  assert.equal(result.locationBatches, 2)
  assert.deepEqual(result.concepts.map((concept) => concept.locationHints), [
    [{ kind: 'pptx-slide', start: 1, end: 1 }],
    [{ kind: 'pptx-slide', start: 25, end: 25 }],
  ])
})

test('快速整体模式即使存在页级分段也只发送一次整体请求', async () => {
  let requests = 0
  const result = await refineKnowledgeWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    mode: 'quick',
    document: { title: 'large.pdf', courseName: '课程', text: '开头\n中间\n结尾', segments: [{ kind: 'pdf-page', start: 1, end: 1, text: 'Page one' }] },
    fetchImpl: async (_url, options) => {
      requests += 1
      const prompt = JSON.parse(options.body).messages.at(-1).content
      assert.match(prompt, /资料文本/)
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '整体摘要', concepts: [{ title: '整体知识点', evidence: '开头' }] }) } }] }) }
    },
  })

  assert.equal(requests, 1)
  assert.equal(result.mode, 'quick')
  assert.equal(result.locationBatches, 0)
})

test('快速整体模式会分层采样大文件的开头、中间和结尾', async () => {
  let prompt = ''
  const document = {
    title: 'huge.pdf', courseName: '课程',
    text: `BEGIN_MARKER${'A'.repeat(70_000)}MIDDLE_MARKER${'B'.repeat(70_000)}END_MARKER`,
    segments: [],
  }
  await refineKnowledgeWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' }, mode: 'quick', document,
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages.at(-1).content
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '摘要', concepts: [{ title: '大文件主题', evidence: 'MIDDLE_MARKER' }] }) } }] }) }
    },
  })
  assert.match(prompt, /BEGIN_MARKER/)
  assert.match(prompt, /MIDDLE_MARKER/)
  assert.match(prompt, /END_MARKER/)
})

test('深度模式可以从已保存的页面组检查点继续', async () => {
  let requests = 0
  const checkpoints = []
  const segments = Array.from({ length: 25 }, (_, index) => ({ kind: 'pdf-page', start: index + 1, end: index + 1, text: `Page ${index + 1} concept` }))
  const checkpoint = { nextBatch: 1, results: [{ summary: '第一组', concepts: [{ title: '第一组主题', evidence: 'Page 1 concept', locationHints: [{ kind: 'pdf-page', start: 1, end: 3 }] }] }] }
  const result = await refineKnowledgeWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    mode: 'deep', checkpoint,
    document: { title: 'large.pdf', courseName: '课程', text: '', segments },
    onCheckpoint: async (value) => { checkpoints.push(value.nextBatch) },
    fetchImpl: async () => {
      requests += 1
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '第二组', concepts: [{ title: '第二组主题', evidence: 'Page 25 concept', start: 24, end: 25 }] }) } }] }) }
    },
  })

  assert.equal(requests, 1)
  assert.deepEqual(checkpoints, [2])
  assert.equal(result.concepts.length, 2)
})

test('深度模式完整覆盖超过八个页面组的长课件并报告覆盖率', async () => {
  let requests = 0
  const segments = Array.from({ length: 220 }, (_, index) => ({ kind: 'pdf-page', start: index + 1, end: index + 1, text: `Page ${index + 1} topic` }))
  const result = await refineKnowledgeWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' }, mode: 'deep',
    document: { title: '220-pages.pdf', courseName: '课程', text: '', segments },
    fetchImpl: async (_url, options) => {
      requests += 1
      const prompt = JSON.parse(options.body).messages.at(-1).content
      const page = Number(prompt.match(/\[PDF 页 (\d+)/)?.[1] ?? 1)
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: `第${page}页组`, concepts: [{ title: `主题 ${page}`, evidence: `Page ${page} topic`, start: page, end: page }] }) } }] }) }
    },
  })
  assert.equal(requests, 10)
  assert.equal(result.coverage.covered, 220)
  assert.equal(result.coverage.total, 220)
  assert.equal(result.coverage.percent, 100)
})

test('用户立即停止会中断云端请求并返回可识别的终止错误', async () => {
  const controller = new AbortController()
  const pending = refineKnowledgeWithCloud({
    config: { baseUrl: 'https://example.test/v1', model: 'study-model', apiKey: 'secret' },
    mode: 'quick', signal: controller.signal,
    document: { title: 'lecture.pdf', courseName: '课程', text: 'Signals and systems', segments: [] },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
  })
  controller.abort()
  await assert.rejects(pending, (error) => error?.code === 'AI_REFINEMENT_ABORTED')
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
