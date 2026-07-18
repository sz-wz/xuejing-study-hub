const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { blackboardResourceId, buildVersionCatalogFromEntries, inspectMaterialVersions, logicalFilename } = require('./material-versions.cjs')

const root = 'D:\\vault\\EE150\\Slides'

function document(materialId, title, localPath, sourceUrl) {
  return { materialId, courseId: 'ee150', title, localPath, sourceUrl }
}

function entry(name, hash, sourceUrl, importedAt, orphan = false) {
  return { canonicalPath: `${root}\\${name}`, hash, sourceUrl, importedAt, bytes: 1024, orphan }
}

function record(name, hash, pages, text) {
  return { localPath: `${root}\\${name}`, hash, segments: Array.from({ length: pages }, (_, index) => ({ start: index + 1, text: index === 0 ? text : `${text} ${index}` })) }
}

test('同名但 Blackboard 资源 ID 不同的课件保持独立并自动增加区分信息', () => {
  const firstUrl = 'https://school.test/bbcswebdav/pid-1-dt-content-rid-100_1/xid-100_1'
  const secondUrl = 'https://school.test/bbcswebdav/pid-2-dt-content-rid-101_1/xid-101_1'
  const documents = [
    document('a', 'Transform.pdf', `${root}\\Transform.pdf`, firstUrl),
    document('b', 'Transform.pdf', `${root}\\Transform（导入版本 2026-01-01）.pdf`, secondUrl),
  ]
  const entries = [entry('Transform.pdf', 'h1', firstUrl, '2026-01-01'), entry('Transform（导入版本 2026-01-01）.pdf', 'h2', secondUrl, '2026-01-01')]
  const records = [record('Transform.pdf', 'h1', 42, 'The Laplace Transform'), record('Transform（导入版本 2026-01-01）.pdf', 'h2', 35, 'Part III LTI Systems')]
  const result = buildVersionCatalogFromEntries({ documents, entries, records })
  assert.equal(result.groups[0].relation, 'single')
  assert.equal(result.groups[1].relation, 'single')
  assert.match(result.groups[0].displayTitle, /42 页/)
  assert.match(result.groups[1].displayTitle, /Part III/)
})

test('同一来源且内容相近时优先推荐最新版本', () => {
  const url = 'https://school.test/bbcswebdav/pid-1-dt-content-rid-100_1/xid-100_1'
  const documents = [document('a', 'Lecture.pdf', `${root}\\Lecture.pdf`, url)]
  const entries = [entry('Lecture.pdf', 'old', url, '2026-01-01'), entry('Lecture（导入版本 2026-02-01）.pdf', 'new', url, '2026-02-01')]
  const records = [record('Lecture.pdf', 'old', 20, 'Convolution Fourier transform system response'), record('Lecture（导入版本 2026-02-01）.pdf', 'new', 21, 'Convolution Fourier transform system response updated example')]
  const [group] = buildVersionCatalogFromEntries({ documents, entries, records }).groups
  assert.equal(group.relation, 'versions')
  assert.match(group.recommendedPath, /2026-02-01/)
  assert.equal(group.versions.length, 2)
})

test('同一来源但内容完全不同时标记来源冲突而不自动切换', () => {
  const url = 'https://school.test/bbcswebdav/pid-1-dt-content-rid-100_1/xid-100_1'
  const documents = [document('a', 'Transform.pdf', `${root}\\Transform.pdf`, url)]
  const entries = [entry('Transform.pdf', 'old', url, '2026-01-01'), entry('Transform（导入版本 2026-02-01）.pdf', 'new', url, '2026-02-01')]
  const records = [record('Transform.pdf', 'old', 35, 'LTI systems block diagram differential equation'), record('Transform（导入版本 2026-02-01）.pdf', 'new', 25, 'Laplace transform properties pairs unilateral transform')]
  const [group] = buildVersionCatalogFromEntries({ documents, entries, records }).groups
  assert.equal(group.relation, 'source-conflict')
  assert.equal(group.recommendedPath, `${root}\\Transform.pdf`)
})

