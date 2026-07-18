const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { createRefinementJobManager } = require('./refinement-jobs.cjs')

function documents() {
  return [
    { materialId: 'a', title: 'A.pdf', localPath: 'A.pdf' },
    { materialId: 'b', title: 'B.pdf', localPath: 'B.pdf' },
  ]
}

async function sandboxManager(executeItem, finalizeJob) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-refinement-jobs-'))
  const manager = createRefinementJobManager({
    statePath: path.join(root, 'jobs.json'),
    executeItem,
    finalizeJob,
    idFactory: () => 'job-1',
  })
  await manager.initialize()
  return { root, manager }
}

test('全部资料完成后会执行一次课程级知识归并', async () => {
  const calls = []
  const { root, manager } = await sandboxManager(async () => {}, async ({ job, documents }) => { calls.push({ completedIds: job.completedIds, documentIds: documents.map((document) => document.materialId) }) })
  try {
    const job = await manager.start({ courseId: 'c1', mode: 'deep', documents: documents(), materialIds: ['a', 'b'] })
    const completed = await manager.waitForIdle(job.id)
    assert.equal(completed.status, 'completed')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { completedIds: ['a', 'b'], documentIds: ['a', 'b'] })
    assert.ok(completed.finalizedAt)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('课程级知识归并失败后可单独从该阶段继续，不会重复精炼文件', async () => {
  let itemCalls = 0
  let finalizeCalls = 0
  const { root, manager } = await sandboxManager(async () => { itemCalls += 1 }, async () => {
    finalizeCalls += 1
    if (finalizeCalls === 1) throw new Error('temporary normalization failure')
  })
  try {
    const job = await manager.start({ courseId: 'c1', mode: 'quick', documents: documents(), materialIds: ['a'] })
    const failed = await manager.waitForIdle(job.id)
    assert.equal(failed.status, 'completed_with_errors')
    assert.match(failed.finalizationError, /temporary/)
    await manager.resume(job.id)
    const completed = await manager.waitForIdle(job.id)
    assert.equal(completed.status, 'completed')
    assert.equal(itemCalls, 1)
    assert.equal(finalizeCalls, 2)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('应用重启后可继续失败的课程归并且保留内部资料列表', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-refinement-restart-finalize-'))
  const statePath = path.join(root, 'jobs.json')
  let itemCalls = 0
  try {
    const first = createRefinementJobManager({
      statePath,
      executeItem: async () => { itemCalls += 1 },
      finalizeJob: async () => { throw new Error('temporary failure') },
      idFactory: () => 'job-restart',
    })
    await first.initialize()
    const started = await first.start({ courseId: 'c1', mode: 'deep', documents: documents(), materialIds: ['a', 'b'] })
    assert.equal((await first.waitForIdle(started.id)).status, 'completed_with_errors')

    let finalizedDocuments = []
    const reopened = createRefinementJobManager({
      statePath,
      executeItem: async () => { itemCalls += 1 },
      finalizeJob: async ({ documents: restoredDocuments }) => { finalizedDocuments = restoredDocuments.map((document) => document.materialId) },
    })
    const restored = await reopened.initialize()
    assert.equal(restored[0].status, 'completed_with_errors')
    await reopened.resume(started.id)
    const completed = await reopened.waitForIdle(started.id)
    assert.equal(completed.status, 'completed')
    assert.equal(itemCalls, 2)
    assert.deepEqual(finalizedDocuments, ['a', 'b'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('批量精炼作为后台任务启动，不阻塞创建任务的调用', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { root, manager } = await sandboxManager(async () => { await gate })
  try {
    const job = await manager.start({ courseId: 'c1', mode: 'deep', documents: documents(), materialIds: ['a'] })
    assert.equal(job.status, 'running')
    assert.equal(manager.list()[0].currentMaterialId, 'a')
    release()
    const completed = await manager.waitForIdle(job.id)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(completed.completedIds, ['a'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('暂停会保存页面组检查点，恢复后从检查点继续', async () => {
  const checkpoints = []
  let firstRun = true
  const { root, manager } = await sandboxManager(async ({ checkpoint, onCheckpoint }) => {
    checkpoints.push(checkpoint?.nextBatch ?? 0)
    if (firstRun) {
      firstRun = false
      await onCheckpoint({ nextBatch: 1, results: ['batch-1'] })
    }
  })
  try {
    const job = await manager.start({ courseId: 'c1', mode: 'deep', documents: documents(), materialIds: ['a'] })
    await manager.pause(job.id)
    const paused = await manager.waitForIdle(job.id)
    assert.equal(paused.status, 'paused')
    assert.equal(paused.checkpointedIds.includes('a'), true)

    await manager.resume(job.id)
    const completed = await manager.waitForIdle(job.id)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(checkpoints, [0, 1])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('立即停止会中断当前请求，但保留此前完成项并可继续', async () => {
  const { root, manager } = await sandboxManager(async ({ materialId, signal }) => {
    if (materialId === 'a') return
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'AI_REFINEMENT_ABORTED' })), { once: true })
    })
  })
  try {
    const job = await manager.start({ courseId: 'c1', mode: 'quick', documents: documents(), materialIds: ['a', 'b'] })
    while (manager.list()[0].currentMaterialId !== 'b') await new Promise((resolve) => setTimeout(resolve, 2))
    await manager.cancel(job.id)
    const interrupted = await manager.waitForIdle(job.id)
    assert.equal(interrupted.status, 'interrupted')
    assert.deepEqual(interrupted.completedIds, ['a'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('原件模式暂停会完成当前文件并在下一份前停下，恢复后只处理未完成文件', async () => {
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const calls = []
  const { root, manager } = await sandboxManager(async ({ materialId }) => {
    calls.push(materialId)
    if (materialId === 'a') await firstGate
  })
  try {
    const job = await manager.start({ courseId: 'c1', mode: 'original', documents: documents(), materialIds: ['a', 'b'] })
    await manager.pause(job.id)
    releaseFirst()
    const paused = await manager.waitForIdle(job.id)
    assert.equal(paused.status, 'paused')
    assert.deepEqual(paused.completedIds, ['a'])
    assert.deepEqual(calls, ['a'])
    assert.deepEqual(paused.checkpointedIds, [])

    await manager.resume(job.id)
    const completed = await manager.waitForIdle(job.id)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(completed.completedIds, ['a', 'b'])
    assert.deepEqual(calls, ['a', 'b'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('原件模式在应用重启后保留已完成文件并从未完成原件继续', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-refinement-original-restart-'))
  const statePath = path.join(root, 'jobs.json')
  const timestamp = '2026-07-15T00:00:00.000Z'
  await fs.writeFile(statePath, JSON.stringify({ version: 1, jobs: [{
    id: 'original-restart', courseId: 'c1', mode: 'original', force: true, documents: documents(), materialIds: ['a', 'b'], completedIds: ['a'], failed: [], checkpoints: {}, currentMaterialId: 'b', progress: { completed: 1, total: 2, title: 'B.pdf', itemCompleted: 0, itemTotal: 1 }, status: 'running', pauseRequested: false, cancelRequested: false, finalizedAt: null, finalizationError: null, createdAt: timestamp, updatedAt: timestamp,
  }] }), 'utf8')
  const calls = []
  const manager = createRefinementJobManager({ statePath, executeItem: async ({ materialId }) => { calls.push(materialId) } })
  try {
    const [restored] = await manager.initialize()
    assert.equal(restored.status, 'interrupted')
    assert.equal(restored.mode, 'original')
    assert.deepEqual(restored.completedIds, ['a'])
    await manager.resume(restored.id)
    const completed = await manager.waitForIdle(restored.id)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(completed.completedIds, ['a', 'b'])
    assert.deepEqual(calls, ['b'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('同一时间只允许恢复一个后台精炼任务', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let ids = 0
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-refinement-single-active-'))
  const manager = createRefinementJobManager({ statePath: path.join(root, 'jobs.json'), executeItem: async ({ onCheckpoint }) => { await onCheckpoint({ nextBatch: 1 }); await gate }, idFactory: () => `job-${++ids}` })
  try {
    await manager.initialize()
    const first = await manager.start({ courseId: 'c1', mode: 'deep', documents: documents(), materialIds: ['a'] })
    await manager.pause(first.id)
    await manager.waitForIdle(first.id)
    const second = await manager.start({ courseId: 'c1', mode: 'quick', documents: documents(), materialIds: ['b'] })
    await assert.rejects(() => manager.resume(first.id), /已有 AI 精炼任务/)
    await manager.cancel(second.id)
    release()
    await manager.waitForIdle(second.id)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
