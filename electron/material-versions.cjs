const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const IMPORT_VERSION_PATTERN = /（导入版本\s+[^）]+）/g
const IMPORT_VERSION_MARKER = /（导入版本\s+[^）]+）/
let versionRecordCacheChain = Promise.resolve()

function clean(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function logicalFilename(value) {
  const filename = path.basename(String(value ?? '')).replace(IMPORT_VERSION_PATTERN, '').replace(/\s+/g, ' ').trim()
  return filename || '未命名资料'
}

function blackboardResourceId(value) {
  const raw = String(value ?? '')
  const rid = raw.match(/(?:content-rid-|\/xid-)(\d+)(?:_\d+)?/i)?.[1]
  if (rid) return `blackboard:${rid}`
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) if (/^(?:token|session|timestamp|ts|auth)$/i.test(key)) parsed.searchParams.delete(key)
    return parsed.toString()
  } catch {
    return raw
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function contentTokens(record) {
  const text = [record?.title, ...(record?.outline ?? []), ...(record?.segments ?? []).slice(0, 80).map((segment) => segment?.text)]
    .map(clean).join(' ').toLocaleLowerCase()
  const tokens = new Set(text.match(/[a-z][a-z0-9-]{2,}|[\u3400-\u9fff]{2,}/g) ?? [])
  for (const ignored of ['outline', 'summary', 'lecturer', 'course', 'chapter']) tokens.delete(ignored)
  return tokens
}

function contentSimilarity(left, right) {
  if (!left || !right) return 0
  if (left.hash && right.hash && left.hash === right.hash) return 1
  const a = contentTokens(left)
  const b = contentTokens(right)
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / Math.max(1, Math.min(a.size, b.size))
}

function partOrdinal(record) {
  const text = [record?.title, ...(record?.outline ?? []), ...(record?.segments ?? []).slice(0, 8).map((segment) => segment?.text)]
    .map(clean).join('\n')
  const match = text.match(/\bpart\s+([ivx]+|\d+)\b/i)
  if (!match) return ''
  return match[1].toLocaleUpperCase()
}

function hasStructuralConflict(records) {
  const ordinals = new Set(records.map(partOrdinal).filter(Boolean))
  return ordinals.size > 1
}

function materialDescriptor(record, bytes = 0) {
  const segments = Array.isArray(record?.segments) ? record.segments : []
  for (const segment of segments.slice(0, 6)) {
    const lines = String(segment?.text ?? '').split(/\r?\n/).map(clean).filter(Boolean)
    const part = lines.find((line) => /^\d*\s*part\s+[ivx]+\b/i.test(line))
    if (part) return part.replace(/^\d+\s*/, '').slice(0, 54)
  }
  const pages = Number(record?.segmentCount) || segments.length || 0
  if (pages) return `${pages} 页`
  return bytes ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : '同名资料'
}

function dateValue(value) {
  const time = new Date(value || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function buildVersionCatalogFromEntries({ documents, entries, records }) {
  const sourceDocuments = Array.isArray(documents) ? documents.filter((document) => document?.materialId && document?.localPath) : []
  const sourceEntries = Array.isArray(entries) ? entries.filter((entry) => entry?.canonicalPath && entry?.hash) : []
  const recordsByPath = new Map((Array.isArray(records) ? records : []).filter((record) => record?.localPath).map((record) => [path.resolve(record.localPath).toLocaleLowerCase(), record]))
  const recordsByHash = new Map((Array.isArray(records) ? records : []).filter((record) => record?.hash).map((record) => [String(record.hash).toLocaleLowerCase(), record]))
  const referenced = new Set(sourceDocuments.map((document) => path.resolve(document.localPath).toLocaleLowerCase()))
  const manifestPaths = new Set(sourceEntries.filter((entry) => !entry.orphan).map((entry) => path.resolve(entry.canonicalPath).toLocaleLowerCase()))
  const entryByPath = new Map(sourceEntries.map((entry) => [path.resolve(entry.canonicalPath).toLocaleLowerCase(), entry]))

  const groups = sourceDocuments.map((document) => {
    const activeKey = path.resolve(document.localPath).toLocaleLowerCase()
    const activeEntry = entryByPath.get(activeKey) ?? {
      canonicalPath: document.localPath,
      hash: document.hash ?? recordsByPath.get(activeKey)?.hash ?? '',
      importedAt: recordsByPath.get(activeKey)?.parsedAt ?? '',
      sourceUrl: document.sourceUrl,
      bytes: 0,
    }
    const sourceKey = blackboardResourceId(document.sourceUrl || activeEntry.sourceUrl)
    const baseName = logicalFilename(document.title || document.localPath)
    const directory = path.dirname(document.localPath).toLocaleLowerCase()
    const candidates = sourceEntries.filter((entry) => {
      const entrySource = blackboardResourceId(entry.sourceUrl)
      if (sourceKey) return entrySource === sourceKey
      return !entrySource && path.dirname(entry.canonicalPath).toLocaleLowerCase() === directory && logicalFilename(entry.canonicalPath).toLocaleLowerCase() === baseName.toLocaleLowerCase()
    })
    if (!candidates.some((entry) => path.resolve(entry.canonicalPath).toLocaleLowerCase() === activeKey)) candidates.push(activeEntry)

    const byHash = new Map()
    for (const entry of candidates) {
      const hash = String(entry.hash ?? '').toLocaleLowerCase()
      if (!hash) continue
      const current = byHash.get(hash)
      const currentActive = current && path.resolve(current.canonicalPath).toLocaleLowerCase() === activeKey
      const nextActive = path.resolve(entry.canonicalPath).toLocaleLowerCase() === activeKey
      if (!current || nextActive || (!currentActive && dateValue(entry.importedAt) > dateValue(current.importedAt))) byHash.set(hash, entry)
    }
    const uniqueEntries = [...byHash.values()].sort((left, right) => dateValue(right.importedAt) - dateValue(left.importedAt))
    const newest = uniqueEntries[0] ?? activeEntry
    const newestRecord = recordsByPath.get(path.resolve(newest.canonicalPath).toLocaleLowerCase()) ?? recordsByHash.get(String(newest.hash).toLocaleLowerCase())
    const candidateRecords = uniqueEntries.map((entry) => recordsByPath.get(path.resolve(entry.canonicalPath).toLocaleLowerCase()) ?? recordsByHash.get(String(entry.hash).toLocaleLowerCase()))
    const similarities = candidateRecords.slice(1).map((record) => contentSimilarity(newestRecord, record))
    const relation = uniqueEntries.length <= 1
      ? 'single'
      : hasStructuralConflict(candidateRecords)
        ? 'source-conflict'
        : similarities.every((similarity) => similarity >= 0.48)
          ? 'versions'
          : 'source-conflict'
    const versions = uniqueEntries.map((entry) => {
      const entryRecord = recordsByPath.get(path.resolve(entry.canonicalPath).toLocaleLowerCase()) ?? recordsByHash.get(String(entry.hash).toLocaleLowerCase())
      return {
        id: String(entry.hash),
        localPath: entry.canonicalPath,
        hash: String(entry.hash),
        importedAt: entry.importedAt ?? '',
        bytes: Number(entry.bytes) || 0,
        pages: Number(entryRecord?.segmentCount) || (Array.isArray(entryRecord?.segments) ? entryRecord.segments.length : 0),
        descriptor: materialDescriptor(entryRecord, Number(entry.bytes) || 0),
        current: path.resolve(entry.canonicalPath).toLocaleLowerCase() === activeKey,
      }
    })
    return {
      materialId: document.materialId,
      courseId: document.courseId,
      baseTitle: baseName,
      displayTitle: baseName,
      relation,
      activePath: document.localPath,
      recommendedPath: relation === 'versions' ? newest.canonicalPath : document.localPath,
      versions,
    }
  })

  const sameNames = new Map()
  for (const group of groups) {
    const key = `${group.courseId}|${group.baseTitle.toLocaleLowerCase()}`
    const values = sameNames.get(key) ?? []
    values.push(group)
    sameNames.set(key, values)
  }
  for (const siblings of sameNames.values()) {
    if (siblings.length < 2) continue
    for (const group of siblings) {
      const active = group.versions.find((version) => version.current) ?? group.versions[0]
      group.displayTitle = `${group.baseTitle} · ${active?.descriptor ?? '同名资料'}`
    }
  }

  const duplicateGroups = []
  const entriesByHash = new Map()
  for (const entry of sourceEntries) {
    const hash = String(entry.hash).toLocaleLowerCase()
    const values = entriesByHash.get(hash) ?? []
    values.push(entry)
    entriesByHash.set(hash, values)
  }
  for (const [hash, duplicates] of entriesByHash) {
    const uniquePaths = [...new Map(duplicates.map((entry) => [path.resolve(entry.canonicalPath).toLocaleLowerCase(), entry])).values()]
    if (uniquePaths.length < 2) continue
    const keep = uniquePaths.find((entry) => referenced.has(path.resolve(entry.canonicalPath).toLocaleLowerCase()))
      ?? uniquePaths.find((entry) => manifestPaths.has(path.resolve(entry.canonicalPath).toLocaleLowerCase()))
      ?? uniquePaths.sort((left, right) => logicalFilename(left.canonicalPath).length - logicalFilename(right.canonicalPath).length)[0]
    const redundant = uniquePaths.filter((entry) => entry !== keep)
    duplicateGroups.push({
      hash,
      keepPath: keep.canonicalPath,
      duplicatePaths: redundant.map((entry) => entry.canonicalPath),
      safeCleanupPaths: redundant.filter((entry) => {
        const key = path.resolve(entry.canonicalPath).toLocaleLowerCase()
        return !referenced.has(key) && !manifestPaths.has(key)
      }).map((entry) => entry.canonicalPath),
    })
  }
  return { groups, duplicates: duplicateGroups }
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fsp.readFile(filePath, 'utf8')) } catch { return fallback }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
    await fsp.rename(temporary, filePath)
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {})
  }
}