test('同一来源出现不同 Part 时即使术语高度重叠也标记来源冲突', () => {
  const url = 'https://school.test/bbcswebdav/pid-1-dt-content-rid-100_1/xid-100_1'
  const documents = [document('a', 'Transform.pdf', `${root}\\Transform.pdf`, url)]
  const entries = [entry('Transform.pdf', 'part-2', url, '2026-01-01'), entry('Transform（导入版本 2026-02-01）.pdf', 'part-3', url, '2026-02-01')]
  const shared = 'Laplace transform region convergence system response inverse transform properties'
  const records = [record('Transform.pdf', 'part-2', 25, `Part II ${shared}`), record('Transform（导入版本 2026-02-01）.pdf', 'part-3', 35, `Part III ${shared}`)]
  const [group] = buildVersionCatalogFromEntries({ documents, entries, records }).groups
  assert.equal(group.relation, 'source-conflict')
  assert.equal(group.recommendedPath, `${root}\\Transform.pdf`)
})

test('完全相同的孤立副本只进入安全清理列表', () => {
  const url = 'https://school.test/bbcswebdav/pid-1-dt-content-rid-100_1/xid-100_1'
  const canonical = entry('Lecture.pdf', 'same', url, '2026-01-01')
  const orphan = entry('Lecture（导入版本 2026-02-01）.pdf', 'same', '', '2026-02-01', true)
  const result = buildVersionCatalogFromEntries({ documents: [document('a', 'Lecture.pdf', canonical.canonicalPath, url)], entries: [canonical, orphan], records: [] })
  assert.deepEqual(result.duplicates[0].safeCleanupPaths, [orphan.canonicalPath])
})

test('资料名称和 Blackboard 内容 ID 使用稳定规范化', () => {
  assert.equal(logicalFilename('Transform（导入版本 2026-01-01）（导入版本 2026-02-01）.pdf'), 'Transform.pdf')
  assert.equal(blackboardResourceId('https://school.test/bbcswebdav/pid-1-dt-content-rid-15412654_1/xid-15412654_1'), 'blackboard:15412654')
})

test('首次比较历史版本时只解析缺失指纹并按哈希缓存', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-material-version-cache-'))
  const metadata = path.join(sandbox, '.xuejing')
  const directory = path.join(sandbox, 'EE150', 'Slides')
  const oldPath = path.join(directory, 'Lecture.pdf')
  const newPath = path.join(directory, 'Lecture（导入版本 2026-02-01）.pdf')
  const url = 'https://school.test/bbcswebdav/pid-1-dt-content-rid-100_1/xid-100_1'
  try {
    await fs.mkdir(metadata, { recursive: true })
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(oldPath, 'old')
    await fs.writeFile(newPath, 'new')
    await fs.writeFile(path.join(metadata, 'manifest.json'), JSON.stringify({ files: [
      { canonicalPath: oldPath, hash: 'old-hash', sourceUrl: url, importedAt: '2026-01-01' },
      { canonicalPath: newPath, hash: 'new-hash', sourceUrl: url, importedAt: '2026-02-01' },
    ] }))
    await fs.writeFile(path.join(metadata, 'knowledge-index.json'), JSON.stringify({ documents: { current: record(path.basename(newPath), 'new-hash', 21, 'Convolution Fourier transform system response updated example') } }))
    const documents = [document('current', 'Lecture.pdf', newPath, url)]
    let loads = 0
    const first = await inspectMaterialVersions({ root: sandbox, documents, recordLoader: async () => {
      loads += 1
      return { title: 'Lecture.pdf', outline: [], segments: Array.from({ length: 20 }, () => ({ text: 'Convolution Fourier transform system response' })) }
    } })
    assert.equal(loads, 1)
    assert.equal(first.groups[0].relation, 'versions')

    const second = await inspectMaterialVersions({ root: sandbox, documents, recordLoader: async () => { throw new Error('缓存存在时不应再次解析') } })
    assert.equal(second.groups[0].relation, 'versions')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})
