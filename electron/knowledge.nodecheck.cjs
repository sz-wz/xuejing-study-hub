const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const test = require('node:test')
const JSZip = require('jszip')
const CFB = require('cfb')
const { buildKnowledgeIndex, extractLocalDocumentText, knowledgeStatus, normalizeCourseKnowledgeConcepts, refineKnowledgeDocument, refineKnowledgeDocuments, reindexKnowledgeDocument, searchKnowledgeDocuments, toConceptTitle, updateKnowledgePageLocation } = require('./knowledge.cjs')

test('离线候选主题会过滤真实课件中的公式残片、提问和截断句', () => {
  for (const noise of ['= eTRC)', 'Poin)=1, Oestr, ozins=', 'PRINT', 'Enter', 'Aside: An Orthonormal Set', 'Dot-product (inner-product) defined as', 'Any x[n] is a linear combination of phi', 'Any x[n] ∈ T is a linear combination of ∅', '[ n ], which is also', 'Ø Approximate a discrete', 'square by F x[n]', 'efters', '什么东西存在，实在的本性是什么？', '人应当如何生活的问题（伦理学）为中心。', '古代晚期怀疑主义主张，人类无法通过感官或理性获得关于世界的确定知识，因此应对一切信念保持']) {
    assert.equal(toConceptTitle(noise), '', noise)
  }
  assert.equal(toConceptTitle('2. No convergence issue in discrete-time'), 'No convergence issue in discrete-time')
  assert.equal(toConceptTitle('傅里叶级数的收敛条件'), '傅里叶级数的收敛条件')
})

function createPdfPages(texts) {
  const contents = texts.map((text) => `BT /F1 20 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`)
  const pageReferences = contents.map((_content, index) => `${4 + index * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageReferences}] /Count ${contents.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  contents.forEach((content, index) => {
    const contentReference = 5 + index * 2
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentReference} 0 R >>`)
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  })
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf)
}

function createPdf(text) {
  return createPdfPages([text])
}