function versionIdentity(value) {
  const source = blackboardResourceId(value?.sourceUrl)
  if (source) return `source:${source}`
  const localPath = String(value?.canonicalPath ?? value?.localPath ?? '')
  return `local:${path.dirname(localPath).toLocaleLowerCase()}:${logicalFilename(localPath || value?.title).toLocaleLowerCase()}`
}

function compactVersionRecord(parsed, entry) {
  return {
    localPath: entry.canonicalPath,
    hash: String(entry.hash),
    title: parsed?.title ?? logicalFilename(entry.canonicalPath),
    outline: (Array.isArray(parsed?.outline) ? parsed.outline : []).slice(0, 80),
    segments: (Array.isArray(parsed?.segments) ? parsed.segments : []).slice(0, 80).map((segment) => ({ text: String(segment?.text ?? '').slice(0, 1600) })),
    segmentCount: Array.isArray(parsed?.segments) ? parsed.segments.length : Number(parsed?.segmentCount) || 0,
  }
}

async function loadMissingVersionRecordsUnlocked({ root, documents, entries, records, recordLoader }) {
  if (typeof recordLoader !== 'function') return records
  const cachePath = path.join(root, '.xuejing', 'material-version-records.json')
  const cache = await readJson(cachePath, { version: 1, records: {} })
  const cachedRecords = Object.values(cache?.records ?? {}).filter((record) => record?.hash)
  const knownHashes = new Set([...records, ...cachedRecords].map((record) => String(record?.hash ?? '').toLocaleLowerCase()).filter(Boolean))
  const requestedIdentities = new Set(documents.map(versionIdentity))
  const entriesByIdentity = new Map()
  for (const entry of entries) {
    const identity = versionIdentity(entry)
    if (!requestedIdentities.has(identity)) continue
    const values = entriesByIdentity.get(identity) ?? []
    values.push(entry)
    entriesByIdentity.set(identity, values)
  }
  const missing = []
  for (const values of entriesByIdentity.values()) {
    if (new Set(values.map((entry) => String(entry.hash).toLocaleLowerCase()).filter(Boolean)).size < 2) continue
    for (const entry of values) {
      const hash = String(entry.hash ?? '').toLocaleLowerCase()
      if (!hash || knownHashes.has(hash) || entry.orphan) continue
      knownHashes.add(hash)
      missing.push(entry)
    }
  }
  let changed = false
  for (const entry of missing.slice(0, 60)) {
    try {
      const parsed = await recordLoader({ materialId: `version-${entry.hash}`, courseId: '', courseName: '', title: logicalFilename(entry.canonicalPath), localPath: entry.canonicalPath })
      cache.records[String(entry.hash).toLocaleLowerCase()] = compactVersionRecord(parsed, entry)
      changed = true
    } catch { /* 无法本地解析的历史版本保持保守的来源冲突判定。 */ }
  }
  if (changed) await writeJsonAtomic(cachePath, { version: 1, records: cache.records })
  return [...records, ...Object.values(cache.records ?? {})]
}

