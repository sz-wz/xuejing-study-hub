const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

function safeSegment(value) {
  const normalized = String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return normalized && normalized !== '.' && normalized !== '..' ? normalized.slice(0, 100) : '未命名'
}

function stableId(value) {
  const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
  return `local-${hash}`
}

function knownExtension(filename) {
  const extension = path.extname(filename).toLowerCase()
  return ['.pdf', '.ppt', '.pptx', '.pps', '.ppsx', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.tex', '.latex', '.zip'].includes(extension) ? extension : ''
}

function fileType(filename) {
  const extension = knownExtension(filename).slice(1)
  if (['ppt', 'pptx', 'pps', 'ppsx'].includes(extension)) return 'PPT'
  if (extension === 'pdf') return 'PDF'
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'].includes(extension)) return '视频'
  return '文件'
}

function extensionFromContent(buffer, contentType = '') {
  const mime = String(contentType).toLowerCase().split(';')[0].trim()
  if (mime === 'application/pdf') return '.pdf'
  if (/presentationml|powerpoint/.test(mime)) return mime.includes('presentationml') ? '.pptx' : '.ppt'
  if (/^video\//.test(mime)) return `.${mime.slice(6).replace('quicktime', 'mov').replace('x-matroska', 'mkv')}`
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return '.pdf'
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return '.ppt'
  if (buffer.indexOf(Buffer.from('ppt/')) >= 0) return '.pptx'
  return ''
}

function filenameWithInferredExtension(filename, buffer, contentType) {
  const safeName = safeSegment(filename)
  if (knownExtension(safeName)) return safeName
  const extension = extensionFromContent(buffer, contentType)
  return extension ? `${safeName}${extension}` : safeName
}

function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function readManifest(root) {
  const manifestPath = path.join(root, '.xuejing', 'manifest.json')
  try {
    const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
    return { path: manifestPath, files: Array.isArray(parsed.files) ? parsed.files : [] }
  } catch {
    return { path: manifestPath, files: [] }
  }
}

async function writeManifest(manifest) {
  await fsp.mkdir(path.dirname(manifest.path), { recursive: true })
  await fsp.writeFile(manifest.path, JSON.stringify({ version: 1, files: manifest.files }, null, 2), 'utf8')
}

async function exists(filePath) {
  try { await fsp.access(filePath); return true } catch { return false }
}

async function uniqueDestination(directory, filename, hash) {
  const extension = knownExtension(filename)
  const base = path.basename(filename, extension)
  let candidate = path.join(directory, filename)
  if (!await exists(candidate)) return { path: candidate, duplicate: false }
  if (await fileHash(candidate) === hash) return { path: candidate, duplicate: true }
  const suffix = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  candidate = path.join(directory, `${base}（导入版本 ${suffix}）${extension}`)
  return { path: candidate, duplicate: false }
}

async function importFilesToVault({ root, courseName, folderPath, filePaths }) {
  await fsp.mkdir(root, { recursive: true })
  const manifest = await readManifest(root)
  const targetDirectory = path.join(root, safeSegment(courseName), ...folderPath.map(safeSegment))
  await fsp.mkdir(targetDirectory, { recursive: true })
  const imported = []

  for (const sourcePath of filePaths) {
    const stat = await fsp.stat(sourcePath)
    if (!stat.isFile()) continue
    const hash = await fileHash(sourcePath)
    let existing = manifest.files.find((record) => record.hash === hash)
    if (existing && !await exists(existing.canonicalPath)) {
      manifest.files = manifest.files.filter((record) => record !== existing)
      existing = undefined
    }
    const filename = safeSegment(path.basename(sourcePath))
    const target = await uniqueDestination(targetDirectory, filename, hash)
    if (!existing && !target.duplicate) await fsp.copyFile(sourcePath, target.path)
    if (!existing) manifest.files.push({ hash, canonicalPath: target.path, importedAt: new Date().toISOString(), sourcePath })
    imported.push({
      id: stableId(existing?.canonicalPath ?? target.path),
      title: filename,
      type: fileType(filename),
      meta: existing || target.duplicate ? '本地已有相同文件 · 未重复复制' : `本地导入 · ${(stat.size / 1024 / 1024).toFixed(2)} MB`,
      path: folderPath.map(safeSegment),
      localPath: existing?.canonicalPath ?? target.path,
      deduplicated: Boolean(existing || target.duplicate),
    })
  }
  await writeManifest(manifest)
  return imported
}

async function importAssignmentFilesToVault({ root, courseName, assignmentId, assignmentTitle, filePaths }) {
  if (!assignmentId || typeof assignmentId !== 'string') throw new Error('缺少作业标识')
  await fsp.mkdir(root, { recursive: true })
  const manifest = await readManifest(root)
  const folder = `${safeSegment(assignmentTitle)}-${safeSegment(assignmentId).slice(-10)}`
  const folderPath = ['作业文件', folder]
  const targetDirectory = path.join(root, safeSegment(courseName), ...folderPath.map(safeSegment))
  await fsp.mkdir(targetDirectory, { recursive: true })
  const imported = []

  for (const sourcePath of filePaths) {
    const stat = await fsp.stat(sourcePath)
    if (!stat.isFile()) continue
    const hash = await fileHash(sourcePath)
    const filename = safeSegment(path.basename(sourcePath))
    const target = await uniqueDestination(targetDirectory, filename, hash)
    if (!target.duplicate) await fsp.copyFile(sourcePath, target.path)
    let record = manifest.files.find((item) => item?.kind === 'assignment' && item.assignmentId === assignmentId && path.resolve(item.canonicalPath ?? '') === path.resolve(target.path))
    if (!record) {
      record = { hash, canonicalPath: target.path, importedAt: new Date().toISOString(), sourcePath, kind: 'assignment', assignmentId }
      manifest.files.push(record)
    }
    imported.push({
      id: stableId(record.canonicalPath),
      title: filename,
      type: fileType(filename),
      meta: target.duplicate ? '本作业已有关联的相同文件 · 未重复复制' : `作业文件已缓存 · ${(stat.size / 1024 / 1024).toFixed(2)} MB`,
      path: folderPath,
      localPath: record.canonicalPath,
      deduplicated: target.duplicate,
      managed: true,
    })
  }
  await writeManifest(manifest)
  return imported
}

async function importBufferToVault({ root, courseName, folderPath, filename, buffer, sourceUrl, contentType }) {
  await fsp.mkdir(root, { recursive: true })
  const manifest = await readManifest(root)
  const targetDirectory = path.join(root, safeSegment(courseName), ...folderPath.map(safeSegment))
  await fsp.mkdir(targetDirectory, { recursive: true })
  const safeName = filenameWithInferredExtension(filename, buffer, contentType)
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')
  let existing = manifest.files.find((record) => record.hash === hash)
  if (existing && !await exists(existing.canonicalPath)) {
    manifest.files = manifest.files.filter((record) => record !== existing)
    existing = undefined
  }
  const target = await uniqueDestination(targetDirectory, safeName, hash)
  if (existing && !knownExtension(existing.canonicalPath) && knownExtension(safeName) && !target.duplicate && await exists(existing.canonicalPath)) {
    await fsp.rename(existing.canonicalPath, target.path)
    existing.canonicalPath = target.path
  }
  if (!existing && !target.duplicate) await fsp.writeFile(target.path, buffer)
  if (!existing) manifest.files.push({ hash, canonicalPath: target.path, importedAt: new Date().toISOString(), sourceUrl })
  await writeManifest(manifest)
  return {
    id: stableId(existing?.canonicalPath ?? target.path),
    title: safeName,
    type: fileType(safeName),
    meta: existing || target.duplicate ? '资料库已有相同内容 · 未重复下载' : `已缓存到本地 · ${(buffer.length / 1024 / 1024).toFixed(2)} MB`,
    path: folderPath.map(safeSegment),
    localPath: existing?.canonicalPath ?? target.path,
    deduplicated: Boolean(existing || target.duplicate),
  }
}

async function repairVaultExtensions(root) {
  const manifest = await readManifest(root)
  let repaired = 0
  const repairedFiles = []
  for (const record of manifest.files) {
    if (!record?.canonicalPath || knownExtension(record.canonicalPath)) continue
    try {
      const handle = await fsp.open(record.canonicalPath, 'r')
      const probe = Buffer.alloc(8192)
      const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
      await handle.close()
      const extension = extensionFromContent(probe.subarray(0, bytesRead))
      if (!extension) continue
      const target = `${record.canonicalPath}${extension}`
      if (await exists(target)) continue
      await fsp.rename(record.canonicalPath, target)
      repairedFiles.push({ from: record.canonicalPath, to: target })
      record.canonicalPath = target
      repaired += 1
    } catch {
      // 单个缓存文件被用户移动或删除时，跳过即可。
    }
  }
  if (repaired) await writeManifest(manifest)
  return { repaired, repairedFiles }
}

async function verifyVaultFiles(filePaths) {
  const results = []
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) continue
    try {
      const stat = await fsp.stat(filePath)
      results.push({ path: filePath, exists: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 })
    } catch {
      results.push({ path: filePath, exists: false, bytes: 0 })
    }
  }
  return results
}

