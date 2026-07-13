const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('xuejing', {
  platform: process.platform,
  version: '1.0.0',
  app: {
    settings: () => ipcRenderer.invoke('app:settings'),
    saveSettings: (payload) => ipcRenderer.invoke('app:save-settings', payload),
    setZoomFactor: (factor) => { webFrame.setZoomFactor(factor); return factor },
  },
  external: {
    openUrl: (url) => ipcRenderer.invoke('external:open-url', url),
  },
  documents: {
    openLocal: (filePath) => ipcRenderer.invoke('document:open-local', filePath),
  },
  deadlines: {
    notify: (payload) => ipcRenderer.invoke('deadlines:notify', payload),
  },
  assignments: {
    details: (payload) => ipcRenderer.invoke('assignment:details', payload),
    importFiles: (payload) => ipcRenderer.invoke('assignment:import-files', payload),
    fileContents: (payload) => ipcRenderer.invoke('assignment:file-contents', payload),
    removeFiles: (payload) => ipcRenderer.invoke('assignment:remove-files', payload),
  },
  vault: {
    settings: () => ipcRenderer.invoke('vault:settings'),
    chooseRoot: () => ipcRenderer.invoke('vault:choose-root'),
    migrate: (payload) => ipcRenderer.invoke('vault:migrate', payload),
    verifyFiles: (payload) => ipcRenderer.invoke('vault:verify-files', payload),
    matchBlackboardFiles: (payload) => ipcRenderer.invoke('vault:match-blackboard-files', payload),
    repairExtensions: () => ipcRenderer.invoke('vault:repair-extensions'),
    importFiles: (payload) => ipcRenderer.invoke('vault:import-files', payload),
    onMigrationProgress: (listener) => {
      const callback = (_event, progress) => listener(progress)
      ipcRenderer.on('vault:migration-progress', callback)
      return () => ipcRenderer.removeListener('vault:migration-progress', callback)
    },
  },
  knowledge: {
    status: (payload) => ipcRenderer.invoke('knowledge:status', payload),
    build: (payload) => ipcRenderer.invoke('knowledge:build', payload),
    ocr: (payload) => ipcRenderer.invoke('knowledge:ocr', payload),
    ocrBatch: (payload) => ipcRenderer.invoke('knowledge:ocr-batch', payload),
    refine: (payload) => ipcRenderer.invoke('knowledge:refine', payload),
    refineBatch: (payload) => ipcRenderer.invoke('knowledge:refine-batch', payload),
    documentContent: (payload) => ipcRenderer.invoke('knowledge:document-content', payload),
    search: (payload) => ipcRenderer.invoke('knowledge:search', payload),
    documentFile: (payload) => ipcRenderer.invoke('knowledge:document-file', payload),
    onProgress: (listener) => {
      const callback = (_event, progress) => listener(progress)
      ipcRenderer.on('knowledge:progress', callback)
      return () => ipcRenderer.removeListener('knowledge:progress', callback)
    },
  },
  ai: {
    settings: () => ipcRenderer.invoke('ai:settings'),
    saveSettings: (payload) => ipcRenderer.invoke('ai:save-settings', payload),
    testConnection: (payload) => ipcRenderer.invoke('ai:test-connection', payload),
    chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  },
  email: {
    settings: () => ipcRenderer.invoke('email:settings'),
    saveSettings: (payload) => ipcRenderer.invoke('email:save-settings', payload),
    test: (payload) => ipcRenderer.invoke('email:test', payload),
    sendSyncUpdate: (payload) => ipcRenderer.invoke('email:send-sync-update', payload),
    sendDeadline: (payload) => ipcRenderer.invoke('email:send-deadline', payload),
    sendDeadlineDigest: (payload) => ipcRenderer.invoke('email:send-deadline-digest', payload),
  },
  credentials: {
    blackboard: () => ipcRenderer.invoke('credentials:blackboard'),
    saveBlackboard: (payload) => ipcRenderer.invoke('credentials:save-blackboard', payload),
    clearBlackboard: () => ipcRenderer.invoke('credentials:clear-blackboard'),
  },
  blackboard: {
    connect: () => ipcRenderer.invoke('blackboard:connect'),
    status: () => ipcRenderer.invoke('blackboard:status'),
    sync: () => ipcRenderer.invoke('blackboard:sync'),
    syncMaterials: (courses) => ipcRenderer.invoke('blackboard:sync-materials', courses),
    openSubmission: (url) => ipcRenderer.invoke('blackboard:open-submission', url),
    cacheFile: (payload) => ipcRenderer.invoke('blackboard:cache-file', payload),
    cacheFiles: (payload) => ipcRenderer.invoke('blackboard:cache-files', payload),
    disconnect: () => ipcRenderer.invoke('blackboard:disconnect'),
    onConnectionChanged: (listener) => {
      const callback = (_event, status) => listener(status)
      ipcRenderer.on('blackboard:connection-change', callback)
      return () => ipcRenderer.removeListener('blackboard:connection-change', callback)
    },
  },
  gradescope: {
    connect: () => ipcRenderer.invoke('gradescope:connect'),
    status: () => ipcRenderer.invoke('gradescope:status'),
    sync: () => ipcRenderer.invoke('gradescope:sync'),
    openSubmission: (url) => ipcRenderer.invoke('gradescope:open-submission', url),
    disconnect: () => ipcRenderer.invoke('gradescope:disconnect'),
    onConnectionChanged: (listener) => {
      const callback = (_event, status) => listener(status)
      ipcRenderer.on('gradescope:connection-change', callback)
      return () => ipcRenderer.removeListener('gradescope:connection-change', callback)
    },
  },
})