test('全局搜索只在本地知识索引中检索资料正文并返回上下文片段', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-search-'))
  try {
    const lecture = path.join(sandbox, 'lecture.tex')
    await fs.writeFile(lecture, '\\section{State Space Model}\nThe controllability matrix determines whether every state can be reached.', 'utf8')
    const documents = [{ materialId: 'control-lecture', courseId: 'ee-control', courseName: '控制理论', title: 'Lecture 4.tex', localPath: lecture, type: '文件' }]
    await buildKnowledgeIndex({ root: sandbox, documents })

    const results = await searchKnowledgeDocuments({ root: sandbox, documents, query: 'controllability matrix' })
    assert.equal(results.length, 1)
    assert.equal(results[0].materialId, 'control-lecture')
    assert.match(results[0].snippet, /controllability matrix/i)
    assert.deepEqual(await searchKnowledgeDocuments({ root: sandbox, documents, query: 'teacher email' }), [])
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('从 PPTX 幻灯片构建本地知识条目与来源索引', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-'))
  try {
    const lecture = path.join(sandbox, 'lecture.pptx')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>低功耗物联网</a:t><a:t>课程关系与评分标准</a:t></p:sld>')
    zip.file('ppt/slides/slide2.xml', '<p:sld><a:t>嵌入式系统编程</a:t><a:t>ESP32 与 MicroPython</a:t></p:sld>')
    await fs.writeFile(lecture, await zip.generateAsync({ type: 'nodebuffer' }))

    const result = await buildKnowledgeIndex({ root: sandbox, documents: [{ materialId: 'ee291e-lecture-1', courseId: 'ee291e', courseName: '低功耗物联网', title: 'lecture.pptx', localPath: lecture, type: 'PPT' }] })
    const status = await knowledgeStatus(sandbox, [{ materialId: 'ee291e-lecture-1' }])

    assert.equal(result.stats.parsed, 1)
    assert.ok(!result.concepts.some((concept) => concept.title === '低功耗物联网'))
    assert.equal(status.documents[0].status, 'parsed')
    assert.ok(status.documents[0].outline.includes('ESP32 与 MicroPython'))
    assert.equal(result.documents[0].parserVersion, 9)
    const slideConcept = result.concepts.find((concept) => concept.title === 'ESP32 与 MicroPython')
    assert.deepEqual(slideConcept.locations, [{ materialId: 'ee291e-lecture-1', kind: 'pptx-slide', start: 2, end: 2, confidence: 0.99, evidence: 'ESP32 与 MicroPython' }])
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('从多页 PDF 建立知识点到具体页码的本地索引', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-pdf-pages-'))
  try {
    const lecture = path.join(sandbox, 'signals.pdf')
    await fs.writeFile(lecture, createPdfPages(['Course introduction', 'Discrete convolution calculation']))
    const result = await buildKnowledgeIndex({ root: sandbox, documents: [{ materialId: 'signals-pdf', courseId: 'signals', courseName: 'Signals', title: 'signals.pdf', localPath: lecture, type: 'PDF' }] })
    const concept = result.concepts.find((item) => item.title === 'Discrete convolution calculation')
    assert.deepEqual(concept.locations, [{ materialId: 'signals-pdf', kind: 'pdf-page', start: 2, end: 2, confidence: 0.99, evidence: 'Discrete convolution calculation' }])
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('手动作业文件可在不写入课程知识库的情况下提取文本供 AI 分析', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-assignment-text-'))
  try {
    const assignment = path.join(sandbox, 'hw2.tex')
    await fs.writeFile(assignment, '\\section{Fourier Transform}\nCompute the convolution of the given signals.', 'utf8')
    const result = await extractLocalDocumentText({ materialId: 'assignment-hw2', courseId: '', courseName: '', title: 'hw2.tex', localPath: assignment })

    assert.match(result.text, /Fourier Transform/)
    assert.match(result.text, /convolution/)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('知识条目会排除课件中的联系方式、授课信息和页眉', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-filter-'))
  try {
    const lecture = path.join(sandbox, 'fsm-programming.pptx')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', `<p:sld>
      <a:t>Instructor: Demo Instructor</a:t>
      <a:t>contact@example.com</a:t>
      <a:t>@qq.com</a:t>
      <a:t>Lecture #8 EE291E FSM programming</a:t>
      <a:t>Finite state machine based programming</a:t>
      <a:t>Round-robin scheduling with RTX51</a:t>
      <a:t>Priorities and preemption</a:t>
    </p:sld>`)
    await fs.writeFile(lecture, await zip.generateAsync({ type: 'nodebuffer' }))

    const result = await buildKnowledgeIndex({
      root: sandbox,
      documents: [{ materialId: 'ee291e-lecture-8', courseId: 'ee291e', courseName: 'Low-power IoT System', title: 'fsm-programming.pptx', localPath: lecture, type: 'PPT' }],
    })
    const titles = result.concepts.map((concept) => concept.title)

    assert.ok(titles.includes('Finite state machine based programming'))
    assert.ok(titles.includes('Round-robin scheduling with RTX51'))
    assert.ok(titles.includes('Priorities and preemption'))
    assert.ok(!titles.some((title) => /demo instructor|contact@example.com|qq\.com|lecture #8/i.test(title)))
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('教材仅保留为参考资料，不自动扩大课程知识条目', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-reference-'))
  try {
    const lecture = path.join(sandbox, 'lecture.pptx')
    const textbook = path.join(sandbox, 'textbook.pptx')
    const writePptx = async (file, texts) => {
      const zip = new JSZip()
      zip.file('ppt/slides/slide1.xml', '<p:sld>' + texts.map((text) => '<a:t>' + text + '</a:t>').join('') + '</p:sld>')
      await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }))
    }
    await writePptx(lecture, ['Finite state machine programming'])
    await writePptx(textbook, ['Detailed reference on state machine theory'])

    const result = await buildKnowledgeIndex({
      root: sandbox,
      documents: [
        { materialId: 'lecture', courseId: 'ee291e', courseName: 'Low-power IoT System', title: 'lecture.pptx', localPath: lecture, type: 'PPT', knowledgeRole: 'courseware' },
        { materialId: 'textbook', courseId: 'ee291e', courseName: 'Low-power IoT System', title: 'textbook.pptx', localPath: textbook, type: 'PPT', knowledgeRole: 'reference' },
      ],
    })
    const titles = result.concepts.map((concept) => concept.title)
    const reference = result.documents.find((document) => document.materialId === 'textbook')

    assert.ok(titles.includes('Finite state machine programming'))
    assert.ok(!titles.includes('Detailed reference on state machine theory'))
    assert.equal(reference.knowledgeRole, 'reference')
    assert.ok(reference.outline.includes('Detailed reference on state machine theory'))
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('带章节小数点但没有扩展名的缓存课件按文件内容解析', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-dotted-title-'))
  try {
    const lecture = path.join(sandbox, 'Ch1.1 Introduction')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Signal classification</a:t></p:sld>')
    await fs.writeFile(lecture, await zip.generateAsync({ type: 'nodebuffer' }))
    const result = await buildKnowledgeIndex({
      root: sandbox,
      documents: [{ materialId: 'signals-ch1', courseId: 'ee150', courseName: 'Signals and Systems', title: 'Ch1.1 Introduction', localPath: lecture, type: 'PPT' }],
    })

    assert.equal(result.documents[0].status, 'parsed')
    assert.ok(result.concepts.some((concept) => concept.title === 'Signal classification'))
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('DOCX、旧版 PPT 和 LaTeX 资料可在本地提取为知识条目', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-office-'))
  try {
    const docx = path.join(sandbox, 'notes.docx')
    const tex = path.join(sandbox, 'chapter.tex')
    const ppt = path.join(sandbox, 'legacy.ppt')
    const archive = new JSZip()
    archive.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>数字信号处理基础</w:t></w:r></w:p><w:p><w:r><w:t>离散时间卷积</w:t></w:r></w:p></w:body></w:document>')
    await fs.writeFile(docx, await archive.generateAsync({ type: 'nodebuffer' }))
    await fs.writeFile(tex, '\\section{状态空间模型}\n系统的状态变量与输出方程。')

    const record = Buffer.alloc(8 + Buffer.byteLength('Legacy finite state machine', 'utf16le'))
    record.writeUInt16LE(4000, 2)
    record.writeUInt32LE(record.length - 8, 4)
    record.write('Legacy finite state machine', 8, 'utf16le')
    const compound = CFB.utils.cfb_new()
    CFB.utils.cfb_add(compound, 'PowerPoint Document', record)
    await fs.writeFile(ppt, CFB.write(compound, { type: 'buffer' }))

    const result = await buildKnowledgeIndex({ root: sandbox, documents: [
      { materialId: 'docx', courseId: 'course', courseName: '数字信号处理', title: 'notes.docx', localPath: docx, type: '文件' },
      { materialId: 'tex', courseId: 'course', courseName: '数字信号处理', title: 'chapter.tex', localPath: tex, type: '文件' },
      { materialId: 'ppt', courseId: 'course', courseName: '数字信号处理', title: 'legacy.ppt', localPath: ppt, type: 'PPT' },
    ] })

    assert.equal(result.stats.parsed, 3)
    assert.ok(result.documents.find((document) => document.materialId === 'docx')?.outline.includes('离散时间卷积'))
    assert.ok(result.documents.find((document) => document.materialId === 'tex')?.outline.includes('状态空间模型'))
    assert.ok(result.documents.find((document) => document.materialId === 'ppt')?.outline.includes('Legacy finite state machine'))
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('修复 PDF 扩展名后会替换旧索引路径并重新解析', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-relocated-pdf-'))
  try {
    const oldPath = path.join(sandbox, 'Ch1.2 basic time signals')
    const repairedPath = `${oldPath}.pdf`
    await fs.writeFile(repairedPath, createPdf('Basic time signals'))
    await fs.mkdir(path.join(sandbox, '.xuejing'), { recursive: true })
    await fs.writeFile(path.join(sandbox, '.xuejing', 'knowledge-index.json'), JSON.stringify({
      version: 4,
      documents: {
        'signals-ch1-2': {
          materialId: 'signals-ch1-2',
          courseId: 'ee150',
          courseName: 'Signals and Systems',
          title: 'Ch1.2 basic time signals',
          localPath: oldPath,
          status: 'unsupported',
          error: '当前仅支持 PDF 和 PPTX 文本提取',
        },
      },
      concepts: [],
    }, null, 2))

    const documents = [{ materialId: 'signals-ch1-2', courseId: 'ee150', courseName: 'Signals and Systems', title: 'Ch1.2 basic time signals.pdf', localPath: repairedPath, type: 'PDF' }]
    const status = await knowledgeStatus(sandbox, documents)
    const saved = JSON.parse(await fs.readFile(path.join(sandbox, '.xuejing', 'knowledge-index.json'), 'utf8'))

    assert.equal(status.documents[0].status, 'parsed')
    assert.equal(status.documents[0].localPath, repairedPath)
    assert.equal(saved.documents['signals-ch1-2'].status, 'parsed')
    assert.equal(saved.documents['signals-ch1-2'].localPath, repairedPath)
    assert.ok(status.documents[0].textLength > 0)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('同一内容不会被重复 AI 精炼，强制重试会覆盖旧结果', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-ai-dedupe-'))
  try {
    const lecture = path.join(sandbox, 'lecture.pptx')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Finite state machine</a:t></p:sld>')
    await fs.writeFile(lecture, await zip.generateAsync({ type: 'nodebuffer' }))
    const documents = [{ materialId: 'fsm', courseId: 'ee291e', courseName: 'IoT', title: 'lecture.pptx', localPath: lecture, type: 'PPT' }]
    await buildKnowledgeIndex({ root: sandbox, documents })
    let requests = 0
    const refine = async () => ({ summary: 'summary', concepts: [{ title: 'Finite state machine', evidence: 'Finite state machine' }], model: 'test-model' })
    const first = await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'fsm', refine: async (document) => { requests += 1; return refine(document) } })
    await assert.rejects(() => refineKnowledgeDocument({ root: sandbox, documents, materialId: 'fsm', refine }), /已经使用当前资料内容完成 AI 精炼/)
    const retried = await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'fsm', refine: async (document) => { requests += 1; return refine(document) }, force: true })

    assert.equal(requests, 2)
    assert.equal(first.documents[0].ai.sourceHash, retried.documents[0].ai.sourceHash)
    assert.equal(retried.documents[0].ai.model, 'test-model')
    assert.deepEqual(retried.concepts[0].locations, [{ materialId: 'fsm', kind: 'pptx-slide', start: 1, end: 1, confidence: 0.99, evidence: 'Finite state machine' }])
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('批量 AI 精炼可以按用户选择强制重新精炼已有结果', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-ai-batch-force-'))
  try {
    const lecture = path.join(sandbox, 'lecture.pptx')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Finite state machine</a:t></p:sld>')
    await fs.writeFile(lecture, await zip.generateAsync({ type: 'nodebuffer' }))
    const documents = [{ materialId: 'fsm-batch', courseId: 'ee291e', courseName: 'IoT', title: 'lecture.pptx', localPath: lecture, type: 'PPT' }]
    await buildKnowledgeIndex({ root: sandbox, documents })
    let requests = 0
    const refine = async () => {
      requests += 1
      return { summary: `summary-${requests}`, concepts: [{ title: 'Finite state machine', evidence: 'Finite state machine' }], model: 'test-model' }
    }
    await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'fsm-batch', refine })
    const result = await refineKnowledgeDocuments({ root: sandbox, documents, materialIds: ['fsm-batch'], refine, force: true })

    assert.equal(requests, 2)
    assert.equal(result.batch.completed, 1)
    assert.deepEqual(result.batch.failed, [])
    assert.equal(result.documents[0].ai.summary, 'summary-2')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('页级知识定位会合并连续页面并保留不连续的多个范围', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-ai-ranges-'))
  try {
    const lecture = path.join(sandbox, 'ranges.pdf')
    await fs.writeFile(lecture, createPdfPages([
      'Course outline',
      'Convolution theorem definition',
      'Convolution theorem derivation',
      'Convolution theorem example',
      'Unrelated topic',
      'Unrelated topic',
      'Convolution theorem application',
      'Summary',
    ]))
    const documents = [{ materialId: 'ranges', courseId: 'signals', courseName: 'Signals', title: 'ranges.pdf', localPath: lecture, type: 'PDF' }]
    await buildKnowledgeIndex({ root: sandbox, documents })
    const refined = await refineKnowledgeDocument({
      root: sandbox, documents, materialId: 'ranges',
      refine: async () => ({
        summary: 'Convolution', model: 'test-model', locationBatches: 1,
        concepts: [{ title: 'Convolution theorem', evidence: 'Convolution theorem', locationHints: [{ kind: 'pdf-page', start: 1, end: 8 }] }],
      }),
    })
    assert.deepEqual(refined.documents[0].ai.concepts[0].locations.map(({ start, end }) => [start, end]), [[2, 4], [7, 7]])
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('本地解析会优先保留课件主题并过滤重复课程抬头', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-local-ranking-'))
  try {
    const lecture = path.join(sandbox, 'lecture.pptx')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Signals and Systems</a:t><a:t>Convolution Sum</a:t><a:t>0, else</a:t></p:sld>')
    zip.file('ppt/slides/slide2.xml', '<p:sld><a:t>Signals and Systems</a:t><a:t>Impulse Response</a:t><a:t>292 =</a:t></p:sld>')
    zip.file('ppt/slides/slide3.xml', '<p:sld><a:t>Signals and Systems</a:t><a:t>LTI System Properties</a:t><a:t>Example 1: determine the Fourier series of this signal</a:t><a:t>苏 格拉底 哲 学</a:t><a:t>思考题</a:t></p:sld>')
    await fs.writeFile(lecture, await zip.generateAsync({ type: 'nodebuffer' }))
    const result = await buildKnowledgeIndex({ root: sandbox, documents: [{ materialId: 'local-ranking', courseId: 'signals', courseName: 'Signals and Systems', title: 'lecture.pptx', localPath: lecture, type: 'PPT' }] })
    const outline = result.documents[0].outline
    assert.ok(outline.includes('Convolution Sum'))
    assert.ok(outline.includes('Impulse Response'))
    assert.ok(outline.includes('LTI System Properties'))
    assert.ok(!outline.includes('Signals and Systems'))
    assert.ok(!outline.some((item) => /else|292|example/i.test(item)))
    assert.ok(outline.includes('苏格拉底哲学'))
    assert.ok(!outline.includes('思考题'))
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('课程级知识归一化会合并词序和复数形式不同的同义标题', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-course-normalization-'))
  try {
    const files = []
    for (const [id, title] of [['a', 'Properties of LTI Systems'], ['b', 'LTI System Properties']]) {
      const file = path.join(sandbox, `${id}.pptx`)
      const zip = new JSZip()
      zip.file('ppt/slides/slide1.xml', `<p:sld><a:t>${title}</a:t></p:sld>`)
      await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }))
      files.push({ materialId: id, courseId: 'signals', courseName: 'Signals', title: `${id}.pptx`, localPath: file, type: 'PPT' })
    }
    await buildKnowledgeIndex({ root: sandbox, documents: files })
    await refineKnowledgeDocument({ root: sandbox, documents: files, materialId: 'a', refine: async () => ({ summary: 'a', model: 'test', concepts: [{ title: 'Properties of LTI Systems', evidence: 'Properties of LTI Systems' }] }) })
    const result = await refineKnowledgeDocument({ root: sandbox, documents: files, materialId: 'b', refine: async () => ({ summary: 'b', model: 'test', concepts: [{ title: 'LTI System Properties', evidence: 'LTI System Properties' }] }) })
    const normalized = result.concepts.filter((concept) => concept.sourceIds.includes('a') || concept.sourceIds.includes('b'))
    assert.equal(normalized.length, 1)
    assert.deepEqual(new Set(normalized[0].sourceIds), new Set(['a', 'b']))
    assert.ok(normalized[0].aliases.includes('LTI System Properties'))
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('AI 课程级归并只改变聚合知识图谱并保留资料级原始精炼结果', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-ai-course-normalization-'))
  try {
    const files = []
    for (const [id, title] of [['a', 'Linear time invariant system characteristics'], ['b', 'LTI system properties']]) {
      const file = path.join(sandbox, `${id}.pptx`)
      const zip = new JSZip()
      zip.file('ppt/slides/slide1.xml', `<p:sld><a:t>${title}</a:t></p:sld>`)
      await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }))
      files.push({ materialId: id, courseId: 'signals', courseName: 'Signals', title: `${id}.pptx`, localPath: file, type: 'PPT' })
    }
    await buildKnowledgeIndex({ root: sandbox, documents: files })
    await refineKnowledgeDocument({ root: sandbox, documents: files, materialId: 'a', refine: async () => ({ summary: 'a summary', model: 'test', concepts: [{ title: 'Linear time invariant system characteristics', evidence: 'slide' }] }) })
    await refineKnowledgeDocument({ root: sandbox, documents: files, materialId: 'b', refine: async () => ({ summary: 'b summary', model: 'test', concepts: [{ title: 'LTI system properties', evidence: 'slide' }] }) })
    let payload
    const result = await normalizeCourseKnowledgeConcepts({ root: sandbox, documents: files, courseIds: ['signals'], normalize: async (courses) => {
      payload = courses
      return [{ courseId: 'signals', model: 'test', groups: [{ canonical: 'LTI system properties', aliases: ['Linear time invariant system characteristics', 'LTI system properties'], confidence: 0.97 }] }]
    } })
    assert.equal(payload[0].concepts.some((concept) => Object.hasOwn(concept, 'text')), false)
    const merged = result.concepts.filter((concept) => concept.sourceIds.includes('a') || concept.sourceIds.includes('b'))
    assert.equal(merged.length, 1)
    assert.equal(merged[0].title, 'LTI system properties')
    assert.ok(merged[0].aliases.includes('Linear time invariant system characteristics'))
    assert.equal(result.documents.find((document) => document.materialId === 'a').ai.concepts[0].title, 'Linear time invariant system characteristics')

    const changed = await refineKnowledgeDocument({ root: sandbox, documents: files, materialId: 'b', force: true, refine: async () => ({ summary: 'changed', model: 'test', concepts: [{ title: 'Bounded-input bounded-output stability', evidence: 'slide' }] }) })
    assert.ok(changed.concepts.some((concept) => concept.title === 'Linear time invariant system characteristics'))
    assert.ok(changed.concepts.some((concept) => concept.title === 'Bounded-input bounded-output stability'))
    assert.equal(changed.concepts.some((concept) => concept.title === 'LTI system properties'), false)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('快速整体精炼不会覆盖同一版本资料已有的深度页级结果', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-ai-profiles-'))
  try {
    const lecture = path.join(sandbox, 'profiles.pptx')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Convolution theorem</a:t></p:sld>')
    await fs.writeFile(lecture, await zip.generateAsync({ type: 'nodebuffer' }))
    const documents = [{ materialId: 'profiles', courseId: 'signals', courseName: 'Signals', title: 'profiles.pptx', localPath: lecture, type: 'PPT' }]
    await buildKnowledgeIndex({ root: sandbox, documents })
    await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'profiles', refine: async () => ({ summary: 'deep', model: 'test', mode: 'deep', locationBatches: 1, concepts: [{ title: 'Convolution theorem', evidence: 'Convolution theorem', locationHints: [{ kind: 'pptx-slide', start: 1, end: 1 }] }] }) })
    const result = await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'profiles', force: true, refine: async () => ({ summary: 'quick', model: 'test', mode: 'quick', locationBatches: 0, concepts: [{ title: 'Convolution', evidence: 'Convolution theorem' }] }) })
    assert.equal(result.documents[0].ai.mode, 'deep')
    assert.equal(result.documents[0].ai.summary, 'deep')
    assert.equal(result.documents[0].aiProfiles.quick.summary, 'quick')
    assert.equal(result.documents[0].aiProfiles.deep.summary, 'deep')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('内容哈希不变但资料库路径变化时，重新构建必须保留 AI 精炼结果', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-knowledge-ai-path-'))
  try {
    const original = path.join(sandbox, 'lecture.pptx')
    const importedVersion = path.join(sandbox, 'lecture-imported.pptx')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Finite state machine</a:t></p:sld>')
    await fs.writeFile(original, await zip.generateAsync({ type: 'nodebuffer' }))
    await fs.copyFile(original, importedVersion)
    const firstDocument = [{ materialId: 'fsm-path', courseId: 'ee291e', courseName: 'IoT', title: 'lecture.pptx', localPath: original, type: 'PPT' }]
    await buildKnowledgeIndex({ root: sandbox, documents: firstDocument })
    await refineKnowledgeDocument({ root: sandbox, documents: firstDocument, materialId: 'fsm-path', refine: async () => ({ summary: 'deep summary', concepts: [{ title: 'Finite state machine', evidence: 'slide', locationHints: [{ kind: 'pptx-slide', start: 1, end: 1 }] }], model: 'test-model', mode: 'deep', locationBatches: 1 }) })
    await refineKnowledgeDocument({ root: sandbox, documents: firstDocument, materialId: 'fsm-path', force: true, refine: async () => ({ summary: 'quick summary', concepts: [{ title: 'State machine', evidence: 'Finite state machine' }], model: 'test-model', mode: 'quick' }) })

    const rebuilt = await buildKnowledgeIndex({ root: sandbox, documents: [{ ...firstDocument[0], localPath: importedVersion }] })
    assert.equal(rebuilt.documents[0].ai.summary, 'deep summary')
    assert.equal(rebuilt.documents[0].ai.concepts[0].title, 'Finite state machine')
    assert.equal(rebuilt.documents[0].aiProfiles.quick.summary, 'quick summary')
    assert.equal(rebuilt.documents[0].aiProfiles.deep.summary, 'deep summary')
    assert.deepEqual(rebuilt.documents[0].aiProfiles.deep.concepts[0].locations.map((location) => [location.kind, location.start, location.end]), [['pptx-slide', 1, 1]])
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('页级索引补全复用现有 AI 知识点并支持人工确认和删除范围', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-page-index-backfill-'))
  try {
    const lecture = path.join(sandbox, 'signals.pptx')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Linear Phase System</a:t><a:t>Y(jω)=X(jω)e^{-jωt0}</a:t></p:sld>')
    zip.file('ppt/slides/slide2.xml', '<p:sld><a:t>Group Delay</a:t><a:t>τ(ω)=−d/dω ∠H(jω)</a:t></p:sld>')
    zip.file('ppt/slides/slide3.xml', '<p:sld><a:t>Group Delay Example</a:t><a:t>all-pass system</a:t></p:sld>')
    zip.file('ppt/slides/slide4.xml', '<p:sld><a:t>Application</a:t><a:t>filter example</a:t></p:sld>')
    await fs.writeFile(lecture, await zip.generateAsync({ type: 'nodebuffer' }))
    const documents = [{ materialId: 'signals-pages', courseId: 'signals', courseName: 'Signals', title: 'signals.pptx', localPath: lecture, type: 'PPTX' }]
    await buildKnowledgeIndex({ root: sandbox, documents })
    await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'signals-pages', refine: async () => ({ summary: 'phase topics', model: 'test-model', mode: 'deep', concepts: [
      { title: '线性相位系统', evidence: 'Y(jω)=X(jω)e^{-jωt0}' },
      { title: '群延迟', evidence: 'τ(ω)=−d/dω ∠H(jω)' },
    ] }) })
    let mappingInput
    const indexed = await reindexKnowledgeDocument({ root: sandbox, documents, materialId: 'signals-pages', mapPages: async (input) => {
      mappingInput = input
      return { model: 'map-model', mappings: [
        { conceptIndex: 0, ranges: [{ kind: 'pptx-slide', start: 1, end: 1, confidence: 0.94, reason: 'Linear Phase System' }] },
        { conceptIndex: 1, ranges: [{ kind: 'pptx-slide', start: 2, end: 3, confidence: 0.93, reason: 'Group Delay section' }] },
      ] }
    } })
    assert.equal(mappingInput.cards.some((card) => Object.hasOwn(card, 'text')), false)
    const profile = indexed.documents[0].ai
    assert.equal(profile.summary, 'phase topics')
    assert.equal(profile.pageIndex.located, 2)
    assert.deepEqual(profile.concepts.find((concept) => concept.title === '群延迟').locations.map((location) => [location.start, location.end]), [[2, 3]])

    const added = await updateKnowledgePageLocation({ root: sandbox, documents, materialId: 'signals-pages', conceptTitle: '群延迟', action: 'add', location: { kind: 'pptx-slide', start: 4, end: 4 } })
    assert.ok(added.documents[0].ai.concepts.find((concept) => concept.title === '群延迟').locations.some((location) => location.start === 4 && location.manual))
    const removed = await updateKnowledgePageLocation({ root: sandbox, documents, materialId: 'signals-pages', conceptTitle: '群延迟', action: 'remove', location: { kind: 'pptx-slide', start: 2, end: 3 } })
    assert.equal(removed.documents[0].ai.concepts.find((concept) => concept.title === '群延迟').locations.some((location) => location.start === 2 && location.end === 3), false)

    const relocated = path.join(sandbox, 'relocated-signals.pptx')
    await fs.copyFile(lecture, relocated)
    const rebuilt = await buildKnowledgeIndex({ root: sandbox, documents: [{ ...documents[0], localPath: relocated }] })
    const rebuiltConcept = rebuilt.documents[0].ai.concepts.find((concept) => concept.title === '群延迟')
    assert.ok(rebuiltConcept.locations.some((location) => location.start === 4 && location.manual), '资料迁移后应保留人工添加的页码')
    assert.equal(rebuiltConcept.locations.some((location) => location.start === 2 && location.end === 3), false, '资料迁移后应保留人工删除规则')
    assert.equal(rebuilt.documents[0].ai.pageIndex.located, 2)

    const offline = await reindexKnowledgeDocument({ root: sandbox, documents: [{ ...documents[0], localPath: relocated }], materialId: 'signals-pages', mapPages: async () => { throw new Error('network unavailable') } })
    const offlineConcept = offline.documents[0].ai.concepts.find((concept) => concept.title === '群延迟')
    assert.equal(offline.documents[0].ai.pageIndex.cloudError, 'network unavailable')
    assert.ok(offlineConcept.locations.some((location) => location.start === 4 && location.manual), '云端失败时仍应保存本地与人工定位')
    assert.equal(offlineConcept.locations.some((location) => location.start === 2 && location.end === 3), false)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('原件 AI 精炼直接保存模型返回的页码范围并拒绝教材精炼', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-original-profile-'))
  try {
    const lecture = path.join(sandbox, 'lecture.pptx')
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Linear Phase</a:t></p:sld>')
    zip.file('ppt/slides/slide2.xml', '<p:sld><a:t>Group Delay</a:t></p:sld>')
    zip.file('ppt/slides/slide3.xml', '<p:sld><a:t>Group Delay Example</a:t></p:sld>')
    await fs.writeFile(lecture, await zip.generateAsync({ type: 'nodebuffer' }))
    const documents = [{ materialId: 'original', courseId: 'signals', courseName: 'Signals', title: 'lecture.pptx', localPath: lecture, type: 'PPTX', knowledgeRole: 'courseware' }]
    await buildKnowledgeIndex({ root: sandbox, documents })
    const result = await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'original', refine: async () => ({ summary: 'original summary', model: 'file-model', mode: 'original', analysisMethod: 'original-file', concepts: [{ title: '群延迟', evidence: 'Group Delay', locations: [{ kind: 'pptx-slide', start: 2, end: 3, confidence: 0.94, method: 'ai-original-file' }] }] }) })
    assert.equal(result.documents[0].ai.mode, 'original')
    assert.equal(result.documents[0].ai.analysisMethod, 'original-file')
    assert.deepEqual(result.documents[0].ai.concepts[0].locations.map((location) => [location.start, location.end, location.method]), [[2, 3, 'ai-original-file']])
    await assert.rejects(refineKnowledgeDocument({ root: sandbox, documents: [{ ...documents[0], knowledgeRole: 'reference' }], materialId: 'original', force: true, refine: async () => ({}) }), /教材和参考资料/)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('对话型 API 的分页兼容结果作为统一 AI profile 保存', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-structured-profile-'))
  try {
    const lecture = path.join(sandbox, 'lecture.tex')
    await fs.writeFile(lecture, '\\section{Convolution} Convolution integral for LTI systems')
    const documents = [{ materialId: 'structured', courseId: 'signals', courseName: 'Signals', title: 'lecture.tex', localPath: lecture, type: 'TEX', knowledgeRole: 'courseware' }]
    await buildKnowledgeIndex({ root: sandbox, documents })
    const result = await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'structured', refine: async () => ({ summary: 'structured summary', model: 'deepseek-model', mode: 'original', analysisMethod: 'structured-pages', inputStrategy: 'local-structured-pages', concepts: [{ title: '卷积积分', evidence: 'Convolution integral' }] }) })
    assert.equal(result.documents[0].ai.mode, 'original')
    assert.equal(result.documents[0].ai.analysisMethod, 'structured-pages')
    assert.equal(result.documents[0].ai.inputStrategy, 'local-structured-pages')
    assert.equal(result.documents[0].ai.model, 'deepseek-model')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('切换资料版本时按文件哈希恢复各版本已有的 AI 精炼结果', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-version-ai-history-'))
  try {
    const firstPath = path.join(sandbox, 'lecture-v1.tex')
    const secondPath = path.join(sandbox, 'lecture-v2.tex')
    await fs.writeFile(firstPath, '\\section{Convolution} first version explanation')
    await fs.writeFile(secondPath, '\\section{Fourier Transform} second version explanation')
    const base = { materialId: 'versioned', courseId: 'signals', courseName: 'Signals', title: 'lecture.tex', type: 'TEX', knowledgeRole: 'courseware' }
    const first = [{ ...base, localPath: firstPath }]
    await buildKnowledgeIndex({ root: sandbox, documents: first })
    await refineKnowledgeDocument({ root: sandbox, documents: first, materialId: 'versioned', refine: async () => ({ summary: 'version one', model: 'file-model', mode: 'original', concepts: [{ title: '卷积', evidence: 'Convolution' }] }) })
    const second = [{ ...base, localPath: secondPath }]
    await buildKnowledgeIndex({ root: sandbox, documents: second })
    await refineKnowledgeDocument({ root: sandbox, documents: second, materialId: 'versioned', refine: async () => ({ summary: 'version two', model: 'file-model', mode: 'original', concepts: [{ title: '傅里叶变换', evidence: 'Fourier Transform' }] }) })
    const restored = await buildKnowledgeIndex({ root: sandbox, documents: first })
    assert.equal(restored.documents[0].ai.summary, 'version one')
    assert.equal(restored.documents[0].ai.mode, 'original')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})