function normalizedUrl(value) {
  try {
    const parsed = new URL(value)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return String(value ?? '')
  }
}

async function findBlackboardCachedFiles(root, urls) {
  const requested = new Map((Array.isArray(urls) ? urls : []).filter((url) => typeof url === 'string').map((url) => [normalizedUrl(url), url]))
  if (!requested.size) return []
  const manifest = await readManifest(root)
  const matches = []
  for (const record of manifest.files) {
    const key = normalizedUrl(record?.sourceUrl)
    const url = requested.get(key)
    if (!url || !record?.canonicalPath || !await exists(record.canonicalPath)) continue
    const title = path.basename(record.canonicalPath)
    matches.push({ url, localPath: record.canonicalPath, title, type: fileType(title) })
  }
  return matches
}

function pathInside(root, filePath) {
  const relative = path.relative(root, filePath)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : ''
}

async function copyAndVerify(sourcePath, destinationPath, hash) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await fsp.copyFile(sourcePath, destinationPath)
    if (await fileHash(destinationPath) === hash) return
  }
  throw new Error('迁移后的文件校验失败')
}

async function migrateVault({ sourceRoot, targetRoot, mode = 'copy', onProgress }) {
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(targetRoot)) throw new Error('资料库路径必须是绝对路径')
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) throw new Error('新旧资料库位置相同')
  if (!['copy', 'move'].includes(mode)) return { copied: 0, deduplicated: 0, moved: 0, missing: 0, relocated: [], failed: [] }

  await fsp.mkdir(targetRoot, { recursive: true })
  const sourceManifest = await readManifest(sourceRoot)
  const targetManifest = await readManifest(targetRoot)
  const targetByHash = new Map(targetManifest.files.map((record) => [record.hash, record]))
  const relocated = []
  const failed = []
  let copied = 0
  let deduplicated = 0
  let moved = 0
  let missing = 0
  let sourceManifestChanged = false

  for (let index = 0; index < sourceManifest.files.length; index += 1) {
    const record = sourceManifest.files[index]
    const sourcePath = record?.canonicalPath
    onProgress?.({ completed: index, total: sourceManifest.files.length, title: path.basename(sourcePath ?? '') })
    try {
      if (!sourcePath || !await exists(sourcePath)) {
        missing += 1
        failed.push({ path: sourcePath ?? '', error: '源文件不存在或已被移动' })
        continue
      }
      const relative = pathInside(sourceRoot, sourcePath)
      if (!relative) {
        failed.push({ path: sourcePath, error: '文件不在原资料库目录内' })
        continue
      }
      const hash = await fileHash(sourcePath)
      if (record.hash !== hash) {
        record.hash = hash
        sourceManifestChanged = true
      }
      const knownTarget = targetByHash.get(hash)
      let destinationPath = knownTarget?.canonicalPath
      if (destinationPath && await exists(destinationPath) && await fileHash(destinationPath) !== hash) destinationPath = undefined
      if (!destinationPath || !await exists(destinationPath)) {
        const directory = path.join(targetRoot, path.dirname(relative))
        await fsp.mkdir(directory, { recursive: true })
        const target = await uniqueDestination(directory, path.basename(relative), hash)
        destinationPath = target.path
        if (target.duplicate) {
          deduplicated += 1
        } else {
          await copyAndVerify(sourcePath, destinationPath, hash)
          copied += 1
        }
        const migratedRecord = { ...record, hash, canonicalPath: destinationPath, migratedAt: new Date().toISOString() }
        targetManifest.files = targetManifest.files.filter((item) => item.hash !== hash)
        targetManifest.files.push(migratedRecord)
        targetByHash.set(hash, migratedRecord)
      } else {
        deduplicated += 1
      }
      relocated.push({ from: sourcePath, to: destinationPath })
      if (mode === 'move' && path.resolve(sourcePath) !== path.resolve(destinationPath)) {
        await fsp.unlink(sourcePath)
        moved += 1
      }
    } catch (error) {
      failed.push({ path: sourcePath ?? '', error: error instanceof Error ? error.message : String(error) })
    }
  }
  onProgress?.({ completed: sourceManifest.files.length, total: sourceManifest.files.length, title: '' })
  await writeManifest(targetManifest)
  if (sourceManifestChanged) await writeManifest(sourceManifest)
  return { copied, deduplicated, moved, missing, relocated, failed }
}

