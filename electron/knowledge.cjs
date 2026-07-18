const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const JSZip = require('jszip')
const CFB = require('cfb')
const { recognizePdf } = require('./ocr.cjs')
const { PAGE_INDEX_VERSION, applyLocationOverrides, buildPageCards, cloudRangesForConcept, localPageMapping, locationSignature, mergeLocations, pageCardForCloud } = require('./page-index.cjs')

const MAX_PARSE_BYTES = 80 * 1024 * 1024
const MAX_PDF_PARSE_BYTES = 220 * 1024 * 1024
const MAX_TEXT_LENGTH = 2_000_000
const PARSER_VERSION = 9
const MAX_OUTLINE_ITEMS = 12

function indexPath(root) {
  return path.join(root, '.xuejing', 'knowledge-index.json')
}

async function readKnowledgeIndex(root) {
  try {
    const parsed = JSON.parse(await fsp.readFile(indexPath(root), 'utf8'))
    return { version: PARSER_VERSION, documents: parsed.documents && typeof parsed.documents === 'object' ? parsed.documents : {}, concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [], courseConceptAliases: parsed.courseConceptAliases && typeof parsed.courseConceptAliases === 'object' ? parsed.courseConceptAliases : {} }
  } catch {
    return { version: PARSER_VERSION, documents: {}, concepts: [], courseConceptAliases: {} }
  }
}

async function writeKnowledgeIndex(root, index) {
  const destination = indexPath(root)
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  await fsp.writeFile(destination, JSON.stringify({ ...index, version: PARSER_VERSION, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
}

function invalidateCourseAliases(index, courseId) {
  if (!courseId || !index.courseConceptAliases || !Object.hasOwn(index.courseConceptAliases, courseId)) return
  delete index.courseConceptAliases[courseId]
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
    const text = fragments.join('\n').trim()
    const slideNumber = Number(name.match(/slide(\d+)/i)?.[1]) || slides.length + 1
    if (text) slides.push({ kind: 'pptx-slide', start: slideNumber, end: slideNumber, text })
  }
  return { text: slides.map((slide) => slide.text).join('\n'), segments: slides }
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
  let textLength = 0
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const lines = []
    let current = []
    let currentY = null
    for (const item of content.items) {
      const value = cleanLine(String(item?.str ?? ''))
      if (!value) continue
      const y = Number(item?.transform?.[5])
      if (current.length && Number.isFinite(y) && Number.isFinite(currentY) && Math.abs(y - currentY) > 2.5) {
        lines.push(current.join(' '))
        current = []
      }
      current.push(value)
      if (Number.isFinite(y)) currentY = y
      if (item?.hasEOL) {
        lines.push(current.join(' '))
        current = []
        currentY = null
      }
    }
    if (current.length) lines.push(current.join(' '))
    const text = lines.map(cleanLine).filter(Boolean).join('\n').trim()
    if (text) {
      pages.push({ kind: 'pdf-page', start: pageNumber, end: pageNumber, text })
      textLength += text.length
    }
    if (textLength >= MAX_TEXT_LENGTH) break
  }
  const chromeCounts = new Map()
  for (const page of pages) {
    const lines = page.text.split(/\n+/).map(cleanLine).filter(Boolean)
    for (const line of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      const key = line.toLocaleLowerCase().replace(/\d+/g, '#')
      if (key.length >= 3 && key.length <= 120) chromeCounts.set(key, (chromeCounts.get(key) ?? 0) + 1)
    }
  }
  const repeatedChrome = new Set([...chromeCounts].filter(([, count]) => count >= 3 && count / Math.max(1, pages.length) >= 0.28).map(([key]) => key))
  const cleanedPages = pages.map((page) => ({ ...page, text: page.text.split(/\n+/).map(cleanLine).filter((line) => !repeatedChrome.has(line.toLocaleLowerCase().replace(/\d+/g, '#'))).join('\n') })).filter((page) => page.text.trim())
  return { text: cleanedPages.map((item) => item.text).join('\n'), segments: cleanedPages }
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
  return value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/gu, '$1').replace(/\s+([，。；：？！、])/gu, '$1').trim()
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
    .replace(/^[Ø•◦▪▫◆◇]+\s*/u, '')
    .replace(/^[\s•▪◼◆◇■□*+\-–—·]+/u, '')
    .replace(/^(?:chapter|ch\.?)\s*\d+\s*[:：.、\-–—]?\s*/i, '')
    .replace(/^第\s*\d+\s*[章节]\s*[:：.、\-–—]?\s*/u, '')
    .replace(/\b(?:lecturer|instructor|teacher|prof(?:essor)?|teaching assistant)\s*[:：].*$/i, '')
    .replace(/(?:授课教师|授课老师|教师|老师)\s*[:：].*$/u, '')
    .replace(/\s*\(?\d+\s*\/\s*\d+\)?\s*$/, '')
    .replace(/\s+(?:page|slide)\s*\d+\s*$/i, '')
    .replace(/^n\s+(?=[A-Z][a-z])/u, '')
    .trim()

  line = line
    .replace(/^\s*\d+\s+(?=(?:chapter|ch\.?|part|outline|summary)\b)/i, '')
    .replace(/^\.\s*\d+\s+/, '')
    .replace(/^\d+\s+(?=[A-Za-z])/, '')
    .replace(/^\d+(?:\.\d+)*\.\s+(?=[A-Za-z\u3400-\u9fff])/, '')
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
    else return ''
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
  if (/^(?:example|solution\s+of\s+example|exercise|例\s*\d+|例题|习题)\b/iu.test(line)) return true
  if (/^(?:series|summary|introduction|overview|conclusion)$/i.test(line)) return true
  if (/^(?:print|enter|approximate\b|aside\b|part\s+[ivxlcdm]+\b)/i.test(line)) return true
  if (/^(?:difference|differences|comparison|solution|result)s?\s*:?s*$/i.test(line)) return true
  if (/^(?:思考题|理解题|复习题|练习题|讨论题|问题与思考)$/u.test(line)) return true
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
  if (words.length <= 5) return false
  return /\b(?:i|you|we|they|it|this|that|is|are|was|were|be|can|will|should|created|expressed|determine|don'?t|doesn'?t)\b/i.test(value) || /[.?!]$/.test(value.trim())
}

