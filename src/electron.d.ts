type BlackboardStatus = {
  connected: boolean
  portal: string
  cookieCount: number
}

type GradescopeSyncResult = {
  connected: boolean
  courses: { name: string; term: string; url: string }[]
  assignments: { courseName: string; term: string; title: string; url: string; meta: string; dueAt?: string; status: 'unknown' | 'not_submitted' | 'submitted' | 'graded'; score?: number; maxScore?: number }[]
  message: string
}

type BlackboardSyncResult = {
  connected: boolean
  courses: { name: string; url: string }[]
  message: string
  diagnostics?: {
    stage: string
    httpStatus?: number
    finalUrl?: string
    htmlBytes?: number
    courseLinkCount?: number
    pageType?: string
    error?: string
  }
}

type BlackboardMaterial = {
  title: string
  type: 'PPT' | 'PDF' | '视频' | '文件' | '网页' | '作业'
  kind: 'folder' | 'file' | 'link' | 'assignment'
  url?: string
  meta: string
  courseName: string
  path: string[]
  dueAt?: string
  status?: 'unknown' | 'not_submitted' | 'submitted' | 'graded'
  score?: number
  maxScore?: number
}

type BlackboardMaterialSyncResult = {
  connected: boolean
  materials: BlackboardMaterial[]
  message: string
  diagnostics?: {
    stage: string
    scannedCourses?: number
    scannedFolders?: number
    materialCount?: number
    failedCourses?: number
  }
}

type KnowledgeBuildDocument = {
  materialId: string
  courseId: string
  courseName: string
  title: string
  localPath: string
  type: string
  sourceUrl?: string
  knowledgeRole?: 'courseware' | 'reference'
}

type MaterialVersionCatalog = {
  groups: {
    materialId: string
    courseId: string
    baseTitle: string
    displayTitle: string
    relation: 'single' | 'versions' | 'source-conflict'
    activePath: string
    recommendedPath: string
    versions: { id: string; localPath: string; hash: string; importedAt: string; bytes: number; pages: number; descriptor: string; current: boolean }[]
  }[]
  duplicates: { hash: string; keepPath: string; duplicatePaths: string[]; safeCleanupPaths: string[] }[]
}

type KnowledgeLocation = { materialId: string; kind: 'pdf-page' | 'pptx-slide' | 'docx-section'; start: number; end?: number; confidence?: number; evidence?: string; method?: string; candidate?: boolean; manual?: boolean }

type KnowledgePageIndex = {
  version: number
  generatedAt: string
  pages: number
  concepts: number
  located: number
  candidates: number
  model?: string
  cloudError?: string
}

type KnowledgeIndexResult = {
  documents: { materialId: string; courseId: string; courseName: string; title: string; localPath: string; status: 'parsed' | 'ocr' | 'failed' | 'unsupported' | 'skipped' | 'empty' | 'image'; hash?: string; error?: string; outline?: string[]; outlineLocations?: { title: string; locations: KnowledgeLocation[] }[]; textLength?: number; segmentCount?: number; parsedAt?: string; knowledgeRole?: 'courseware' | 'reference'; ocr?: { pages: number; totalPages: number; language: string; truncated: boolean }; ai?: KnowledgeAiProfile; aiProfiles?: { quick?: KnowledgeAiProfile; deep?: KnowledgeAiProfile; original?: KnowledgeAiProfile } }[]
  concepts: { id: string; title: string; aliases?: string[]; sourceIds: string[]; courseIds: string[]; locations?: KnowledgeLocation[] }[]
  stats: { total: number; parsed: number; ocr: number; image: number; failed: number; unsupported: number; reference: number; concepts: number }
}

type KnowledgeAiProfile = { summary: string; concepts: { title: string; evidence: string; aliases?: string[]; locations?: KnowledgeLocation[]; locationCandidates?: KnowledgeLocation[] }[]; model: string; generatedAt: string; sourceHash?: string; mode?: 'quick' | 'deep' | 'original'; analysisMethod?: 'original-file' | 'structured-pages'; inputStrategy?: 'local-structured-pages'; originalFile?: { filename: string; bytes: number; uploadedAt: string }; locationBatches?: number; coverage?: { covered: number; total: number; percent: number; omittedRanges?: { kind: string; start: number; end: number }[] }; pageIndex?: KnowledgePageIndex }