async function removeAssignmentFilesFromVault({ root, assignmentId, filePaths }) {
  if (!assignmentId || typeof assignmentId !== 'string') throw new Error('缺少作业标识')
  const manifest = await readManifest(root)
  const requested = [...new Set((Array.isArray(filePaths) ? filePaths : []).filter((filePath) => typeof filePath === 'string' && pathInside(root, filePath)))].slice(0, 100)
  const removed = []
  const missing = []
  const rejected = []
  for (const filePath of requested) {
    const target = path.resolve(filePath)
    const record = manifest.files.find((item) => item?.kind === 'assignment' && item.assignmentId === assignmentId && path.resolve(item.canonicalPath ?? '') === target)
    if (!record) {
      rejected.push(filePath)
      continue
    }
    try {
      await fsp.unlink(target)
      removed.push(target)
    } catch (error) {
      if (error?.code === 'ENOENT') missing.push(target)
      else throw error
    }
    manifest.files = manifest.files.filter((item) => item !== record)
    let directory = path.dirname(target)
    const rootPath = path.resolve(root)
    while (directory !== rootPath && pathInside(rootPath, directory)) {
      try {
        const entries = await fsp.readdir(directory)
        if (entries.length) break
        await fsp.rmdir(directory)
        directory = path.dirname(directory)
      } catch {
        break
      }
    }
  }
  if (removed.length || missing.length) await writeManifest(manifest)
  return { removed, missing, rejected }
}

module.exports = { findBlackboardCachedFiles, importAssignmentFilesToVault, importBufferToVault, importFilesToVault, migrateVault, removeAssignmentFilesFromVault, repairVaultExtensions, safeSegment, verifyVaultFiles }