function isFormulaFragment(value) {
  const line = cleanLine(value)
  if (/^=|=$/.test(line)) return true
  if (/[∅∈]/u.test(line)) return true
  if (/^[\[({%].*\b(?:which|where|also|is|are)\b/i.test(line)) return true
  if (/^[\d\s,.;:+\-*/=<>%()[\]{}]+$/u.test(line)) return true
  if (/^[\d\s,.;:+\-*/=<>%()[\]{}]*else\b/i.test(line)) return true
  if (/^\d+\s*%?\s+(?:can|is|are|=)/i.test(line)) return true
  if (/=$/.test(line) && (line.match(/[\p{L}]/gu) ?? []).length < 5) return true
  if (/[π∑∫√∞≈≠≤≥]/u.test(line) && (line.match(/[\p{L}]/gu) ?? []).length < 10) return true
  if (/^(?:sin|cos|tan|exp)\b/i.test(line) && /[\d/()π𝜋]/u.test(line)) return true
  return false
}

function toConceptTitle(value, courseName = '') {
  const line = stripCourseChrome(value, courseName)
  if (line.length < 3 || line.length > 96 || isStructuralNoise(line) || isFormulaFragment(line) || !hasEnoughMeaningfulText(line)) return ''
  if (/\b(?:def|class)\s+[A-Za-z_]\w*\s*(?:\(|:)/.test(line)) return ''
  if (/\b(?:big\s+idea|you\s+try|any\s+questions?|next\s+week)\b/i.test(line)) return ''
  if (/^[a-z]{2,}\b/.test(line)) return ''
  if (/\b(?:which\s+(?:is|are)|is\s+also)\b/i.test(line)) return ''
  if (/\b(?:of|and|or|for|to|the|a|an|as)\s*$/i.test(line)) return ''
  if (/^(?:of|and|or|for|to|the)\b/i.test(line)) return ''
  if (/[:：]$/u.test(line)) return ''
  if (/[。？！?]$/u.test(line) && line.length > 28) return ''
  if (/[?？]$/u.test(line)) return ''
  if (/[。！!]$/u.test(line) && line.length > 14) return ''
  if (line.length > 42 && /[\u3400-\u9fff]/u.test(line) && /[，,]|(?:主张|因此|因为|认为|获得|保持|问题)/u.test(line)) return ''
  if (isSentenceLikeEnglish(line)) return ''
  return line
}

function conceptTokens(value) {
  const normalized = cleanLine(String(value ?? '')).toLocaleLowerCase()
    .replace(/properties\b/g, 'property')
    .replace(/systems\b/g, 'system')
    .replace(/signals\b/g, 'signal')
    .replace(/transforms\b/g, 'transform')
    .replace(/equations\b/g, 'equation')
    .replace(/[()（）\[\]{}:：,，.。/\\\-–—_]+/g, ' ')
  return normalized.split(/\s+/).filter((token) => token && !['the', 'of', 'and', 'for', 'to', 'a', 'an', '与', '和', '的'].includes(token))
}

function conceptFingerprint(value) {
  const tokens = conceptTokens(value)
  if (!tokens.length) return ''
  const chinese = tokens.filter((token) => /[\u3400-\u9fff]/u.test(token))
  return chinese.length ? tokens.join('') : [...new Set(tokens)].sort().join(' ')
}

function conceptTitlesSimilar(left, right) {
  const leftKey = conceptFingerprint(left)
  const rightKey = conceptFingerprint(right)
  if (!leftKey || !rightKey) return false
  if (leftKey === rightKey) return true
  const leftTokens = new Set(conceptTokens(left))
  const rightTokens = new Set(conceptTokens(right))
  if (!leftTokens.size || !rightTokens.size) return false
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length
  const union = new Set([...leftTokens, ...rightTokens]).size
  return overlap >= 2 && overlap / union >= 0.86
}

function buildFilteredOutline(text, document, segments = []) {
  const courseName = document?.courseName ?? ''
  const title = toConceptTitle(String(document?.title ?? '').replace(/\.(?:pdf|pptx|ppt|docx|tex|latex)$/i, ''), courseName)
  const rawCandidates = String(text).split(/\r?\n/)
  for (const segment of Array.isArray(segments) ? segments : []) rawCandidates.push(...String(segment?.text ?? '').split(/\r?\n/).slice(0, 5))
  const candidates = title ? [title, ...rawCandidates] : rawCandidates
  const ranked = new Map()
  for (let index = 0; index < candidates.length; index += 1) {
    const raw = candidates[index]
    const line = toConceptTitle(raw, courseName)
    const key = conceptFingerprint(line)
    if (!line || !key) continue
    const existing = ranked.get(key)
    const rawLine = cleanLine(String(raw))
    const heading = /^(?:(?:chapter|ch\.?|section|part)\s*\d+|第\s*\d+\s*[章节]|\d+(?:\.\d+){0,3}\s+)/iu.test(rawLine)
    const compact = line.length <= 55
    const score = (index === 0 && title === line ? 60 : 0) + (heading ? 18 : 0) + (compact ? 8 : 0) + Math.min(12, existing?.occurrences ?? 0)
    if (existing) {
      existing.occurrences += 1
      existing.score = Math.max(existing.score, score) + 2
    } else ranked.set(key, { title: line, score, occurrences: 1, index })
  }
  return [...ranked.values()].sort((left, right) => right.score - left.score || right.occurrences - left.occurrences || left.index - right.index).slice(0, MAX_OUTLINE_ITEMS).map((item) => item.title)
}

function resolveCourseAlias(courseAliases, courseId, originalTitle, courseName) {
  const stored = courseAliases?.[courseId]
  const groups = Array.isArray(stored) ? stored : Array.isArray(stored?.groups) ? stored.groups : []
  const key = cleanLine(originalTitle).toLocaleLowerCase()
  const group = groups.find((item) => [item?.canonical, ...(Array.isArray(item?.aliases) ? item.aliases : [])].some((title) => cleanLine(String(title ?? '')).toLocaleLowerCase() === key))
  if (!group) return { title: originalTitle, aliases: [] }
  const title = toConceptTitle(group.canonical, courseName) || originalTitle
  const aliases = [...new Set((Array.isArray(group.aliases) ? group.aliases : []).map((alias) => toConceptTitle(alias, courseName)).filter(Boolean))]
  return { title, aliases }
}

function buildStrictConcepts(documents, courseAliases = {}) {
  const concepts = []
  for (const document of documents) {
    if (!['parsed', 'ocr'].includes(document.status) || knowledgeRoleOf(document) !== 'courseware') continue
    const refinedConcepts = Array.isArray(document.ai?.concepts) && document.ai.concepts.length ? document.ai.concepts : null
    const candidates = refinedConcepts ?? (document.outlineLocations ?? (document.outline ?? []).map((title) => ({ title, locations: [] })))
    for (const candidate of candidates) {
      const rawTitle = candidate.title
      const originalTitle = toConceptTitle(rawTitle, document.courseName)
      const resolved = resolveCourseAlias(courseAliases, document.courseId, originalTitle, document.courseName)
      const title = resolved.title
      const key = conceptFingerprint(title)
      if (!title || !key) continue
      const legacyKey = originalTitle.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
      const existing = concepts.find((concept) => concept.courseIds.includes(document.courseId) && conceptTitlesSimilar(concept.title, title)) ?? { id: conceptId(legacyKey), title, aliases: [], sourceIds: [], courseIds: [], locations: [] }
      if (!concepts.includes(existing)) concepts.push(existing)
      for (const alias of [originalTitle, ...resolved.aliases]) {
        if (alias && existing.title !== alias && !existing.aliases.includes(alias)) existing.aliases.push(alias)
      }
      if (!existing.sourceIds.includes(document.materialId)) existing.sourceIds.push(document.materialId)
      if (document.courseId && !existing.courseIds.includes(document.courseId)) existing.courseIds.push(document.courseId)
      for (const location of Array.isArray(candidate.locations) ? candidate.locations : []) {
        if (!existing.locations.some((current) => current.materialId === location.materialId && current.kind === location.kind && current.start === location.start && current.end === location.end)) existing.locations.push(location)
      }
    }
  }
  return concepts.sort((a, b) => b.sourceIds.length - a.sourceIds.length || a.title.localeCompare(b.title, 'zh-CN'))
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
  const namedExtension = extensionOf(document)
  const sizeLimit = namedExtension === '.pdf' ? MAX_PDF_PARSE_BYTES : MAX_PARSE_BYTES
  if (stat.size > sizeLimit) return { status: 'skipped', error: `文件超过 ${Math.round(sizeLimit / 1024 / 1024)} MB，暂未自动解析`, hash: await hashFile(document.localPath) }
  const hash = await hashFile(document.localPath)
  const buffer = await fsp.readFile(document.localPath)
  const extension = namedExtension || extensionFromBuffer(buffer)
  if (!isSupportedParserExtension(extension)) return { status: 'unsupported', error: '当前支持 PDF、PPT/PPTX、DOCX 与 LaTeX（.tex）文本提取', hash }
  const extracted = extension === '.pdf' ? await extractPdf(buffer)
    : extension === '.pptx' ? await extractPptx(buffer)
      : extension === '.docx' ? await extractDocx(buffer)
        : extension === '.ppt' ? extractLegacyPpt(buffer)
          : extractLatex(buffer)
  const text = typeof extracted === 'string' ? extracted : extracted.text
  const segments = typeof extracted === 'string' ? [] : extracted.segments
  const trimmedText = text.slice(0, MAX_TEXT_LENGTH)
  if (!trimmedText.trim()) return { status: extension === '.pdf' ? 'image' : 'empty', error: extension === '.pdf' ? '图片型 PDF，等待本地 OCR 支持' : '未从文件中提取到可用文本', hash, text: '' }
  const outline = buildFilteredOutline(trimmedText, document, segments)
  const outlineLocations = outline.map((title) => ({ title, locations: locateConcept({ title, evidence: title }, segments, document.materialId) }))
  return { status: 'parsed', hash, format: extension.slice(1), text: trimmedText, segments, textLength: trimmedText.length, parserVersion: PARSER_VERSION, knowledgeRole: knowledgeRoleOf(document), outline, outlineLocations }
}

async function extractLocalDocumentText(document) {
  const parsed = await parseDocument({ ...document, knowledgeRole: 'reference' })
  if (parsed.status !== 'parsed' || !parsed.text?.trim()) {
    throw new Error(parsed.error || '未能从作业文件中提取可用文本')
  }
  return { text: parsed.text, format: parsed.format ?? '' }
}

function publicDocument(record) {
  const { text, segments, aiVersionHistory, ...rest } = record
  return { ...rest, segmentCount: Array.isArray(segments) ? segments.length : 0 }
}

function normalizedLocationText(value) {
  return cleanLine(String(value ?? '')).toLocaleLowerCase().replace(/\s+/g, '')
}

function locationTokens(value) {
  const source = cleanLine(String(value ?? '')).toLocaleLowerCase()
  const tokens = new Set(source.match(/[a-z][a-z0-9-]{2,}/g) ?? [])
  for (const sequence of source.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    if (sequence.length <= 4) tokens.add(sequence)
    for (let index = 0; index < sequence.length - 1; index += 1) tokens.add(sequence.slice(index, index + 2))
  }
  return tokens
}

function locateInSegments(concept, segments, materialId) {
  if (!segments.length) return []
  const evidence = normalizedLocationText(concept.evidence)
  const title = normalizedLocationText(concept.title)
  const queryTokens = locationTokens(`${concept.title ?? ''} ${concept.evidence ?? ''}`)
  const scored = segments.map((segment) => {
    const normalized = normalizedLocationText(segment.text)
    let score = 0
    if (evidence.length >= 4 && normalized.includes(evidence)) score = 0.99
    else if (title.length >= 3 && normalized.includes(title)) score = 0.9
    else if (queryTokens.size) {
      const segmentTokens = locationTokens(segment.text)
      const overlap = [...queryTokens].filter((token) => segmentTokens.has(token)).length
      score = overlap / queryTokens.size * 0.82
    }
    return { segment, score }
  }).filter((entry) => entry.score >= 0.34)
  if (!scored.length) return []
  const bestScore = Math.max(...scored.map((entry) => entry.score))
  const candidates = scored.filter((entry) => entry.score >= Math.max(0.34, bestScore * 0.58)).sort((left, right) => left.segment.start - right.segment.start)
  const clusters = []
  for (const entry of candidates) {
    const end = entry.segment.end ?? entry.segment.start
    const current = clusters.at(-1)
    if (current && current.kind === entry.segment.kind && entry.segment.start <= current.end + 2) {
      current.end = Math.max(current.end, end)
      current.score = Math.max(current.score, entry.score)
      current.matches += 1
    } else {
      clusters.push({ kind: entry.segment.kind, start: entry.segment.start, end, score: entry.score, matches: 1 })
    }
  }
  return clusters.sort((left, right) => right.score - left.score || right.matches - left.matches || left.start - right.start).slice(0, 3).sort((left, right) => left.start - right.start).map((cluster) => ({
    materialId,
    kind: cluster.kind,
    start: cluster.start,
    end: cluster.end,
    confidence: Number(cluster.score.toFixed(2)),
    evidence: String(concept.evidence ?? '').slice(0, 240),
  }))
}

function locateConcept(concept, segments, materialId) {
  if (!Array.isArray(segments) || !segments.length) return []
  const hinted = []
  for (const hint of Array.isArray(concept.locationHints) ? concept.locationHints : []) {
    const start = Number(hint?.start)
    const end = Number(hint?.end ?? start)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue
    const scope = segments.filter((segment) => segment.kind === hint.kind && segment.start >= start && (segment.end ?? segment.start) <= end)
    hinted.push(...locateInSegments(concept, scope, materialId))
  }
  const uniqueHints = hinted.filter((location, index) => hinted.findIndex((other) => other.kind === location.kind && other.start === location.start && other.end === location.end) === index)
  return uniqueHints.length ? uniqueHints : locateInSegments(concept, segments, materialId)
}

function attachConceptLocations(ai, segments, materialId) {
  if (!ai || !Array.isArray(ai.concepts)) return ai
  return { ...ai, concepts: ai.concepts.map((concept) => {
    const { locationHints, ...stored } = concept
    if (stored.locations?.length || stored.locationCandidates?.length) {
      return {
        ...stored,
        locations: (stored.locations ?? []).map((location) => ({ ...location, materialId })),
        locationCandidates: (stored.locationCandidates ?? []).map((location) => ({ ...location, materialId })),
      }
    }
    if (ai.pageIndex) {
      return {
        ...stored,
        locations: (stored.locations ?? []).map((location) => ({ ...location, materialId })),
        locationCandidates: (stored.locationCandidates ?? []).map((location) => ({ ...location, materialId })),
      }
    }
    return { ...stored, locations: locateConcept(concept, segments, materialId) }
  }) }
}

function aiStateSnapshot(record) {
  if (!record?.hash || (!record.ai && !record.aiProfiles)) return null
  return {
    hash: record.hash,
    ai: record.ai,
    aiProfiles: record.aiProfiles,
    pageLocationOverrides: record.pageLocationOverrides,
  }
}

function preserveAiState(previous, parsed, materialId) {
  if (!previous || !['parsed', 'ocr'].includes(parsed.status)) return {}
  const aiVersionHistory = { ...(previous.aiVersionHistory ?? {}) }
  const snapshot = aiStateSnapshot(previous)
  if (snapshot) aiVersionHistory[snapshot.hash] = snapshot
  const source = previous.hash === parsed.hash ? previous : aiVersionHistory[parsed.hash]
  if (!source) return Object.keys(aiVersionHistory).length ? { aiVersionHistory } : {}

  const aiProfiles = {}
  for (const mode of ['quick', 'deep', 'original']) {
    const profile = source.aiProfiles?.[mode]
    if (!profile || (profile.sourceHash && profile.sourceHash !== parsed.hash)) continue
    aiProfiles[mode] = attachConceptLocations({ ...profile, mode, sourceHash: profile.sourceHash ?? parsed.hash }, parsed.segments, materialId)
  }

  const legacy = source.ai
  if (legacy && (!legacy.sourceHash || legacy.sourceHash === parsed.hash)) {
    const legacyMode = legacy.mode === 'original' ? 'original' : legacy.mode ?? (legacy.locationBatches ? 'deep' : 'quick')
    if (!aiProfiles[legacyMode]) aiProfiles[legacyMode] = attachConceptLocations({ ...legacy, mode: legacyMode, sourceHash: legacy.sourceHash ?? parsed.hash }, parsed.segments, materialId)
  }

  const active = aiProfiles.original ?? aiProfiles.deep ?? aiProfiles.quick
  return {
    ...(active ? { ai: active } : {}),
    ...(Object.keys(aiProfiles).length ? { aiProfiles } : {}),
    ...(source.pageLocationOverrides ? { pageLocationOverrides: source.pageLocationOverrides } : {}),
    ...(Object.keys(aiVersionHistory).length ? { aiVersionHistory } : {}),
  }
}

function activeRecords(index, documents) {
  const requested = new Map((Array.isArray(documents) ? documents : []).filter((document) => document?.materialId).map((document) => [document.materialId, document]))
  return Object.values(index.documents)
    .filter((document) => !requested.size || requested.has(document.materialId))
    .map((record) => {
      const document = requested.get(record.materialId)
      return document ? { ...record, title: document.title, courseId: document.courseId, courseName: document.courseName, localPath: document.localPath, sourceUrl: document.sourceUrl, knowledgeRole: knowledgeRoleOf(document) } : record
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
        record = { ...previous, title: document.title, courseId: document.courseId, courseName: document.courseName, sourceUrl: document.sourceUrl, knowledgeRole: knowledgeRoleOf(document), reused: true }
      } else {
        const parsed = await parseDocument(document)
        const preservedAiState = preserveAiState(previous, parsed, document.materialId)
        record = {
          materialId: document.materialId,
          courseId: document.courseId,
          courseName: document.courseName,
          title: document.title,
          localPath: document.localPath,
          sourceUrl: document.sourceUrl,
          parsedAt: new Date().toISOString(),
          ...parsed,
          ...preservedAiState,
        }
      }
      index.documents[document.materialId] = record
      if (!record.reused) invalidateCourseAliases(index, document.courseId)
      active.push(record)
    } catch (error) {
      const record = { materialId: document.materialId, courseId: document.courseId, courseName: document.courseName, title: document.title, localPath: document.localPath, status: 'failed', error: error instanceof Error ? error.message : String(error), parsedAt: new Date().toISOString() }
      index.documents[document.materialId] = record
      invalidateCourseAliases(index, document.courseId)
      active.push(record)
    }
  }
  index.concepts = buildStrictConcepts(active, index.courseConceptAliases)
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
    segments: (ocr.segments ?? []).map((segment) => ({ kind: 'pdf-page', start: segment.page, end: segment.page, text: segment.text })),
    textLength: ocr.text.length,
    outline: buildFilteredOutline(ocr.text, document, (ocr.segments ?? []).map((segment) => ({ kind: 'pdf-page', start: segment.page, end: segment.page, text: segment.text }))),
    ocr: { pages: ocr.pages, totalPages: ocr.totalPages, language: ocr.language, truncated: ocr.truncated, completedAt: new Date().toISOString() },
  }
  record.outlineLocations = record.outline.map((title) => ({ title, locations: locateConcept({ title, evidence: title }, record.segments, document.materialId) }))
  index.documents[materialId] = record
  invalidateCourseAliases(index, document.courseId)
  const active = activeRecords(index, documents)
  index.concepts = buildStrictConcepts(active, index.courseConceptAliases)
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
  if (knowledgeRoleOf(document) === 'reference') throw new Error('教材和参考资料只进行本地解析与搜索，不参与 AI 知识点精炼')
  const sourceHash = previous.hash || await hashFile(document.localPath)
  if (!force && previous.ai?.sourceHash === sourceHash) throw new Error('该资料已经使用当前资料内容完成 AI 精炼；如需替换结果，请选择“重新 AI 精炼”')
  onProgress?.({ completed: 0, total: 1, title: '正在校验本地资料与解析结果…' })
  const generated = await refine({
    materialId: document.materialId,
    title: document.title,
    courseName: document.courseName,
    localPath: document.localPath,
    type: document.type,
    hash: sourceHash,
    outline: previous.outline ?? [],
    text: previous.text,
    segments: previous.segments ?? [],
  }, (progress) => onProgress?.({ completed: progress.completed, total: progress.total, title: progress.title }))
  onProgress?.({ completed: 0, total: 1, title: '正在校验 AI 返回内容并更新课程知识点…' })
  const locatedConcepts = attachConceptLocations({ concepts: generated.concepts }, previous.segments, document.materialId).concepts
  const cards = buildPageCards(previous.segments ?? [])
  const profile = {
    summary: generated.summary,
    concepts: locatedConcepts,
    model: generated.model,
    generatedAt: new Date().toISOString(),
    sourceHash,
    mode: generated.mode === 'original' ? 'original' : generated.mode === 'quick' ? 'quick' : 'deep',
    locationBatches: generated.locationBatches ?? 0,
    coverage: generated.coverage,
    analysisMethod: generated.analysisMethod,
    inputStrategy: generated.inputStrategy,
    originalFile: generated.originalFile,
    ...(generated.mode === 'original' ? { pageIndex: pageIndexStats(locatedConcepts, cards, generated.model) } : {}),
  }
  const aiProfiles = { ...(previous.aiProfiles ?? {}) }
  const legacyMode = previous.ai?.mode === 'original' ? 'original' : previous.ai?.mode ?? (previous.ai?.locationBatches ? 'deep' : 'quick')
  if (previous.ai && !aiProfiles[legacyMode]) aiProfiles[legacyMode] = previous.ai
  aiProfiles[profile.mode] = profile
  const activeProfile = profile.mode === 'original' ? profile : profile.mode === 'quick' && aiProfiles.deep?.sourceHash === sourceHash ? aiProfiles.deep : profile
  const record = {
    ...previous,
    title: document.title,
    courseId: document.courseId,
    courseName: document.courseName,
    localPath: document.localPath,
    sourceUrl: document.sourceUrl,
    knowledgeRole: knowledgeRoleOf(document),
    ai: activeProfile,
    aiProfiles,
  }
  index.documents[materialId] = record
  invalidateCourseAliases(index, document.courseId)
  const active = activeRecords(index, documents)
  index.concepts = buildStrictConcepts(active, index.courseConceptAliases)
  await writeKnowledgeIndex(root, index)
  onProgress?.({ completed: 1, total: 1, title: '' })
  return resultFromRecords(active, index.concepts)
}

async function refineKnowledgeDocuments({ root, documents, materialIds, refine, onProgress, force = false }) {
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
        force,
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

function currentAiProfile(record) {
  const hash = record?.hash
  if (record?.aiProfiles?.original && (!record.aiProfiles.original.sourceHash || record.aiProfiles.original.sourceHash === hash)) return { mode: 'original', profile: record.aiProfiles.original }
  if (record?.aiProfiles?.deep && (!record.aiProfiles.deep.sourceHash || record.aiProfiles.deep.sourceHash === hash)) return { mode: 'deep', profile: record.aiProfiles.deep }
  if (record?.ai && (!record.ai.sourceHash || record.ai.sourceHash === hash)) return { mode: record.ai.mode ?? (record.ai.locationBatches ? 'deep' : 'quick'), profile: record.ai }
  if (record?.aiProfiles?.quick && (!record.aiProfiles.quick.sourceHash || record.aiProfiles.quick.sourceHash === hash)) return { mode: 'quick', profile: record.aiProfiles.quick }
  return null
}

function pageIndexStats(concepts, cards, model = '') {
  const source = Array.isArray(concepts) ? concepts : []
  return {
    version: PAGE_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    pages: cards.length,
    concepts: source.length,
    located: source.filter((concept) => concept.locations?.length).length,
    candidates: source.filter((concept) => concept.locationCandidates?.length).length,
    model,
  }
}

async function reindexKnowledgeDocument({ root, documents, materialId, mapPages, onProgress }) {
  const document = requestedDocument(documents, materialId)
  if (!document) throw new Error('找不到需要补全页级索引的资料')
  const index = await readKnowledgeIndex(root)
  const record = index.documents[materialId]
  const selected = currentAiProfile(record)
  if (!record || !['parsed', 'ocr'].includes(record.status) || !Array.isArray(record.segments) || !record.segments.length) throw new Error('该资料没有可用于页级索引的页面文本')
  if (!selected?.profile || !Array.isArray(selected.profile.concepts) || !selected.profile.concepts.length) throw new Error('请先完成 AI 精炼，再补全页级索引')

  const cards = buildPageCards(record.segments)
  const overrides = record.pageLocationOverrides ?? {}
  onProgress?.({ completed: 0, total: 2, title: '正在本地匹配标题、关键词和数学公式…' })
  let concepts = selected.profile.concepts.map((concept) => {
    const local = localPageMapping(concept, cards, materialId)
    const existingConfirmed = (concept.locations ?? []).filter((location) => Number(location.confidence ?? 0) >= 0.8 || location.manual)
    const existingCandidates = [
      ...(concept.locationCandidates ?? []),
      ...(concept.locations ?? []).filter((location) => Number(location.confidence ?? 0) < 0.8 && !location.manual).map((location) => ({ ...location, candidate: true })),
    ]
    return { ...concept, locations: mergeLocations([...existingConfirmed, ...local.locations]), locationCandidates: mergeLocations([...existingCandidates, ...local.candidates]) }
  })

  let mapperModel = ''
  let mapperError = ''
  if (typeof mapPages === 'function') {
    onProgress?.({ completed: 1, total: 2, title: '正在使用页面卡片补全跨语言章节范围…' })
    try {
      const mapped = await mapPages({
        materialId,
        title: document.title,
        courseName: document.courseName,
        concepts: concepts.map((concept) => ({ title: concept.title, evidence: concept.evidence })),
        cards: cards.map(pageCardForCloud),
      }, (progress) => onProgress?.({ completed: 1 + (progress.total ? progress.completed / progress.total : 0), total: 2, title: progress.title }))
      mapperModel = String(mapped?.model ?? '')
      const mappings = Array.isArray(mapped?.mappings) ? mapped.mappings : Array.isArray(mapped) ? mapped : []
      concepts = concepts.map((concept, conceptIndex) => {
        const cloud = cloudRangesForConcept(mappings.find((mapping) => Number(mapping.conceptIndex) === conceptIndex), cards, materialId)
        return { ...concept, locations: mergeLocations([...(concept.locations ?? []), ...cloud.locations]), locationCandidates: mergeLocations([...(concept.locationCandidates ?? []), ...cloud.candidates]) }
      })
    } catch (error) {
      mapperError = error instanceof Error ? error.message : String(error)
    }
  }

  concepts = concepts.map((concept) => applyLocationOverrides(concept, overrides[concept.title], materialId))
  const profile = { ...selected.profile, concepts, pageIndex: { ...pageIndexStats(concepts, cards, mapperModel), ...(mapperError ? { cloudError: mapperError } : {}) } }
  const aiProfiles = { ...(record.aiProfiles ?? {}), [selected.mode]: profile }
  const updated = { ...record, ai: profile, aiProfiles }
  index.documents[materialId] = updated
  const active = activeRecords(index, documents)
  index.concepts = buildStrictConcepts(active, index.courseConceptAliases)
  await writeKnowledgeIndex(root, index)
  onProgress?.({ completed: 2, total: 2, title: '' })
  return resultFromRecords(active, index.concepts)
}

async function reindexKnowledgeDocuments({ root, documents, materialIds, mapPages, onProgress }) {
  const ids = [...new Set((Array.isArray(materialIds) ? materialIds : []).filter((id) => typeof id === 'string'))]
  let result = await knowledgeStatus(root, documents)
  const failed = []
  for (let position = 0; position < ids.length; position += 1) {
    const materialId = ids[position]
    try {
      result = await reindexKnowledgeDocument({
        root,
        documents,
        materialId,
        mapPages,
        onProgress: (progress) => onProgress?.({ completed: position + (progress.total ? progress.completed / progress.total : 0), total: ids.length, title: progress.title }),
      })
    } catch (error) {
      failed.push({ materialId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  onProgress?.({ completed: ids.length, total: ids.length, title: '' })
  return { ...result, batch: { completed: ids.length - failed.length, failed } }
}

async function updateKnowledgePageLocation({ root, documents, materialId, conceptTitle, action, location }) {
  const document = requestedDocument(documents, materialId)
  if (!document) throw new Error('找不到需要修改页码的资料')
  const index = await readKnowledgeIndex(root)
  const record = index.documents[materialId]
  const selected = currentAiProfile(record)
  if (!selected?.profile) throw new Error('该资料没有可修改的 AI 知识点')
  const concept = selected.profile.concepts.find((item) => item.title === conceptTitle)
  if (!concept) throw new Error('找不到需要修改的知识点')
  const start = Number(location?.start)
  const end = Number(location?.end ?? start)
  const kind = typeof location?.kind === 'string' ? location.kind : record.segments?.[0]?.kind
  const validPages = new Set((record.segments ?? []).filter((segment) => segment.kind === kind).map((segment) => Number(segment.start)))
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || !validPages.has(start) || !validPages.has(end)) throw new Error('页码或幻灯片范围超出资料边界')
  const storedLocation = { materialId, kind, start, end, confidence: 1, method: 'manual', manual: true }
  const overrides = { ...(record.pageLocationOverrides ?? {}) }
  const current = { added: [...(overrides[conceptTitle]?.added ?? [])], removed: [...(overrides[conceptTitle]?.removed ?? [])] }
  const signature = locationSignature(storedLocation)
  if (action === 'add' || action === 'confirm') {
    current.removed = current.removed.filter((item) => locationSignature(item) !== signature)
    if (!current.added.some((item) => locationSignature(item) === signature)) current.added.push(storedLocation)
  } else if (action === 'remove' || action === 'reject') {
    current.added = current.added.filter((item) => locationSignature(item) !== signature)
    if (!current.removed.some((item) => locationSignature(item) === signature)) current.removed.push({ kind, start, end })
  } else throw new Error('不支持的页码修改操作')
  overrides[conceptTitle] = current
  const concepts = selected.profile.concepts.map((item) => applyLocationOverrides(item, overrides[item.title], materialId))
  const cards = buildPageCards(record.segments)
  const profile = { ...selected.profile, concepts, pageIndex: { ...pageIndexStats(concepts, cards, selected.profile.pageIndex?.model ?? ''), ...(selected.profile.pageIndex?.cloudError ? { cloudError: selected.profile.pageIndex.cloudError } : {}) } }
  const aiProfiles = { ...(record.aiProfiles ?? {}), [selected.mode]: profile }
  index.documents[materialId] = { ...record, ai: profile, aiProfiles, pageLocationOverrides: overrides }
  const active = activeRecords(index, documents)
  index.concepts = buildStrictConcepts(active, index.courseConceptAliases)
  await writeKnowledgeIndex(root, index)
  return resultFromRecords(active, index.concepts)
}

async function normalizeCourseKnowledgeConcepts({ root, documents, courseIds, normalize, onProgress }) {
  if (typeof normalize !== 'function') throw new Error('缺少课程知识点归并器')
  const index = await readKnowledgeIndex(root)
  const active = activeRecords(index, documents)
  const requestedCourseIds = new Set((Array.isArray(courseIds) ? courseIds : []).filter((courseId) => typeof courseId === 'string' && courseId))
  const rawConcepts = buildStrictConcepts(active)
  const documentMap = new Map(active.map((document) => [document.materialId, document]))
  const courses = [...new Set(active.map((document) => document.courseId).filter((courseId) => courseId && (!requestedCourseIds.size || requestedCourseIds.has(courseId))))].map((courseId) => {
    const courseDocuments = active.filter((document) => document.courseId === courseId)
    return {
      courseId,
      courseName: courseDocuments.find((document) => document.courseName)?.courseName ?? courseId,
      concepts: rawConcepts.filter((concept) => concept.courseIds.includes(courseId)).map((concept) => ({
        title: concept.title,
        sourceIds: concept.sourceIds,
        locations: concept.locations,
        summary: concept.sourceIds.map((sourceId) => documentMap.get(sourceId)?.ai?.summary).filter(Boolean).join('；').slice(0, 120),
      })),
    }
  }).filter((course) => course.concepts.length > 1)

  if (!courses.length) return resultFromRecords(active, buildStrictConcepts(active, index.courseConceptAliases))
  const normalized = await normalize(courses, onProgress)
  index.courseConceptAliases = { ...(index.courseConceptAliases ?? {}) }
  for (const course of Array.isArray(normalized) ? normalized : []) {
    if (!course?.courseId || (requestedCourseIds.size && !requestedCourseIds.has(course.courseId))) continue
    const groups = (Array.isArray(course.groups) ? course.groups : []).filter((group) => Number(group?.confidence) >= 0.86 && Array.isArray(group.aliases) && group.aliases.length >= 2)
    index.courseConceptAliases[course.courseId] = { model: course.model ?? '', generatedAt: new Date().toISOString(), groups }
  }
  index.concepts = buildStrictConcepts(active, index.courseConceptAliases)
  await writeKnowledgeIndex(root, index)
  return resultFromRecords(active, index.concepts)
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
      const preservedAiState = preserveAiState(previous, parsed, document.materialId)
      index.documents[document.materialId] = {
        materialId: document.materialId,
        courseId: document.courseId,
        courseName: document.courseName,
        title: document.title,
        localPath: document.localPath,
        parsedAt: new Date().toISOString(),
        ...parsed,
        knowledgeRole: knowledgeRoleOf(document),
        ...preservedAiState,
      }
      invalidateCourseAliases(index, document.courseId)
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
      invalidateCourseAliases(index, document.courseId)
    }
    changed = true
  }

  if (changed) {
    index.concepts = buildStrictConcepts(Object.values(index.documents), index.courseConceptAliases)
    await writeKnowledgeIndex(root, index)
  }
  return changed
}

async function knowledgeStatus(root, documents) {
  const index = await readKnowledgeIndex(root)
  await refreshRelocatedDocumentRecords(root, index, documents)
  const active = activeRecords(index, documents)
  const concepts = buildStrictConcepts(active, index.courseConceptAliases)
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

async function searchKnowledgeDocuments({ root, documents, query, limit = 20 }) {
  const textQuery = typeof query === 'string' ? query.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  if (textQuery.length < 2) return []
  const normalizedQuery = textQuery.toLocaleLowerCase()
  const tokens = normalizedQuery.split(' ').filter(Boolean)
  const index = await readKnowledgeIndex(root)
  const results = []
  for (const document of Array.isArray(documents) ? documents : []) {
    const record = index.documents[document.materialId]
    if (!record || !['parsed', 'ocr'].includes(record.status) || !record.text?.trim()) continue
    const searchable = `${document.title}\n${record.text}`.replace(/\s+/g, ' ').trim()
    const normalized = searchable.toLocaleLowerCase()
    if (!tokens.every((token) => normalized.includes(token))) continue
    const title = document.title.toLocaleLowerCase()
    const score = title === normalizedQuery ? 120 : title.startsWith(normalizedQuery) ? 100 : title.includes(normalizedQuery) ? 80 : 50
    const position = Math.max(0, normalized.indexOf(tokens[0]))
    const start = Math.max(0, position - 70)
    const end = Math.min(searchable.length, position + Math.max(tokens[0].length, 20) + 110)
    results.push({
      materialId: document.materialId,
      title: document.title,
      courseId: document.courseId,
      courseName: document.courseName,
      snippet: `${start > 0 ? '…' : ''}${searchable.slice(start, end)}${end < searchable.length ? '…' : ''}`,
      score,
    })
  }
  return results.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, 'zh-CN')).slice(0, Math.max(1, Math.min(50, Number(limit) || 20)))
}

module.exports = { buildKnowledgeIndex, extractLocalDocumentText, knowledgeStatus, normalizeCourseKnowledgeConcepts, ocrKnowledgeDocument, ocrKnowledgeDocuments, refineKnowledgeDocument, refineKnowledgeDocuments, reindexKnowledgeDocument, reindexKnowledgeDocuments, readKnowledgeDocumentContent, searchKnowledgeDocuments, toConceptTitle, updateKnowledgePageLocation }
