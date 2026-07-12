const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const test = require('node:test')
const JSZip = require('jszip')
const CFB = require('cfb')
const { buildKnowledgeIndex, extractLocalDocumentText, knowledgeStatus, refineKnowledgeDocument } = require('./knowledge.cjs')

function createPdf(text) {
  const content = `BT /F1 20 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
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
    assert.ok(result.concepts.some((concept) => concept.title === '低功耗物联网'))
    assert.equal(status.documents[0].status, 'parsed')
    assert.ok(status.documents[0].outline.includes('ESP32 与 MicroPython'))
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
    assert.equal(result.documents[0].parserVersion, 6)
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
    const refine = async () => ({ summary: 'summary', concepts: [{ title: 'Finite state machine', evidence: 'slide' }], model: 'test-model' })
    const first = await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'fsm', refine: async (document) => { requests += 1; return refine(document) } })
    await assert.rejects(() => refineKnowledgeDocument({ root: sandbox, documents, materialId: 'fsm', refine }), /已经使用当前资料内容完成 AI 精炼/)
    const retried = await refineKnowledgeDocument({ root: sandbox, documents, materialId: 'fsm', refine: async (document) => { requests += 1; return refine(document) }, force: true })

    assert.equal(requests, 2)
    assert.equal(first.documents[0].ai.sourceHash, retried.documents[0].ai.sourceHash)
    assert.equal(retried.documents[0].ai.model, 'test-model')
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
    await refineKnowledgeDocument({ root: sandbox, documents: firstDocument, materialId: 'fsm-path', refine: async () => ({ summary: 'AI summary', concepts: [{ title: 'Finite state machine', evidence: 'slide' }], model: 'test-model' }) })

    const rebuilt = await buildKnowledgeIndex({ root: sandbox, documents: [{ ...firstDocument[0], localPath: importedVersion }] })
    assert.equal(rebuilt.documents[0].ai.summary, 'AI summary')
    assert.equal(rebuilt.documents[0].ai.concepts[0].title, 'Finite state machine')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})
