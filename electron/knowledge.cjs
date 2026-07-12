const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const JSZip = require('jszip')
const CFB = require('cfb')
const { recognizePdf } = require('./ocr.cjs')

const MAX_PARSE_BYTES = 80 * 1024 * 1024
const MAX_TEXT_LENGTH = 500_000
const PARSER_VERSION = 6
const MAX_OUTLINE_ITEMS = 8

function indexPath(root) {
  return path.join(root, '.xuejing', 'knowledge-index.json')
}

async function readKnowledgeIndex(root) {
  try {
    const parsed = JSON.parse(await fsp.readFile(indexPath(root), 'utf8'))
    return { version: PARSER_VERSION, documents: parsed.documents && typeof parsed.documents === 'object' ? parsed.documents : {}, concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [] }
  } catch {
    return { version: PARSER_VERSION, documents: {}, concepts: [] }
  }
}

async function writeKnowledgeIndex(root, index) {
  const destination = indexPath(root)
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  await fsp.writeFile(destination, JSON.stringify({ ...index, version: PARSER_VERSION, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function decodeXml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

async function extractPptx(buffer) {
  const archive = await JSZip.loadAsync(buffer)
  const slideNames = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1]) - Number(b.match(/slide(\d+)/i)?.[1]))
  const slides = []
  for (const name of slideNames) {
    const xml = await archive.file(name).async('string')
    const fragments = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi)].map((match) => decodeXml(match[1])).filter(Boolean)
    if (fragments.length) slides.push(fragments.join('\n'))
  }
  return slides.join('\n')
}

async function extractDocx(buffer) {
  const archive = await JSZip.loadAsync(buffer)
  const documentNames = Object.keys(archive.files)
    .filter((name) => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'))
  const parts = []
  for (const name of documentNames) {
    const xml = await archive.file(name).async('string')
    const paragraphs = xml.split(/<w:p\b[^>]*>/i).map((paragraph) => {
      const fragments = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi)].map((match) => decodeXml(match[1])).filter(Boolean)
      return fragments.join('')
    }).filter(Boolean)
    if (paragraphs.length) parts.push(paragraphs.join('\n'))
  }
  return parts.join('\n')
}

