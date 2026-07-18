const fs = require('fs/promises')
const path = require('path')

const ACTIVE_STATUSES = new Set(['running', 'pausing', 'cancelling'])
const RESUMABLE_STATUSES = new Set(['paused', 'interrupted', 'completed_with_errors', 'failed'])

class PauseRequestedError extends Error {
  constructor() {
    super('AI refinement paused at checkpoint')
    this.code = 'AI_REFINEMENT_PAUSED'
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isAbortError(error) {
  return error?.code === 'AI_REFINEMENT_ABORTED' || error?.name === 'AbortError'
}

function publicJob(job) {
  return {
    id: job.id,
    courseId: job.courseId,
    mode: job.mode,
    force: job.force,
    status: job.status,
    materialIds: [...job.materialIds],
    items: job.materialIds.map((materialId) => {
      const document = job.documents.find((item) => item.materialId === materialId)
      const failure = job.failed.find((item) => item.materialId === materialId)
      return {
        materialId,
        title: document?.title ?? materialId,
        completed: job.completedIds.includes(materialId),
        failed: failure?.error,
        checkpointed: Boolean(job.checkpoints[materialId]),
      }
    }),
    completedIds: [...job.completedIds],
    failed: clone(job.failed),
    checkpointedIds: Object.keys(job.checkpoints),
    currentMaterialId: job.currentMaterialId ?? null,
    progress: clone(job.progress),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finalizedAt: job.finalizedAt ?? null,
    finalizationError: job.finalizationError ?? null,
  }
}

function createRefinementJobManager({ statePath, executeItem, finalizeJob, onChange = () => {}, idFactory = () => `refine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, now = () => new Date().toISOString() }) {
  let jobs = []
  const controllers = new Map()
  const runners = new Map()
  let persistChain = Promise.resolve()

  function persist() {
    persistChain = persistChain.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(statePath), { recursive: true })
      const temporary = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, jobs }, null, 2), 'utf8')
        await fs.rename(temporary, statePath)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {})
      }
    })
    return persistChain
  }

  function emit(job) {
    try { onChange(publicJob(job)) } catch { /* renderer notifications must not break jobs */ }
  }

  async function update(job, changes = {}) {
    Object.assign(job, changes, { updatedAt: now() })
    await persist()
    emit(job)
  }

  function findJob(jobId) {
    const job = jobs.find((item) => item.id === jobId)
    if (!job) throw new Error('找不到 AI 精炼任务')
    return job
  }

  function nextPending(job) {
    return job.materialIds.find((materialId) => !job.completedIds.includes(materialId)) ?? null
  }

  async function run(jobId) {
    if (runners.has(jobId)) return runners.get(jobId)
    const promise = (async () => {
      const job = findJob(jobId)
      try {
        for (const materialId of job.materialIds) {
          if (job.completedIds.includes(materialId)) continue
          if (job.cancelRequested) break
          if (job.pauseRequested && !job.currentMaterialId) break

          job.currentMaterialId = materialId
          job.progress = { completed: job.completedIds.length, total: job.materialIds.length, title: job.documents.find((item) => item.materialId === materialId)?.title ?? materialId, itemCompleted: 0, itemTotal: 1 }
          await update(job, { status: job.pauseRequested ? 'pausing' : 'running' })

          const controller = new AbortController()
          controllers.set(job.id, controller)
          try {
            await executeItem({
              job: publicJob(job),
              materialId,
              document: job.documents.find((item) => item.materialId === materialId),
              documents: clone(job.documents),
              checkpoint: clone(job.checkpoints[materialId] ?? null),
              signal: controller.signal,
              onProgress: async (progress) => {
                job.progress = { ...job.progress, ...progress, completed: job.completedIds.length, total: job.materialIds.length }
                await update(job)
              },
              onCheckpoint: async (checkpoint) => {
                job.checkpoints[materialId] = clone(checkpoint)
                await update(job)
                if (job.cancelRequested) throw Object.assign(new Error('AI refinement aborted'), { code: 'AI_REFINEMENT_ABORTED' })
                if (job.pauseRequested) throw new PauseRequestedError()
              },
            })

            if (job.cancelRequested) throw Object.assign(new Error('AI refinement aborted'), { code: 'AI_REFINEMENT_ABORTED' })
            if (!job.completedIds.includes(materialId)) job.completedIds.push(materialId)
            job.failed = job.failed.filter((item) => item.materialId !== materialId)
            delete job.checkpoints[materialId]
            job.currentMaterialId = null
            job.progress = { completed: job.completedIds.length, total: job.materialIds.length, title: '', itemCompleted: 0, itemTotal: 1 }
            await update(job)
            if (job.pauseRequested) break
          } catch (error) {
            job.currentMaterialId = null
            if (error?.code === 'AI_REFINEMENT_PAUSED') {
              job.pauseRequested = false
              await update(job, { status: 'paused' })
              return
            }
            if (isAbortError(error) || job.cancelRequested) {
              job.cancelRequested = false
              await update(job, { status: 'interrupted' })
              return
            }
            const message = error instanceof Error ? error.message : String(error)
            job.failed = [...job.failed.filter((item) => item.materialId !== materialId), { materialId, error: message }]
            await update(job)
          } finally {
            controllers.delete(job.id)
          }
        }

        job.currentMaterialId = null
        if (!job.cancelRequested && !job.pauseRequested && job.completedIds.length && typeof finalizeJob === 'function' && !job.finalizedAt) {
          job.progress = { completed: job.completedIds.length, total: job.materialIds.length, title: '正在整理课程级知识点…', itemCompleted: 0, itemTotal: 1 }
          await update(job, { finalizationError: null })
          const controller = new AbortController()
          controllers.set(job.id, controller)
          try {
            await finalizeJob({
              job: publicJob(job),
              documents: clone(job.documents),
              signal: controller.signal,
              onProgress: async (progress) => {
                job.progress = { ...job.progress, ...progress, completed: job.completedIds.length, total: job.materialIds.length }
                await update(job)
              },
            })
            await update(job, { finalizedAt: now(), finalizationError: null })
          } catch (error) {
            if (!isAbortError(error) && !job.cancelRequested) await update(job, { finalizationError: error instanceof Error ? error.message : String(error) })
          } finally {
            controllers.delete(job.id)
          }
        }
        if (job.cancelRequested) {
          job.cancelRequested = false
          await update(job, { status: 'interrupted' })
        } else if (job.pauseRequested) {
          job.pauseRequested = false
          await update(job, { status: 'paused' })
        } else if (job.completedIds.length === job.materialIds.length && !job.finalizationError) {
          await update(job, { status: 'completed' })
        } else if (job.failed.length || job.finalizationError) {
          await update(job, { status: 'completed_with_errors' })
        } else {
          await update(job, { status: 'failed' })
        }
      } catch (error) {
        job.currentMaterialId = null
        job.failed = [...job.failed, { materialId: '', error: error instanceof Error ? error.message : String(error) }]
        await update(job, { status: 'failed' })
      } finally {
        runners.delete(jobId)
      }
    })()
    runners.set(jobId, promise)
    return promise
  }

  async function initialize() {
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'))
      jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : []
    } catch {
      jobs = []
    }
    let changed = false
    for (const job of jobs) {
      job.documents = Array.isArray(job.documents) ? job.documents : []
      job.materialIds = Array.isArray(job.materialIds) ? job.materialIds : []
      job.completedIds = Array.isArray(job.completedIds) ? job.completedIds : []
      job.failed = Array.isArray(job.failed) ? job.failed : []
      job.checkpoints = job.checkpoints && typeof job.checkpoints === 'object' ? job.checkpoints : {}
      if (ACTIVE_STATUSES.has(job.status)) {
        job.status = 'interrupted'
        job.currentMaterialId = null
        job.pauseRequested = false
        job.cancelRequested = false
        job.updatedAt = now()
        changed = true
      }
    }
    if (changed) await persist()
    return jobs.map(publicJob)
  }

  async function start(payload) {
    if (jobs.some((job) => ACTIVE_STATUSES.has(job.status))) throw new Error('已有 AI 精炼任务正在运行，请先暂停或停止该任务')
    const selected = [...new Set((Array.isArray(payload?.materialIds) ? payload.materialIds : []).filter((id) => typeof id === 'string'))]
    const documents = (Array.isArray(payload?.documents) ? payload.documents : []).filter((document) => typeof document?.materialId === 'string')
    const selectedDocuments = documents.filter((document) => selected.includes(document.materialId))
    if (!selected.length || selectedDocuments.length !== selected.length) throw new Error('AI 精炼任务缺少有效资料')
    const timestamp = now()
    const job = {
      id: idFactory(),
      courseId: typeof payload?.courseId === 'string' ? payload.courseId : '',
      mode: payload?.mode === 'quick' || payload?.mode === 'deep' ? payload.mode : 'original',
      force: payload?.force === true,
      documents: clone(documents),
      materialIds: selected,
      completedIds: [],
      failed: [],
      checkpoints: {},
      currentMaterialId: selected[0],
      progress: { completed: 0, total: selected.length, title: selectedDocuments.find((item) => item.materialId === selected[0])?.title ?? selected[0], itemCompleted: 0, itemTotal: 1 },
      status: 'running',
      pauseRequested: false,
      cancelRequested: false,
      finalizedAt: null,
      finalizationError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    jobs = [job, ...jobs].slice(0, 20)
    await persist()
    emit(job)
    void run(job.id)
    return publicJob(job)
  }

  async function pause(jobId) {
    const job = findJob(jobId)
    if (job.status !== 'running') return publicJob(job)
    job.pauseRequested = true
    await update(job, { status: 'pausing' })
    return publicJob(job)
  }

  async function cancel(jobId) {
    const job = findJob(jobId)
    if (!ACTIVE_STATUSES.has(job.status) && job.status !== 'paused') return publicJob(job)
    job.cancelRequested = true
    job.pauseRequested = false
    await update(job, { status: 'cancelling' })
    controllers.get(job.id)?.abort()
    if (!runners.has(job.id)) {
      job.cancelRequested = false
      await update(job, { status: 'interrupted' })
    }
    return publicJob(job)
  }

  async function resume(jobId, { restart = false } = {}) {
    const job = findJob(jobId)
    if (jobs.some((item) => item.id !== job.id && ACTIVE_STATUSES.has(item.status))) throw new Error('已有 AI 精炼任务正在运行，请先暂停或停止该任务')
    if (!RESUMABLE_STATUSES.has(job.status) && job.status !== 'completed') throw new Error('当前 AI 精炼任务无法继续')
    if (restart) {
      job.completedIds = []
      job.failed = []
      job.checkpoints = {}
      job.finalizedAt = null
      job.finalizationError = null
    } else {
      job.failed = []
      job.finalizationError = null
    }
    if (!nextPending(job) && (job.finalizedAt || typeof finalizeJob !== 'function')) return publicJob(job)
    job.pauseRequested = false
    job.cancelRequested = false
    job.currentMaterialId = nextPending(job)
    job.progress = { completed: job.completedIds.length, total: job.materialIds.length, title: job.currentMaterialId ? job.documents.find((item) => item.materialId === job.currentMaterialId)?.title ?? job.currentMaterialId : '正在整理课程级知识点…', itemCompleted: 0, itemTotal: 1 }
    await update(job, { status: 'running' })
    void run(job.id)
    return publicJob(job)
  }

  async function dismiss(jobId) {
    const job = findJob(jobId)
    if (ACTIVE_STATUSES.has(job.status)) throw new Error('请先暂停或停止 AI 精炼任务')
    jobs = jobs.filter((item) => item.id !== job.id)
    await persist()
    return { removed: true }
  }

  function list() {
    return jobs.map(publicJob)
  }

  async function waitForIdle(jobId, timeoutMs = 5000) {
    const started = Date.now()
    while (runners.has(jobId) || ACTIVE_STATUSES.has(findJob(jobId).status)) {
      if (Date.now() - started > timeoutMs) throw new Error('等待 AI 精炼任务结束超时')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await persistChain
    return publicJob(findJob(jobId))
  }

  return { initialize, start, pause, cancel, resume, dismiss, list, waitForIdle }
}

module.exports = { createRefinementJobManager }
