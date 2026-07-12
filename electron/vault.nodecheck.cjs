const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { findBlackboardCachedFiles, importAssignmentFilesToVault, importBufferToVault, importFilesToVault, migrateVault, removeAssignmentFilesFromVault, verifyVaultFiles } = require('./vault.cjs')

test('本地资料库对相同内容去重且不覆盖原文件', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-vault-'))
  try {
    const source = path.join(sandbox, 'wechat-notes.pdf')
    const vault = path.join(sandbox, 'vault')
    await fs.writeFile(source, 'student annotation remains untouched', 'utf8')

    const first = await importFilesToVault({ root: vault, courseName: '线性代数', folderPath: ['微信资料'], filePaths: [source] })
    const second = await importFilesToVault({ root: vault, courseName: '线性代数', folderPath: ['微信资料'], filePaths: [source] })

    assert.equal(first.length, 1)
    assert.equal(second[0].deduplicated, true)
    assert.equal(await fs.readFile(source, 'utf8'), 'student annotation remains untouched')
    assert.equal(await fs.readFile(first[0].localPath, 'utf8'), 'student annotation remains untouched')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('作业附件使用专属资料库副本，移除时不会误删相同的课程资料', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-assignment-vault-'))
  try {
    const source = path.join(sandbox, 'hw2.pdf')
    const vault = path.join(sandbox, 'vault')
    await fs.writeFile(source, '%PDF-1.7\nassignment content', 'utf8')
    const [courseFile] = await importFilesToVault({ root: vault, courseName: '信号与系统', folderPath: ['课程资料'], filePaths: [source] })
    const [assignmentFile] = await importAssignmentFilesToVault({ root: vault, courseName: '信号与系统', assignmentId: 'gradescope-assignment-hw2', assignmentTitle: 'HW2', filePaths: [source] })

    assert.notEqual(assignmentFile.localPath, courseFile.localPath)
    assert.equal(await fs.readFile(assignmentFile.localPath, 'utf8'), '%PDF-1.7\nassignment content')
    const removed = await removeAssignmentFilesFromVault({ root: vault, assignmentId: 'gradescope-assignment-hw2', filePaths: [assignmentFile.localPath] })

    assert.deepEqual(removed.removed, [assignmentFile.localPath])
    await assert.rejects(fs.access(assignmentFile.localPath))
    assert.equal(await fs.readFile(courseFile.localPath, 'utf8'), '%PDF-1.7\nassignment content')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('Blackboard 文件名没有扩展名时按 PDF 内容补齐扩展名', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-vault-buffer-'))
  try {
    const result = await importBufferToVault({
      root: path.join(sandbox, 'vault'), courseName: 'EE291E', folderPath: ['Lecture notes'],
      filename: 'EE291E-lect1-intro', buffer: Buffer.from('%PDF-1.7\nlecture content'), sourceUrl: 'https://example.test/file', contentType: 'application/pdf',
    })
    assert.equal(result.title, 'EE291E-lect1-intro.pdf')
    assert.match(result.localPath, /EE291E-lect1-intro\.pdf$/)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('带章节小数点但没有真实扩展名的 Blackboard 文件仍按内容补齐 PDF 扩展名', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-vault-dotted-title-'))
  try {
    const result = await importBufferToVault({
      root: path.join(sandbox, 'vault'), courseName: 'EE150', folderPath: ['Slides'],
      filename: 'Ch1.1 Introduction', buffer: Buffer.from('%PDF-1.7\nslide content'), sourceUrl: 'https://example.test/ch1', contentType: 'application/pdf',
    })
    assert.equal(result.title, 'Ch1.1 Introduction.pdf')
    assert.match(result.localPath, /Ch1\.1 Introduction\.pdf$/)
    assert.equal(result.type, 'PDF')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('迁移资料库会复制文件并返回可校验的新路径', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-vault-migrate-'))
  try {
    const source = path.join(sandbox, 'lecture.pdf')
    const oldRoot = path.join(sandbox, 'old-vault')
    const newRoot = path.join(sandbox, 'new-vault')
    await fs.writeFile(source, '%PDF-1.7\nlecture', 'utf8')
    const [imported] = await importFilesToVault({ root: oldRoot, courseName: 'EE291E', folderPath: ['Lecture notes'], filePaths: [source] })
    const result = await migrateVault({ sourceRoot: oldRoot, targetRoot: newRoot, mode: 'copy' })
    const verification = await verifyVaultFiles([result.relocated[0].to])

    assert.equal(result.copied, 1)
    assert.equal(await fs.readFile(imported.localPath, 'utf8'), '%PDF-1.7\nlecture')
    assert.equal(verification[0].exists, true)
    assert.match(result.relocated[0].to, /new-vault/)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('可按 Blackboard 源链接从资料库清单恢复已缓存状态', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-vault-match-'))
  try {
    const root = path.join(sandbox, 'vault')
    const sourceUrl = 'https://elearning.example.edu/bbcswebdav/lecture-1'
    await importBufferToVault({ root, courseName: 'EE291E', folderPath: ['Lecture notes'], filename: 'lecture', buffer: Buffer.from('%PDF-1.7\nlecture'), sourceUrl, contentType: 'application/pdf' })
    const result = await findBlackboardCachedFiles(root, [sourceUrl])

    assert.equal(result.length, 1)
    assert.equal(result[0].url, sourceUrl)
    assert.match(result[0].localPath, /lecture\.pdf$/)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('迁移时以源文件真实哈希为准，忽略过期清单哈希', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-vault-stale-hash-'))
  try {
    const source = path.join(sandbox, 'lecture.pdf')
    const oldRoot = path.join(sandbox, 'old-vault')
    const newRoot = path.join(sandbox, 'new-vault')
    await fs.writeFile(source, '%PDF-1.7\nlecture', 'utf8')
    await importFilesToVault({ root: oldRoot, courseName: 'EE291E', folderPath: ['Lecture notes'], filePaths: [source] })
    const manifestPath = path.join(oldRoot, '.xuejing', 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    manifest.files[0].hash = 'stale-hash'
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8')

    const result = await migrateVault({ sourceRoot: oldRoot, targetRoot: newRoot, mode: 'copy' })
    assert.equal(result.copied, 1)
    assert.equal(result.failed.length, 0)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})