function extractLegacyPpt(buffer) {
  let stream = buffer
  try {
    const container = CFB.read(buffer, { type: 'buffer' })
    const entry = container.FileIndex?.find((item) => String(item?.name ?? '').toLocaleLowerCase() === 'powerpoint document')
    if (entry?.content?.length) stream = Buffer.from(entry.content)
  } catch {
    // 文件名带 .ppt 但不是可读取的 OLE 容器时，继续按原始字节做保守扫描。
  }

  const fragments = []
  const seen = new Set()
  for (let offset = 0; offset + 8 <= stream.length; offset += 1) {
    const recordType = stream.readUInt16LE(offset + 2)
    const length = stream.readUInt32LE(offset + 4)
    if ((recordType !== 4000 && recordType !== 4008) || length < 2 || length > 128 * 1024 || offset + 8 + length > stream.length) continue
    const bytes = stream.subarray(offset + 8, offset + 8 + length)
    const raw = recordType === 4000 ? bytes.toString('utf16le') : bytes.toString('latin1')
    const text = cleanLine(raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '))
    if (text.length >= 2 && !seen.has(text)) {
      seen.add(text)
      fragments.push(text)
    }
    offset += 7 + length
  }
  return fragments.join('\n')
}

function extractLatex(buffer) {
  const lines = buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
  const extracted = []
  for (const rawLine of lines) {
    const line = rawLine.replace(/(^|[^\\])%.*/, '$1').trim()
    if (!line || /^\\(?:documentclass|usepackage|begin\{|end\{|newcommand|def\b|label\{|ref\{|cite\{|includegraphics)/.test(line)) continue
    const section = line.match(/^\\(?:sub)*section\*?\{([^}]*)\}/)
    const simplified = (section?.[1] ?? line)
      .replace(/\\(?:textbf|textit|emph|underline|mathrm|mathbf|mathit)\{([^}]*)\}/g, '$1')
      .replace(/\\(?:item|paragraph)\b/g, ' ')
      .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, ' ')
      .replace(/[{}$~^_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (simplified) extracted.push(simplified)
  }
  return extracted.join('\n')
}

async function extractPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise
  const pages = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items.map((item) => item.str).join(' ').trim()
    if (text) pages.push(text)
    if (pages.join('\n').length >= MAX_TEXT_LENGTH) break
  }
  return pages.join('\n')
}

function extensionOf(document) {
  const extension = path.extname(document.localPath || document.title || '').toLowerCase()
  return ['.pdf', '.ppt', '.pptx', '.docx', '.tex', '.latex'].includes(extension) ? extension : ''
}

function extensionFromBuffer(buffer) {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return '.pdf'
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return '.ppt'
  if (buffer.indexOf(Buffer.from('word/')) >= 0) return '.docx'
  if (buffer.indexOf(Buffer.from('ppt/')) >= 0) return '.pptx'
  return ''
}

function isSupportedParserExtension(extension) {
  return ['.pdf', '.pptx', '.ppt', '.docx', '.tex', '.latex'].includes(extension)
}

async function hasSupportedDocumentFormat(document) {
  const namedExtension = extensionOf(document)
  if (isSupportedParserExtension(namedExtension)) return true
  try {
    const handle = await fsp.open(document.localPath, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return isSupportedParserExtension(extensionFromBuffer(buffer.subarray(0, bytesRead)))
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

function knowledgeRoleOf(document) {
  return document?.knowledgeRole === 'reference' ? 'reference' : 'courseware'
}

function cleanLine(value) {
  return value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function buildOutline(text, title) {
  const seen = new Set()
  const lines = [path.basename(title, path.extname(title)), ...String(text).split(/\r?\n/)]
  const outline = []
  for (const raw of lines) {
    const line = cleanLine(raw).replace(/^[•·◆▪◦\-–—\d.、()（）\s]+/, '')
    const key = line.toLocaleLowerCase()
    if (line.length < 3 || line.length > 90 || seen.has(key)) continue
    if (/^(page|slide|第\s*\d+\s*页|下载|blackboard)$/i.test(line)) continue
    seen.add(key)
    outline.push(line)
    if (outline.length >= 14) break
  }
  return outline
}

function looksLikeContactOrLink(value) {
  return /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|https?:\/\/|www\.)/i.test(value)
    || /(?:^|\s)@?[A-Z0-9._-]+\.(?:com|cn|edu|org|net)(?:\b|\/)/i.test(value)
}

function stripCourseChrome(value, courseName = '') {
  let line = cleanLine(value)
    .replace(/^[\s•▪◼◆◇■□*+\-–—·]+/u, '')
    .replace(/^(?:chapter|ch\.?)\s*\d+\s*[:：.、\-–—]?\s*/i, '')
    .replace(/^第\s*\d+\s*[章节]\s*[:：.、\-–—]?\s*/u, '')
    .replace(/\b(?:lecturer|instructor|teacher|prof(?:essor)?|teaching assistant)\s*[:：].*$/i, '')
    .replace(/(?:授课教师|授课老师|教师|老师)\s*[:：].*$/u, '')
    .replace(/\s*\(?\d+\s*\/\s*\d+\)?\s*$/, '')
    .replace(/\s+(?:page|slide)\s*\d+\s*$/i, '')
    .trim()

  line = line
    .replace(/^\s*\d+\s+(?=(?:chapter|ch\.?|part|outline|summary)\b)/i, '')
    .replace(/^\.\s*\d+\s+/, '')
    .replace(/^\d+\s+(?=[A-Za-z])/, '')
    .replace(/^(?:chapter|ch\.?)\s*\d+(?:\s*\.\s*\d+)*\s*[:.\-–—]?\s*/i, '')
    .replace(/\s+\d{1,3}\s*$/, '')
    .trim()

  const courseCodeIndex = line.search(/\b[A-Z]{2,}\s*\d{3,}[A-Z]?\b/i)
  const lectureIndex = line.search(/\b(?:lecture|slides?)\s*#?\s*\d+\b/i)
  if (lectureIndex >= 0) {
    const chromeStart = courseCodeIndex >= 0 && courseCodeIndex < lectureIndex ? courseCodeIndex : lectureIndex
    const prefix = line.slice(0, chromeStart).trim()
    if (!prefix) return ''
    line = prefix
  }

  const courseLabel = cleanLine(courseName).replace(/[（(].*$/, '').trim()
  if (courseLabel.length >= 4 && line.toLocaleLowerCase().startsWith(courseLabel.toLocaleLowerCase())) {
    const remainder = line.slice(courseLabel.length).replace(/^\s*[-:：–—]\s*/, '').trim()
    if (remainder) line = remainder
  }
  return line
}

function isStructuralNoise(value) {
  const line = cleanLine(value)
  const normalized = line.toLocaleLowerCase()
  if (!line || looksLikeContactOrLink(line)) return true
  if (/^(?:lecture|lecture slides|slides?|page)\s*(?:#|no\.?|l)?\s*\d+\b/i.test(line)) return true
  if (/^(?:第\s*\d+\s*[章节页]|\(?\d+\s*\/\s*\d+\)?)$/u.test(line)) return true
  if (/^(?:homework|assignment|project|作业|课程介绍|course introduction|lecture notes|slides|outline|contents|目录|blackboard)$/iu.test(line)) return true
  if (/^(?:[a-z]{1,8}\d+[a-z0-9_-]*|[a-z]+[-_]?(?:lect|lecture|slides?)[-_ ]?\d+.*)$/i.test(line)) return true
  if (/\b(?:instructor|lecturer|professor|teaching assistant)\b/i.test(line)) return true
  if (/(?:授课教师|授课老师|上海科技大学|shanghaitech)/iu.test(line)) return true
  if (/^(?:big\s+idea|you\s+try|any\s+questions?|next\s+week|intuition\s*[-–—]?\s*link|another example)$/i.test(normalized)) return true
  return false
}

function hasEnoughMeaningfulText(value) {
  const characters = [...value]
  const meaningful = characters.filter((character) => /[\p{L}\p{N}]/u.test(character))
  return meaningful.length >= 3 && meaningful.length / characters.length >= 0.52
}

function isSentenceLikeEnglish(value) {
  if (/[\u3400-\u9fff]/u.test(value)) return false
  const words = value.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []
  if (words.length <= 9) return false
  return /\b(?:i|you|we|they|it|this|that|is|are|was|were|be|can|will|should|don'?t|doesn'?t)\b/i.test(value)
}

function toConceptTitle(value, courseName = '') {
  const line = stripCourseChrome(value, courseName)
  if (line.length < 3 || line.length > 96 || isStructuralNoise(line) || !hasEnoughMeaningfulText(line)) return ''
  if (/\b(?:def|class)\s+[A-Za-z_]\w*\s*(?:\(|:)/.test(line)) return ''
  if (/\b(?:big\s+idea|you\s+try|any\s+questions?|next\s+week)\b/i.test(line)) return ''
  if (isSentenceLikeEnglish(line)) return ''
  return line
}

function buildFilteredOutline(text, document) {
  const seen = new Set()
  const courseName = document?.courseName ?? ''
  const outline = []
  const title = toConceptTitle(String(document?.title ?? '').replace(/\.(?:pdf|pptx|ppt|docx|tex|latex)$/i, ''), courseName)
  const candidates = title ? [title, ...String(text).split(/\r?\n/)] : String(text).split(/\r?\n/)
  for (const raw of candidates) {
    const line = toConceptTitle(raw, courseName)
    const key = line.toLocaleLowerCase()
    if (!line || seen.has(key)) continue
    seen.add(key)
    outline.push(line)
    if (outline.length >= MAX_OUTLINE_ITEMS) break
  }
  return outline
}

function buildStrictConcepts(documents) {
  const concepts = new Map()
  for (const document of documents) {
    if (!['parsed', 'ocr'].includes(document.status) || knowledgeRoleOf(document) !== 'courseware') continue
    const titles = Array.isArray(document.ai?.concepts) && document.ai.concepts.length
      ? document.ai.concepts.map((concept) => concept.title)
      : document.outline ?? []
    for (const rawTitle of titles) {
      const title = toConceptTitle(rawTitle, document.courseName)
      const key = title.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
      if (!title || !key) continue
      const existing = concepts.get(key) ?? { id: conceptId(key), title, sourceIds: [], courseIds: [] }
      if (!existing.sourceIds.includes(document.materialId)) existing.sourceIds.push(document.materialId)
      if (document.courseId && !existing.courseIds.includes(document.courseId)) existing.courseIds.push(document.courseId)
      concepts.set(key, existing)
    }
  }
  return [...concepts.values()].sort((a, b) => b.sourceIds.length - a.sourceIds.length || a.title.localeCompare(b.title, 'zh-CN'))
}

function conceptId(value) {
  return `concept-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 14)}`
}

function buildConcepts(documents) {
  const concepts = new Map()
  for (const document of documents) {
    if (document.status !== 'parsed') continue
    for (const title of document.outline ?? []) {
      const key = title.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
      if (!key || /^(课程介绍|lecture notes|slides)$/i.test(key)) continue
      const existing = concepts.get(key) ?? { id: conceptId(key), title, sourceIds: [], courseIds: [] }
      if (!existing.sourceIds.includes(document.materialId)) existing.sourceIds.push(document.materialId)
      if (document.courseId && !existing.courseIds.includes(document.courseId)) existing.courseIds.push(document.courseId)
      concepts.set(key, existing)
    }
  }
  return [...concepts.values()].sort((a, b) => b.sourceIds.length - a.sourceIds.length || a.title.localeCompare(b.title, 'zh-CN'))
}

async function parseDocument(document) {
  const stat = await fsp.stat(document.localPath)
  if (!stat.isFile()) throw new Error('本地路径不是文件')
  if (stat.size > MAX_PARSE_BYTES) return { status: 'skipped', error: '文件超过 80 MB，暂未自动解析', hash: await hashFile(document.localPath) }
  const hash = await hashFile(document.localPath)
  const namedExtension = extensionOf(document)
  const buffer = await fsp.readFile(document.localPath)
  const extension = namedExtension || extensionFromBuffer(buffer)
  if (!isSupportedParserExtension(extension)) return { status: 'unsupported', error: '当前支持 PDF、PPT/PPTX、DOCX 与 LaTeX（.tex）文本提取', hash }
  const text = extension === '.pdf' ? await extractPdf(buffer)
    : extension === '.pptx' ? await extractPptx(buffer)
      : extension === '.docx' ? await extractDocx(buffer)
        : extension === '.ppt' ? extractLegacyPpt(buffer)
          : extractLatex(buffer)
  const trimmedText = text.slice(0, MAX_TEXT_LENGTH)
  if (!trimmedText.trim()) return { status: extension === '.pdf' ? 'image' : 'empty', error: extension === '.pdf' ? '图片型 PDF，等待本地 OCR 支持' : '未从文件中提取到可用文本', hash, text: '' }
  return { status: 'parsed', hash, format: extension.slice(1), text: trimmedText, textLength: trimmedText.length, parserVersion: PARSER_VERSION, knowledgeRole: knowledgeRoleOf(document), outline: buildFilteredOutline(trimmedText, document) }
}

async function extractLocalDocumentText(document) {
  const parsed = await parseDocument({ ...document, knowledgeRole: 'reference' })
  if (parsed.status !== 'parsed' || !parsed.text?.trim()) {
    throw new Error(parsed.error || '未能从作业文件中提取可用文本')
  }
  return { text: parsed.text, format: parsed.format ?? '' }
}

function publicDocument(record) {
  const { text, ...rest } = record
  return rest
}

function activeRecords(index, documents) {
  const requested = new Map((Array.isArray(documents) ? documents : []).filter((document) => document?.materialId).map((document) => [document.materialId, document]))
  return Object.values(index.documents)
    .filter((document) => !requested.size || requested.has(document.materialId))
    .map((record) => {
      const document = requested.get(record.materialId)
      return document ? { ...record, title: document.title, courseId: document.courseId, courseName: document.courseName, localPath: document.localPath, knowledgeRole: knowledgeRoleOf(document) } : record
    })
}

function resultFromRecords(active, concepts) {
  return {
    documents: active.map(publicDocument),
    concepts,
    stats: {
      total: active.length,
      parsed: active.filter((document) => document.status === 'parsed' || document.status === 'ocr').length,
      ocr: active.filter((document) => document.status === 'ocr').length,
      image: active.filter((document) => document.status === 'image').length,
      failed: active.filter((document) => document.status === 'failed').length,
      unsupported: active.filter((document) => document.status === 'unsupported' || document.status === 'skipped').length,
      reference: active.filter((document) => knowledgeRoleOf(document) === 'reference').length,
      concepts: concepts.length,
    },
  }
}

async function buildKnowledgeIndex({ root, documents, onProgress }) {
  const index = await readKnowledgeIndex(root)
  const active = []
  const list = Array.isArray(documents) ? documents.filter((document) => document && typeof document.materialId === 'string' && typeof document.localPath === 'string').slice(0, 2000) : []
  for (let position = 0; position < list.length; position += 1) {
    const document = list[position]
    onProgress?.({ completed: position, total: list.length, title: document.title })
    try {
      const hash = await hashFile(document.localPath)
      const previous = index.documents[document.materialId]
      let record
      if (previous?.hash === hash && previous.localPath === document.localPath && ['parsed', 'ocr'].includes(previous.status) && previous.parserVersion === PARSER_VERSION) {
        record = { ...previous, title: document.title, courseId: document.courseId, courseName: document.courseName, knowledgeRole: knowledgeRoleOf(document), reused: true }
      } else {
        const parsed = await parseDocument(document)
        const preservedAi = previous?.hash === parsed.hash && ['parsed', 'ocr'].includes(parsed.status) ? previous.ai : undefined
        record = {
          materialId: document.materialId,
          courseId: document.courseId,
          courseName: document.courseName,
          title: document.title,
          localPath: document.localPath,
          parsedAt: new Date().toISOString(),
          ...parsed,
          ...(preservedAi ? { ai: preservedAi } : {}),
        }
      }
      index.documents[document.materialId] = record
      active.push(record)
    } catch (error) {
      const record = { materialId: document.materialId, courseId: document.courseId, courseName: document.courseName, title: document.title, localPath: document.localPath, status: 'failed', error: error instanceof Error ? error.message : String(error), parsedAt: new Date().toISOString() }
      index.documents[document.materialId] = record
      active.push(record)
    }
  }
  index.concepts = buildStrictConcepts(active)
  await writeKnowledgeIndex(root, index)
  onProgress?.({ completed: list.length, total: list.length, title: '' })
  return resultFromRecords(active, index.concepts)
}

function requestedDocument(documents, materialId) {
  return (Array.isArray(documents) ? documents : []).find((document) => document?.materialId === materialId)
}

async function ocrKnowledgeDocument({ root, documents, materialId, cachePath, onProgress }) {
  const document = requestedDocument(documents, materialId)
  if (!document) throw new Error('找不到需要 OCR 的资料')
  const source = await fsp.readFile(document.localPath)
  if (extensionOf(document) !== '.pdf' && extensionFromBuffer(source) !== '.pdf') throw new Error('当前仅支持对 PDF 进行 OCR')
  const index = await readKnowledgeIndex(root)
  const previous = index.documents[materialId]
  const hash = await hashFile(document.localPath)
  if (!previous || previous.hash !== hash) throw new Error('请先构建知识库，再对该 PDF 执行 OCR')
  onProgress?.({ completed: 0, total: 1, title: '正在准备本地 OCR…' })
  const ocr = await recognizePdf({
    filePath: document.localPath,
    cachePath,
    onProgress,
  })
  if (!ocr.text.trim()) throw new Error('OCR 未识别到可用文字，请检查扫描件清晰度')
  const record = {
    ...previous,
    title: document.title,
    courseId: document.courseId,
    courseName: document.courseName,
    localPath: document.localPath,
    hash,
    status: 'ocr',
    error: undefined,
    parserVersion: PARSER_VERSION,
    knowledgeRole: knowledgeRoleOf(document),
    text: ocr.text,
    textLength: ocr.text.length,
    outline: buildFilteredOutline(ocr.text, document),
    ocr: { pages: ocr.pages, totalPages: ocr.totalPages, language: ocr.language, truncated: ocr.truncated, completedAt: new Date().toISOString() },
  }
  index.documents[materialId] = record
  const active = activeRecords(index, documents)
  index.concepts = buildStrictConcepts(active)
  await writeKnowledgeIndex(root, index)
  return resultFromRecords(active, index.concepts)
}

async function ocrKnowledgeDocuments({ root, documents, materialIds, cachePath, onProgress }) {
  const ids = [...new Set((Array.isArray(materialIds) ? materialIds : []).filter((id) => typeof id === 'string'))]
  if (!ids.length) return knowledgeStatus(root, documents)
  let result = await knowledgeStatus(root, documents)
  const failed = []
  for (let position = 0; position < ids.length; position += 1) {
    const materialId = ids[position]
    try {
      result = await ocrKnowledgeDocument({
        root,
        documents,
        materialId,
        cachePath,
        onProgress: (progress) => {
          const fraction = progress.total > 0 ? progress.completed / progress.total : 0
          onProgress?.({ completed: Math.min(ids.length, position + fraction), total: ids.length, title: progress.title || '正在完成 OCR…' })
        },
      })
    } catch (error) {
      failed.push({ materialId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  onProgress?.({ completed: ids.length, total: ids.length, title: '' })
  return { ...result, batch: { completed: ids.length - failed.length, failed } }
}

async function refineKnowledgeDocument({ root, documents, materialId, refine, onProgress, force = false }) {
  const document = requestedDocument(documents, materialId)
  if (!document) throw new Error('找不到需要 AI 精炼的资料')
  const index = await readKnowledgeIndex(root)
  const previous = index.documents[materialId]
  if (!previous || !['parsed', 'ocr'].includes(previous.status) || !previous.text?.trim()) throw new Error('请先完成资料解析或 OCR，再进行 AI 精炼')
  const sourceHash = previous.hash || await hashFile(document.localPath)
  if (!force && previous.ai?.sourceHash === sourceHash) throw new Error('该资料已经使用当前资料内容完成 AI 精炼；如需替换结果，请选择“重新 AI 精炼”')
  onProgress?.({ completed: 0, total: 1, title: '正在校验本地解析结果…' })
  onProgress?.({ completed: 0, total: 1, title: '正在整理已提取文本（不会上传原始文件）…' })
  onProgress?.({ completed: 0, total: 1, title: '正在请求云端 AI 生成知识点…' })
  const generated = await refine({
    title: document.title,
    courseName: document.courseName,
    outline: previous.outline ?? [],
    text: previous.text,
  })
  onProgress?.({ completed: 0, total: 1, title: '正在校验 AI 返回内容并更新课程知识点…' })
  const record = {
    ...previous,
    title: document.title,
    courseId: document.courseId,
    courseName: document.courseName,
    localPath: document.localPath,
    knowledgeRole: knowledgeRoleOf(document),
    ai: {
      summary: generated.summary,
      concepts: generated.concepts,
      model: generated.model,
      generatedAt: new Date().toISOString(),
      sourceHash,
    },
  }
  index.documents[materialId] = record
  const active = activeRecords(index, documents)
  index.concepts = buildStrictConcepts(active)
  await writeKnowledgeIndex(root, index)
  onProgress?.({ completed: 1, total: 1, title: '' })
  return resultFromRecords(active, index.concepts)
}

async function refineKnowledgeDocuments({ root, documents, materialIds, refine, onProgress }) {
  const ids = [...new Set((Array.isArray(materialIds) ? materialIds : []).filter((id) => typeof id === 'string'))]
  if (!ids.length) return knowledgeStatus(root, documents)
  let result = await knowledgeStatus(root, documents)
  const failed = []
  for (let position = 0; position < ids.length; position += 1) {
    const materialId = ids[position]
    try {
      result = await refineKnowledgeDocument({
        root,
        documents,
        materialId,
        refine,
        onProgress: (progress) => {
          const fraction = progress.total > 0 ? progress.completed / progress.total : 0
          onProgress?.({ completed: Math.min(ids.length, position + fraction), total: ids.length, title: progress.title || '正在完成 AI 精炼…' })
        },
      })
    } catch (error) {
      failed.push({ materialId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  onProgress?.({ completed: ids.length, total: ids.length, title: '' })
  return { ...result, batch: { completed: ids.length - failed.length, failed } }
}

async function refreshRelocatedDocumentRecords(root, index, documents) {
  const list = Array.isArray(documents)
    ? documents.filter((document) => document && typeof document.materialId === 'string' && typeof document.localPath === 'string' && document.localPath)
    : []
  let changed = false

  for (const document of list) {
    const previous = index.documents[document.materialId]
    if (!previous) continue

    // “修复已缓存文件”会把旧的无扩展名路径改为 .pdf/.pptx。
    // 旧索引中的 unsupported 记录不能继续覆盖这个已修复的真实文件。
    const pathChanged = previous.localPath !== document.localPath
    const retryUnsupported = previous.status === 'unsupported' && await hasSupportedDocumentFormat(document)
    if (!pathChanged && !retryUnsupported) continue

    try {
      const parsed = await parseDocument(document)
      index.documents[document.materialId] = {
        materialId: document.materialId,
        courseId: document.courseId,
        courseName: document.courseName,
        title: document.title,
        localPath: document.localPath,
        parsedAt: new Date().toISOString(),
        ...parsed,
      }
    } catch (error) {
      index.documents[document.materialId] = {
        materialId: document.materialId,
        courseId: document.courseId,
        courseName: document.courseName,
        title: document.title,
        localPath: document.localPath,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        parsedAt: new Date().toISOString(),
      }
    }
    changed = true
  }

  if (changed) {
    index.concepts = buildStrictConcepts(Object.values(index.documents))
    await writeKnowledgeIndex(root, index)
  }
  return changed
}

async function knowledgeStatus(root, documents) {
  const index = await readKnowledgeIndex(root)
  await refreshRelocatedDocumentRecords(root, index, documents)
  const active = activeRecords(index, documents)
  const concepts = buildStrictConcepts(active)
  return resultFromRecords(active, concepts)
}

async function readKnowledgeDocumentContent({ root, documents, materialId }) {
  const document = requestedDocument(documents, materialId)
  if (!document) throw new Error('找不到需要阅读的资料')
  const index = await readKnowledgeIndex(root)
  const record = index.documents[materialId]
  if (!record || !['parsed', 'ocr'].includes(record.status) || !record.text?.trim()) throw new Error('这份资料尚未解析出可阅读文本；请先构建知识库或执行 OCR')
  return {
    materialId,
    title: document.title,
    courseName: document.courseName,
    format: record.format ?? path.extname(document.localPath).slice(1),
    text: record.text.slice(0, MAX_TEXT_LENGTH),
    textLength: record.textLength ?? record.text.length,
  }
}

module.exports = { buildKnowledgeIndex, extractLocalDocumentText, knowledgeStatus, ocrKnowledgeDocument, ocrKnowledgeDocuments, refineKnowledgeDocument, refineKnowledgeDocuments, readKnowledgeDocumentContent, toConceptTitle }