type AiCapabilities = { provider: 'openai' | 'deepseek' | 'gemini' | 'custom'; chat: boolean; files: boolean; responses: boolean; refinementMode: 'original-file' | 'structured-pages'; detectedAt: string; latencyMs: number }
type AiSettings = { configured: boolean; provider: AiCapabilities['provider']; baseUrl: string; model: string; capabilities?: AiCapabilities }

export type RefinementJob = {
  id: string
  courseId: string
  mode: 'quick' | 'deep' | 'original'
  force: boolean
  status: 'running' | 'pausing' | 'paused' | 'cancelling' | 'interrupted' | 'completed' | 'completed_with_errors' | 'failed'
  materialIds: string[]
  items: { materialId: string; title: string; completed: boolean; failed?: string; checkpointed: boolean }[]
  completedIds: string[]
  failed: { materialId: string; error: string }[]
  checkpointedIds: string[]
  currentMaterialId: string | null
  progress: { completed: number; total: number; title: string; itemCompleted?: number; itemTotal?: number }
  createdAt: string
  updatedAt: string
  finalizedAt: string | null
  finalizationError: string | null
}

declare global {
  interface Window {
    xuejing?: {
      platform: string
      version: string
      app: {
        settings: () => Promise<{ keepRunningInTray: boolean }>
        saveSettings: (payload: { keepRunningInTray: boolean }) => Promise<{ keepRunningInTray: boolean }>
        setZoomFactor: (factor: number) => number
      }
      external: {
        openUrl: (url: string) => Promise<{ opened: boolean }>
      }
      documents: {
        openLocal: (filePath: string) => Promise<{ opened: boolean }>
      }
      deadlines: {
        notify: (payload: { title: string; body: string }) => Promise<{ shown: boolean }>
      }
      assignments: {
        details: (payload: { source: 'Blackboard' | 'Gradescope'; url: string }) => Promise<{ text: string; fetchedAt: string }>
        importFiles: (payload: { courseName: string; assignmentId: string; assignmentTitle: string }) => Promise<{
          cancelled: boolean
          vaultRoot?: string
          items: { id: string; title: string; type: 'PPT' | 'PDF' | '视频' | '文件'; localPath: string; managed: boolean }[]
        }>
        fileContents: (payload: { files: { localPath: string; title: string }[] }) => Promise<{ contents: { localPath: string; title: string; text: string; format?: string; error?: string }[] }>
        removeFiles: (payload: { assignmentId: string; filePaths: string[] }) => Promise<{ removed: string[]; missing: string[]; rejected: string[] }>
      }
      vault: {
        settings: () => Promise<{ vaultRoot: string }>
        chooseRoot: () => Promise<{ cancelled: boolean; currentRoot: string; vaultRoot?: string }>
        migrate: (payload: { targetRoot: string; mode: 'copy' | 'move' | 'switch' }) => Promise<{
          vaultRoot: string; copied: number; deduplicated: number; moved: number; missing: number
          relocated: { from: string; to: string }[]; failed: { path: string; error: string }[]
        }>
        verifyFiles: (payload: { paths: string[] }) => Promise<{ path: string; exists: boolean; bytes: number }[]>
        matchBlackboardFiles: (payload: { urls: string[] }) => Promise<{ url: string; localPath: string; title: string; type: 'PPT' | 'PDF' | '视频' | '文件' }[]>
        repairExtensions: () => Promise<{ repaired: number; repairedFiles: { from: string; to: string }[]; vaultRoot: string }>
        materialVersions: (payload: { documents: KnowledgeBuildDocument[] }) => Promise<MaterialVersionCatalog>
        cleanupDuplicates: (payload: { documents: KnowledgeBuildDocument[]; paths: string[] }) => Promise<{ removed: string[]; rejected: string[] }>
        importFiles: (payload: { courseName: string; folderPath: string[] }) => Promise<{
          cancelled: boolean
          vaultRoot?: string
          items: { id: string; title: string; type: 'PPT' | 'PDF' | '视频' | '文件'; meta: string; path: string[]; localPath: string; deduplicated: boolean }[]
        }>
        onMigrationProgress: (listener: (progress: { completed: number; total: number; title: string }) => void) => () => void
      }
      knowledge: {
        status: (payload: { documents: KnowledgeBuildDocument[] }) => Promise<KnowledgeIndexResult>
        build: (payload: { documents: KnowledgeBuildDocument[] }) => Promise<KnowledgeIndexResult>
        ocr: (payload: { documents: KnowledgeBuildDocument[]; materialId: string }) => Promise<KnowledgeIndexResult>
        ocrBatch: (payload: { documents: KnowledgeBuildDocument[]; materialIds: string[] }) => Promise<KnowledgeIndexResult & { batch: { completed: number; failed: { materialId: string; error: string }[] } }>
        refine: (payload: { documents: KnowledgeBuildDocument[]; materialId: string; force?: boolean }) => Promise<KnowledgeIndexResult>
        refineBatch: (payload: { documents: KnowledgeBuildDocument[]; materialIds: string[]; force?: boolean }) => Promise<KnowledgeIndexResult & { batch: { completed: number; failed: { materialId: string; error: string }[] } }>
        reindexPages: (payload: { documents: KnowledgeBuildDocument[]; materialId: string; useCloud?: boolean }) => Promise<KnowledgeIndexResult>
        reindexPagesBatch: (payload: { documents: KnowledgeBuildDocument[]; materialIds: string[]; useCloud?: boolean }) => Promise<KnowledgeIndexResult & { batch: { completed: number; failed: { materialId: string; error: string }[] } }>
        updatePageLocation: (payload: { documents: KnowledgeBuildDocument[]; materialId: string; conceptTitle: string; action: 'add' | 'remove' | 'confirm' | 'reject'; location: Pick<KnowledgeLocation, 'kind' | 'start' | 'end'> }) => Promise<KnowledgeIndexResult>
        refinementJobs: () => Promise<RefinementJob[]>
        startRefinementJob: (payload: { documents: KnowledgeBuildDocument[]; materialIds: string[]; courseId: string; mode?: 'original'; force?: boolean }) => Promise<RefinementJob>
        pauseRefinementJob: (jobId: string) => Promise<RefinementJob>
        cancelRefinementJob: (jobId: string) => Promise<RefinementJob>
        resumeRefinementJob: (payload: { jobId: string; restart?: boolean }) => Promise<RefinementJob>
        dismissRefinementJob: (jobId: string) => Promise<{ removed: boolean }>
        documentContent: (payload: { documents: KnowledgeBuildDocument[]; materialId: string }) => Promise<{ materialId: string; title: string; courseName: string; format: string; text: string; textLength: number }>
        search: (payload: { documents: KnowledgeBuildDocument[]; query: string; limit?: number }) => Promise<{ materialId: string; title: string; courseId: string; courseName: string; snippet: string; score: number }[]>
        documentFile: (payload: { documents: KnowledgeBuildDocument[]; materialId: string }) => Promise<{ materialId: string; title: string; format: 'pdf' | 'docx' | 'pptx' | 'ppt' | 'unknown'; bytes: Uint8Array }>
        onProgress: (listener: (progress: { completed: number; total: number; title: string }) => void) => () => void
        onRefinementJobChange: (listener: (job: RefinementJob) => void) => () => void
      }
      ai: {
        settings: () => Promise<AiSettings>
        presets: () => Promise<{ id: AiCapabilities['provider']; label: string; baseUrl: string; description: string }[]>
        saveSettings: (payload: { provider: AiCapabilities['provider']; baseUrl: string; model: string; apiKey?: string; capabilities?: AiCapabilities }) => Promise<AiSettings>
        testConnection: (payload: { provider: AiCapabilities['provider']; baseUrl: string; model: string; apiKey?: string }) => Promise<{ model: string; latencyMs: number; capabilities: AiCapabilities }>
        listModels: (payload: { provider: AiCapabilities['provider']; baseUrl: string; model?: string; apiKey?: string }) => Promise<{ provider: AiCapabilities['provider']; models: string[]; source: string }>
        chat: (payload: { context: string; messages: { role: 'user' | 'assistant'; content: string }[] }) => Promise<{ content: string; model: string }>
      }
      email: {
        settings: () => Promise<{ configured: boolean; enabled: boolean; host: string; port: number; secure: boolean; username: string; from: string; recipient: string; notifyCourseUpdates: boolean; notifyDeadlines: boolean; syncEmailMode: 'important' | 'daily' | 'every_sync' | 'off'; syncDigestHour: number }>
        saveSettings: (payload: { enabled: boolean; host: string; port: number; secure: boolean; username: string; from?: string; recipient: string; notifyCourseUpdates: boolean; notifyDeadlines: boolean; syncEmailMode: 'important' | 'daily' | 'every_sync' | 'off'; syncDigestHour: number; password?: string }) => Promise<{ configured: boolean; enabled: boolean; host: string; port: number; secure: boolean; username: string; from: string; recipient: string; notifyCourseUpdates: boolean; notifyDeadlines: boolean; syncEmailMode: 'important' | 'daily' | 'every_sync' | 'off'; syncDigestHour: number }>
        test: (payload: { host: string; port: number; secure: boolean; username: string; from?: string; recipient: string; password?: string }) => Promise<{ sent: boolean; messageId: string; latencyMs: number }>
        sendSyncUpdate: (payload: { events: { title: string; detail: string; source: string; kind?: string; courseId?: string }[] }) => Promise<{ sent: boolean; skipped?: boolean; messageId?: string }>
        sendDeadline: (payload: { course: string; title: string; deadline: string; label: string }) => Promise<{ sent: boolean; skipped?: boolean; messageId?: string }>
        sendDeadlineDigest: (payload: { items: { course: string; title: string; deadline: string; label: string }[] }) => Promise<{ sent: boolean; skipped?: boolean; messageId?: string }>
      }
      credentials: {
        blackboard: () => Promise<{ configured: boolean; username: string }>
        saveBlackboard: (payload: { username: string; password?: string }) => Promise<{ configured: boolean; username: string }>
        clearBlackboard: () => Promise<{ configured: boolean; username: string }>
      }
      blackboard: {
        connect: () => Promise<{ started: boolean; portal: string }>
        status: () => Promise<BlackboardStatus>
        sync: () => Promise<BlackboardSyncResult>
        syncMaterials: (courses: { name: string; url: string }[]) => Promise<BlackboardMaterialSyncResult>
        openSubmission: (url: string) => Promise<{ opened: boolean }>
        cacheFile: (payload: { url: string; title: string; courseName: string; folderPath: string[] }) => Promise<{
          vaultRoot: string
          item: { id: string; title: string; type: 'PPT' | 'PDF' | '视频' | '文件'; meta: string; path: string[]; localPath: string; deduplicated: boolean }
        }>
        cacheFiles: (payload: { files: { clientId?: string; url: string; title: string; courseName: string; folderPath: string[] }[] }) => Promise<{
          completed: { clientId?: string; url: string; vaultRoot: string; item: { id: string; title: string; type: 'PPT' | 'PDF' | '视频' | '文件'; meta: string; path: string[]; localPath: string; deduplicated: boolean } }[]
          failed: { url: string; title: string; error: string }[]
        }>
        disconnect: () => Promise<{ connected: boolean }>
        onConnectionChanged: (listener: (status: BlackboardStatus) => void) => () => void
      }
      gradescope: {
        connect: () => Promise<{ started: boolean; portal: string }>
        status: () => Promise<BlackboardStatus>
        sync: () => Promise<GradescopeSyncResult>
        openSubmission: (url: string) => Promise<{ opened: boolean }>
        disconnect: () => Promise<{ connected: boolean }>
        onConnectionChanged: (listener: (status: BlackboardStatus) => void) => () => void
      }
    }
  }
}

export {}