function loadMissingVersionRecords(payload) {
  const task = versionRecordCacheChain.catch(() => {}).then(() => loadMissingVersionRecordsUnlocked(payload))
  versionRecordCacheChain = task.then(() => {}, () => {})
  return task
}

async function collectOrphanVersionFiles(root, directories, knownPaths) {
  const results = []
  for (const directory of directories) {
    let names = []
    try { names = await fsp.readdir(directory, { withFileTypes: true }) } catch { continue }
    for (const item of names) {
      if (!item.isFile() || !IMPORT_VERSION_MARKER.test(item.name)) continue
      const filePath = path.join(directory, item.name)
      const key = path.resolve(filePath).toLocaleLowerCase()
      if (knownPaths.has(key)) continue
      try {
        const stat = await fsp.stat(filePath)
        results.push({ canonicalPath: filePath, hash: await hashFile(filePath), importedAt: stat.birthtime.toISOString(), bytes: stat.size, orphan: true })
      } catch { /* 文件可能正被用户移动，忽略本轮扫描。 */ }
    }
  }
  return results
}

async function inspectMaterialVersions({ root, documents, recordLoader }) {
  const manifest = await readJson(path.join(root, '.xuejing', 'manifest.json'), { files: [] })
  const index = await readJson(path.join(root, '.xuejing', 'knowledge-index.json'), { documents: {} })
  const requested = Array.isArray(documents) ? documents.filter((document) => document?.localPath) : []
  const directories = [...new Set(requested.map((document) => path.dirname(document.localPath)))]
  const knownPaths = new Set((manifest.files ?? []).filter((entry) => entry?.canonicalPath).map((entry) => path.resolve(entry.canonicalPath).toLocaleLowerCase()))
  const manifestEntries = []
  for (const entry of manifest.files ?? []) {
    if (!entry?.canonicalPath || !knownPaths.has(path.resolve(entry.canonicalPath).toLocaleLowerCase())) continue
    try {
      const stat = await fsp.stat(entry.canonicalPath)
      manifestEntries.push({ ...entry, bytes: stat.size })
    } catch { /* 清单中的缺失文件不参与版本选择。 */ }
  }
  const orphans = await collectOrphanVersionFiles(root, directories, knownPaths)
  const entries = [...manifestEntries, ...orphans]
  const records = await loadMissingVersionRecords({ root, documents: requested, entries, records: Object.values(index.documents ?? {}), recordLoader })
  return buildVersionCatalogFromEntries({ documents: requested, entries, records })
}

function insideRoot(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function cleanupExactDuplicates({ root, documents, paths }) {
  const catalog = await inspectMaterialVersions({ root, documents })
  const allowed = new Set(catalog.duplicates.flatMap((group) => group.safeCleanupPaths).map((filePath) => path.resolve(filePath).toLocaleLowerCase()))
  const requested = [...new Set((Array.isArray(paths) ? paths : []).filter((filePath) => typeof filePath === 'string'))]
  const removed = []
  const rejected = []
  for (const filePath of requested) {
    const key = path.resolve(filePath).toLocaleLowerCase()
    if (!insideRoot(root, filePath) || !allowed.has(key)) {
      rejected.push(filePath)
      continue
    }
    try { await fsp.unlink(filePath); removed.push(filePath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return { removed, rejected }
}

module.exports = { blackboardResourceId, buildVersionCatalogFromEntries, cleanupExactDuplicates, contentSimilarity, inspectMaterialVersions, logicalFilename, materialDescriptor }
