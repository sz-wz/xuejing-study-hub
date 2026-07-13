const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, session, shell, Tray } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { classifyBlackboardPage, parseCourseLinks } = require('./blackboard-portal.cjs')
const { createSuccessfulLoginGate } = require('./blackboard-connection.cjs')
const { parseAttachments, parseContentLinks, parseExternalLinks } = require('./blackboard-content.cjs')
const { parseBlackboardAssignmentDetails } = require('./blackboard-assignment.cjs')
const { extractAssignmentText } = require('./assignment-analysis.cjs')
const { GRADESCOPE_ORIGIN, classifyGradescopePage, hasGradescopeSessionCookie, isGradescopeAuthenticatedPage, parseGradescopeAssignments, parseGradescopeCourses } = require('./gradescope-portal.cjs')
const { findBlackboardCachedFiles, importAssignmentFilesToVault, importBufferToVault, importFilesToVault, migrateVault, removeAssignmentFilesFromVault, repairVaultExtensions, verifyVaultFiles } = require('./vault.cjs')
const { buildKnowledgeIndex, extractLocalDocumentText, knowledgeStatus, ocrKnowledgeDocument, ocrKnowledgeDocuments, refineKnowledgeDocument, refineKnowledgeDocuments, readKnowledgeDocumentContent, searchKnowledgeDocuments } = require('./knowledge.cjs')
const { findPreviewDocument, readPreviewFile } = require('./document-preview.cjs')
const { refineKnowledgeWithCloud, testCloudConnection, chatWithCloud } = require('./cloud-knowledge.cjs')
const { sendToRenderer } = require('./renderer-events.cjs')
const { normalizeAppBehavior } = require('./app-preferences.cjs')
const { createTrayIconPng } = require('./tray-icon.cjs')
const { buildDeadlineDigestMessage, buildDeadlineMessage, buildSyncUpdateMessage, normalizeEmailSettings, publicEmailSettings, sendMail, testEmailConnection, validateEmailSettings } = require('./email-notifications.cjs')

const isDev = !app.isPackaged
const BLACKBOARD_ORIGIN = 'https://elearning.shanghaitech.edu.cn:8443'
const BLACKBOARD_PORTAL_URL = `${BLACKBOARD_ORIGIN}/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1`
const BLACKBOARD_PARTITION = 'persist:shanghaitech-blackboard'
const GRADESCOPE_PARTITION = 'persist:gradescope'
const MAX_COURSES_PER_SYNC = 30
const MAX_CONTENT_PAGES_PER_COURSE = 24
const MAX_CACHE_BYTES = 512 * 1024 * 1024

let mainWindow
let loginWindow
let gradescopeLoginWindow
let blackboardConnected = false
let gradescopeConnected = false
let gradescopeSessionKnownInvalid = false
let tray
let isQuitting = false
let appBehavior = normalizeAppBehavior()

function getBlackboardSession() {
  return session.fromPartition(BLACKBOARD_PARTITION)
}

function getGradescopeSession() {
  return session.fromPartition(GRADESCOPE_PARTITION)
}

function defaultVaultRoot() {
  return path.join(app.getPath('documents'), '学径知识库')
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'xuejing-settings.json')
}

async function readSettings() {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true })
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}

async function appBehaviorSettings() {
  const settings = await readSettings()
  return normalizeAppBehavior(settings.appBehavior)
}

function trayIcon() {
  return nativeImage.createFromBuffer(createTrayIconPng()).resize({ width: 16, height: 16 })
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow()
  mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function syncTray() {
  if (!appBehavior.keepRunningInTray) {
    tray?.destroy()
    tray = undefined
    return
  }
  if (tray) return
  tray = new Tray(trayIcon())
  tray.setToolTip('学径')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开学径', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('double-click', showMainWindow)
}

async function saveAppBehavior(payload) {
  appBehavior = normalizeAppBehavior(payload)
  const existing = await readSettings()
  await writeSettings({ ...existing, appBehavior })
  syncTray()
  return appBehavior
}

async function vaultSettings() {
  try {
    const parsed = await readSettings()
    const vaultRoot = typeof parsed.vaultRoot === 'string' && path.isAbsolute(parsed.vaultRoot) ? parsed.vaultRoot : defaultVaultRoot()
    await fs.mkdir(vaultRoot, { recursive: true })
    return { vaultRoot }
  } catch {
    const vaultRoot = defaultVaultRoot()
    await fs.mkdir(vaultRoot, { recursive: true })
    return { vaultRoot }
  }
}

async function saveVaultRoot(vaultRoot) {
  await fs.mkdir(vaultRoot, { recursive: true })
  const existing = await readSettings()
  await writeSettings({ ...existing, vaultRoot })
  return { vaultRoot }
}

function publicAiSettings(settings) {
  const ai = settings.ai && typeof settings.ai === 'object' ? settings.ai : {}
  return {
    configured: Boolean(ai.encryptedApiKey && ai.baseUrl && ai.model),
    baseUrl: typeof ai.baseUrl === 'string' ? ai.baseUrl : '',
    model: typeof ai.model === 'string' ? ai.model : '',
  }
}

async function aiSettings() {
  return publicAiSettings(await readSettings())
}

async function emailSettings() {
  const settings = await readSettings()
  return publicEmailSettings(settings.email)
}

async function saveEmailSettings(payload) {
  const existing = await readSettings()
  const current = normalizeEmailSettings(existing.email)
  const next = normalizeEmailSettings({ ...current, ...payload })
  const suppliedPassword = typeof payload?.password === 'string' ? payload.password : ''
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存邮箱密码')
  const encryptedPassword = suppliedPassword ? safeStorage.encryptString(suppliedPassword).toString('base64') : current.encryptedPassword
  validateEmailSettings({ ...next, encryptedPassword }, true)
  const stored = { ...next, encryptedPassword }
  delete stored.password
  await writeSettings({ ...existing, email: stored })
  return publicEmailSettings(stored)
}

async function privateEmailSettings(payload = {}) {
  const settings = await readSettings()
  const saved = normalizeEmailSettings(settings.email)
  const merged = normalizeEmailSettings({ ...saved, ...payload })
  const suppliedPassword = typeof payload?.password === 'string' ? payload.password : ''
  const encryptedPassword = saved.encryptedPassword
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取邮箱密码')
  const password = suppliedPassword || (encryptedPassword ? safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64')) : '')
  return validateEmailSettings({ ...merged, password }, true)
}

async function sendSyncUpdateEmail(payload) {
  const publicSettings = await emailSettings()
  if (!publicSettings.enabled || !publicSettings.configured || !publicSettings.notifyCourseUpdates) return { sent: false, skipped: true }
  const settings = await privateEmailSettings()
  const message = buildSyncUpdateMessage(payload?.events)
  if (!message.count) return { sent: false, skipped: true }
  return sendMail(settings, message)
}

async function sendDeadlineEmail(payload) {
  const publicSettings = await emailSettings()
  if (!publicSettings.enabled || !publicSettings.configured || !publicSettings.notifyDeadlines) return { sent: false, skipped: true }
  const settings = await privateEmailSettings()
  return sendMail(settings, buildDeadlineMessage(payload))
}

async function sendDeadlineDigestEmail(payload) {
  const publicSettings = await emailSettings()
  if (!publicSettings.enabled || !publicSettings.configured || !publicSettings.notifyDeadlines) return { sent: false, skipped: true }
  const settings = await privateEmailSettings()
  return sendMail(settings, buildDeadlineDigestMessage(payload?.items))
}

async function saveAiSettings(payload) {
  const baseUrl = typeof payload?.baseUrl === 'string' ? payload.baseUrl.trim().replace(/\/+$/, '') : ''
  const model = typeof payload?.model === 'string' ? payload.model.trim() : ''
  const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : ''
  if (!baseUrl || !model) throw new Error('请填写云端 API 地址和模型名称')
  try {
    const parsed = new URL(baseUrl)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('invalid protocol')
  } catch {
    throw new Error('云端 API 地址无效')
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存云端 API 密钥')
  const existing = await readSettings()
  const currentAi = existing.ai && typeof existing.ai === 'object' ? existing.ai : {}
  const encryptedApiKey = apiKey ? safeStorage.encryptString(apiKey).toString('base64') : currentAi.encryptedApiKey
  if (!encryptedApiKey) throw new Error('请首次保存时填写云端 API 密钥')
  const settings = { ...existing, ai: { baseUrl, model, encryptedApiKey } }
  await writeSettings(settings)
  return publicAiSettings(settings)
}

async function privateAiSettings() {
  const settings = await readSettings()
  const ai = settings.ai && typeof settings.ai === 'object' ? settings.ai : {}
  if (!ai.encryptedApiKey || !ai.baseUrl || !ai.model) throw new Error('请先在 AI 设置中保存云端 API 配置')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取云端 API 密钥')
  return { baseUrl: ai.baseUrl, model: ai.model, apiKey: safeStorage.decryptString(Buffer.from(ai.encryptedApiKey, 'base64')) }
}

function publicBlackboardCredentials(settings) {
  const credentials = settings.blackboardCredentials && typeof settings.blackboardCredentials === 'object' ? settings.blackboardCredentials : {}
  return {
    configured: Boolean(credentials.username && credentials.encryptedPassword),
    username: typeof credentials.username === 'string' ? credentials.username : '',
  }
}

async function blackboardCredentials() {
  return publicBlackboardCredentials(await readSettings())
}

async function saveBlackboardCredentials(payload) {
  const username = typeof payload?.username === 'string' ? payload.username.trim() : ''
  const password = typeof payload?.password === 'string' ? payload.password : ''
  if (!username) throw new Error('请填写 Blackboard 账号')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 Blackboard 密码')
  const existing = await readSettings()
  const current = existing.blackboardCredentials && typeof existing.blackboardCredentials === 'object' ? existing.blackboardCredentials : {}
  const encryptedPassword = password ? safeStorage.encryptString(password).toString('base64') : current.encryptedPassword
  if (!encryptedPassword) throw new Error('首次保存时请填写 Blackboard 密码')
  const settings = { ...existing, blackboardCredentials: { username, encryptedPassword } }
  await writeSettings(settings)
  return publicBlackboardCredentials(settings)
}

async function clearBlackboardCredentials() {
  const settings = await readSettings()
  const { blackboardCredentials, ...rest } = settings
  await writeSettings(rest)
  return { configured: false, username: '' }
}

function portableGradescopeCookie(cookie) {
  const domain = String(cookie?.domain ?? 'www.gradescope.com').replace(/^\./, '') || 'www.gradescope.com'
  const sameSite = ['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie?.sameSite) ? cookie.sameSite : undefined
  return {
    url: `${cookie?.secure === false ? 'http' : 'https'}://${domain}${String(cookie?.path ?? '/').startsWith('/') ? cookie.path ?? '/' : '/'}`,
    name: String(cookie?.name ?? ''),
    value: String(cookie?.value ?? ''),
    domain: cookie?.hostOnly ? undefined : cookie?.domain,
    path: String(cookie?.path ?? '/'),
    secure: cookie?.secure !== false,
    httpOnly: Boolean(cookie?.httpOnly),
    sameSite,
    expirationDate: typeof cookie?.expirationDate === 'number' ? cookie.expirationDate : undefined,
  }
}

async function persistGradescopeSession() {
  if (!safeStorage.isEncryptionAvailable()) return false
  const cookies = await getGradescopeSession().cookies.get({ url: GRADESCOPE_ORIGIN })
  if (!cookies.some((cookie) => hasGradescopeSessionCookie([cookie]))) return false
  const existing = await readSettings()
  const encoded = safeStorage.encryptString(JSON.stringify(cookies.map(portableGradescopeCookie))).toString('base64')
  await writeSettings({ ...existing, gradescopeSessionCookies: encoded })
  return true
}

async function restoreGradescopeSession() {
  if (!safeStorage.isEncryptionAvailable()) return false
  const settings = await readSettings()
  if (typeof settings.gradescopeSessionCookies !== 'string') return false
  try {
    const cookies = JSON.parse(safeStorage.decryptString(Buffer.from(settings.gradescopeSessionCookies, 'base64')))
    if (!Array.isArray(cookies)) return false
    for (const cookie of cookies.slice(0, 40)) {
      if (!cookie?.name || typeof cookie.value !== 'string' || typeof cookie.url !== 'string') continue
      await getGradescopeSession().cookies.set(cookie)
    }
    return true
  } catch {
    const { gradescopeSessionCookies, ...rest } = settings
    await writeSettings(rest)
    return false
  }
}

async function clearPersistedGradescopeSession() {
  const settings = await readSettings()
  if (!Object.hasOwn(settings, 'gradescopeSessionCookies')) return
  const { gradescopeSessionCookies, ...rest } = settings
  await writeSettings(rest)
}

async function privateBlackboardCredentials() {
  const settings = await readSettings()
  const credentials = settings.blackboardCredentials && typeof settings.blackboardCredentials === 'object' ? settings.blackboardCredentials : {}
  if (!credentials.username || !credentials.encryptedPassword || !safeStorage.isEncryptionAvailable()) return null
  try {
    return { username: credentials.username, password: safeStorage.decryptString(Buffer.from(credentials.encryptedPassword, 'base64')) }
  } catch {
    return null
  }
}

async function aiSettingsForTest(payload) {
  const settings = await readSettings()
  const saved = settings.ai && typeof settings.ai === 'object' ? settings.ai : {}
  const baseUrl = typeof payload?.baseUrl === 'string' && payload.baseUrl.trim() ? payload.baseUrl.trim().replace(/\/+$/, '') : saved.baseUrl
  const model = typeof payload?.model === 'string' && payload.model.trim() ? payload.model.trim() : saved.model
  const suppliedKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : ''
  if (suppliedKey) return { baseUrl, model, apiKey: suppliedKey }
  if (!saved.encryptedApiKey) throw new Error('请填写 API 密钥，或先保存一份可复用的 AI 配置')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取已保存的云端 API 密钥')
  return { baseUrl, model, apiKey: safeStorage.decryptString(Buffer.from(saved.encryptedApiKey, 'base64')) }
}

function isTrustedBlackboardUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin === BLACKBOARD_ORIGIN && parsed.pathname.startsWith('/webapps/')
  } catch {
    return false
  }
}

function isTrustedUniversityAuthUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && (parsed.hostname === 'shanghaitech.edu.cn' || parsed.hostname.endsWith('.shanghaitech.edu.cn'))
  } catch {
    return false
  }
}

function isTrustedBlackboardResourceUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin === BLACKBOARD_ORIGIN
      && (parsed.pathname.startsWith('/webapps/') || parsed.pathname.startsWith('/bbcswebdav/'))
  } catch {
    return false
  }
}

function filenameFromDisposition(value) {
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (utf8) {
    try { return decodeURIComponent(utf8) } catch { return utf8 }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1]
}

async function fetchBlackboardHtml(url) {
  if (!isTrustedBlackboardUrl(url)) throw new Error('拒绝访问非 Blackboard 课程页面')
  const response = await getBlackboardSession().fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Blackboard 返回 HTTP ${response.status}`)
  return response.text()
}

function looksLikeAssignment(title, url) {
  return /(?:^|\b)(?:hw|homework)\s*\d+|作业|assignment|quiz|project|考试|exam/i.test(title)
    || /assignment|uploadAssignment|submit/i.test(url)
}

async function scanCourseMaterials(course) {
  const courseHtml = await fetchBlackboardHtml(course.url)
  const roots = parseContentLinks(courseHtml, course.url)
  if (roots.length === 0) return { materials: [], folders: 0 }

  const entries = new Map()
  const visited = new Set()
  let pagesScanned = 0
  const add = (item) => {
    const key = item.url ? `${item.kind}:${item.url}` : `${item.kind}:${item.path.join('/')}`
    entries.set(key, item)
  }
  const scanPage = async (page, folderPath, depth) => {
    if (depth > 4 || visited.has(page.url) || pagesScanned >= MAX_CONTENT_PAGES_PER_COURSE) return
    visited.add(page.url)
    pagesScanned += 1
    const html = await fetchBlackboardHtml(page.url)
    add({ kind: 'folder', type: '文件', title: folderPath.at(-1), path: folderPath, courseName: course.name, meta: 'Blackboard 文件夹' })
    for (const attachment of parseAttachments(html, page.url)) add({ ...attachment, kind: 'file', path: folderPath, courseName: course.name })
    for (const link of parseExternalLinks(html, page.url)) add({ ...link, kind: 'link', path: folderPath, courseName: course.name })
    for (const child of parseContentLinks(html, page.url)) {
      if (child.url === page.url || visited.has(child.url)) continue
      if (looksLikeAssignment(child.title, child.url)) {
        let details = {}
        try { details = parseBlackboardAssignmentDetails(await fetchBlackboardHtml(child.url)) } catch { /* 作业详情读取失败时仍保留提交入口。 */ }
        add({ kind: 'assignment', type: '作业', title: child.title, url: child.url, meta: details.dueLabel || 'Blackboard 作业', path: folderPath, courseName: course.name, ...details })
      } else {
        await scanPage(child, [...folderPath, child.title], depth + 1)
      }
    }
  }
  for (const root of roots) await scanPage(root, [root.title], 0)
  return { materials: [...entries.values()], folders: pagesScanned }
}

async function blackboardStatus() {
  const cookies = await getBlackboardSession().cookies.get({ url: BLACKBOARD_ORIGIN })
  const hasSessionCookie = cookies.some((cookie) => /session|sso|token/i.test(cookie.name))
  return { connected: blackboardConnected || hasSessionCookie, portal: BLACKBOARD_ORIGIN, cookieCount: cookies.length }
}

function broadcastBlackboardStatus() {
  blackboardStatus().then((status) => sendToRenderer(mainWindow, 'blackboard:connection-change', status))
}

function openBlackboardLogin() {
  if (loginWindow && !loginWindow.isDestroyed()) return loginWindow.focus()
  loginWindow = new BrowserWindow({
    width: 1120, height: 820, minWidth: 900, minHeight: 650,
    title: '连接 Blackboard · 上海科技大学统一身份认证', autoHideMenuBar: true,
    webPreferences: { partition: BLACKBOARD_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const successfulLoginGate = createSuccessfulLoginGate(() => {
    setTimeout(() => {
      blackboardConnected = true
      broadcastBlackboardStatus()
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
    }, 700)
  })
  const detectSuccessfulLogin = (_event, url) => successfulLoginGate.reportNavigation(url)
  loginWindow.webContents.on('did-navigate', detectSuccessfulLogin)
  loginWindow.webContents.on('did-navigate-in-page', detectSuccessfulLogin)
  loginWindow.webContents.on('did-finish-load', () => {
    void (async () => {
      if (!loginWindow || loginWindow.isDestroyed() || !isTrustedUniversityAuthUrl(loginWindow.webContents.getURL())) return
      const credentials = await privateBlackboardCredentials()
      if (!credentials || !loginWindow || loginWindow.isDestroyed()) return
      const script = `(() => {
        const username = ${JSON.stringify(credentials.username)};
        const password = ${JSON.stringify(credentials.password)};
        const userInput = document.querySelector('#username, input[name="username"], input[name="un"], input[type="text"]');
        const passwordInput = document.querySelector('#password, input[name="password"], input[type="password"]');
        const assign = (input, value) => {
          if (!input || input.value) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        assign(userInput, username);
        assign(passwordInput, password);
      })()`
      try { await loginWindow.webContents.executeJavaScript(script, true) } catch { /* 认证页跳转时无需中断登录窗口。 */ }
    })()
  })
  loginWindow.webContents.setWindowOpenHandler(({ url }) => { loginWindow?.loadURL(url); return { action: 'deny' } })
  loginWindow.on('closed', () => { loginWindow = undefined })
  loginWindow.loadURL(BLACKBOARD_PORTAL_URL)
}

function isTrustedGradescopeUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin === GRADESCOPE_ORIGIN && (/^\/account\/?$/.test(parsed.pathname) || /^\/courses\/\d+/.test(parsed.pathname))
  } catch {
    return false
  }
}

async function gradescopeStatus() {
  const cookies = await getGradescopeSession().cookies.get({ url: GRADESCOPE_ORIGIN })
  const hasSessionCookie = hasGradescopeSessionCookie(cookies)
  return { connected: gradescopeConnected || (!gradescopeSessionKnownInvalid && hasSessionCookie), portal: GRADESCOPE_ORIGIN, cookieCount: cookies.length }
}

function broadcastGradescopeStatus() {
  gradescopeStatus().then((status) => sendToRenderer(mainWindow, 'gradescope:connection-change', status))
}

function openGradescopeLogin() {
  if (gradescopeLoginWindow && !gradescopeLoginWindow.isDestroyed()) return gradescopeLoginWindow.focus()
  gradescopeLoginWindow = new BrowserWindow({
    width: 1120, height: 820, minWidth: 900, minHeight: 650,
    title: '连接 Gradescope', autoHideMenuBar: true,
    webPreferences: { partition: GRADESCOPE_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  let completed = false
  let checking = false
  const detectSuccessfulLogin = async (_event, url) => {
    if (completed || checking || !isGradescopeAuthenticatedPage(url)) return
    checking = true
    try {
      const html = await gradescopeLoginWindow?.webContents.executeJavaScript('document.documentElement.outerHTML', true)
      if (classifyGradescopePage(html) !== 'authenticated') return
      completed = true
      gradescopeConnected = true
      gradescopeSessionKnownInvalid = false
      try { await persistGradescopeSession() } catch { /* 会话仍在持久分区中可用；安全备份失败不阻断登录。 */ }
      broadcastGradescopeStatus()
      if (gradescopeLoginWindow && !gradescopeLoginWindow.isDestroyed()) gradescopeLoginWindow.close()
    } catch {
      // 页面仍在跳转或已关闭时，等待下一次导航再验证。
    } finally {
      checking = false
    }
  }
  gradescopeLoginWindow.webContents.on('did-navigate', detectSuccessfulLogin)
  gradescopeLoginWindow.webContents.on('did-navigate-in-page', detectSuccessfulLogin)
  gradescopeLoginWindow.webContents.on('did-finish-load', () => detectSuccessfulLogin(undefined, gradescopeLoginWindow?.webContents.getURL()))
  gradescopeLoginWindow.webContents.setWindowOpenHandler(({ url }) => { gradescopeLoginWindow?.loadURL(url); return { action: 'deny' } })
  gradescopeLoginWindow.on('closed', () => { gradescopeLoginWindow = undefined })
  gradescopeLoginWindow.loadURL(`${GRADESCOPE_ORIGIN}/account`)
}

async function fetchGradescopeHtml(url) {
  if (!isTrustedGradescopeUrl(url)) throw new Error('拒绝访问非 Gradescope 课程页面')
  const response = await getGradescopeSession().fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Gradescope 返回 HTTP ${response.status}`)
  return { html: await response.text(), finalUrl: response.url }
}

async function syncGradescope() {
  const status = await gradescopeStatus()
  if (!status.connected) return { connected: false, courses: [], assignments: [], message: '请先完成 Gradescope 登录' }
  try {
    const page = await fetchGradescopeHtml(`${GRADESCOPE_ORIGIN}/account`)
    if ((page.finalUrl && !isGradescopeAuthenticatedPage(page.finalUrl)) || classifyGradescopePage(page.html) !== 'authenticated') {
      gradescopeConnected = false
      gradescopeSessionKnownInvalid = true
      broadcastGradescopeStatus()
      return { connected: false, courses: [], assignments: [], message: 'Gradescope 登录会话已过期，请重新连接' }
    }
    const courses = parseGradescopeCourses(page.html)
    const assignments = []
    let failedCourses = 0
    let sessionExpired = false
    for (const course of courses) {
      try {
        const coursePage = await fetchGradescopeHtml(course.url)
        if (classifyGradescopePage(coursePage.html) !== 'authenticated') {
          sessionExpired = true
          break
        }
        assignments.push(...parseGradescopeAssignments(coursePage.html, course.term).map((assignment) => ({ ...assignment, courseName: course.name, term: course.term })))
      } catch {
        failedCourses += 1
      }
    }
    if (sessionExpired) {
      gradescopeConnected = false
      gradescopeSessionKnownInvalid = true
      broadcastGradescopeStatus()
      return { connected: false, courses: [], assignments: [], message: 'Gradescope 登录会话已过期，请重新连接' }
    }
    gradescopeConnected = true
    gradescopeSessionKnownInvalid = false
    try { await persistGradescopeSession() } catch { /* 不影响已完成的同步。 */ }
    return {
      connected: true,
      courses,
      assignments,
      message: `已从 Gradescope 读取 ${courses.length} 门课程、${assignments.length} 个作业提交入口${failedCourses ? `；${failedCourses} 门课程读取失败` : ''}`,
    }
  } catch (error) {
    return { connected: status.connected, courses: [], assignments: [], message: 'Gradescope 同步请求未完成：' + (error instanceof Error ? error.message : String(error)) }
  }
}

async function readAssignmentDetails(payload) {
  const source = payload?.source
  const url = typeof payload?.url === 'string' ? payload.url : ''
  if (source !== 'Blackboard') throw new Error('Gradescope 作业请在网页中下载文件后，通过“添加作业文件”导入。')
  if (!(await blackboardStatus()).connected) throw new Error('请先完成 Blackboard 登录，再读取作业说明')
  if (!isTrustedBlackboardUrl(url)) throw new Error('只允许读取 Blackboard 官方作业页面')
  const html = await fetchBlackboardHtml(url)
  return { text: extractAssignmentText(html), fetchedAt: new Date().toISOString() }
}

async function importAssignmentFiles(payload) {
  const courseName = typeof payload?.courseName === 'string' && payload.courseName.trim() ? payload.courseName.trim().slice(0, 160) : '未分类课程'
  const assignmentId = typeof payload?.assignmentId === 'string' ? payload.assignmentId.trim().slice(0, 180) : ''
  const assignmentTitle = typeof payload?.assignmentTitle === 'string' && payload.assignmentTitle.trim() ? payload.assignmentTitle.trim().slice(0, 120) : '未命名作业'
  if (!assignmentId) throw new Error('缺少作业标识')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `添加作业文件 · ${assignmentTitle}`,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '作业与学习资料', extensions: ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'tex', 'txt', 'zip', 'rar', '7z', 'png', 'jpg', 'jpeg'] }, { name: '所有文件', extensions: ['*'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return { cancelled: true, items: [] }
  const settings = await vaultSettings()
  const items = await importAssignmentFilesToVault({ root: settings.vaultRoot, courseName, assignmentId, assignmentTitle, filePaths: result.filePaths })
  return { cancelled: false, items, vaultRoot: settings.vaultRoot }
}

function assignmentFilesInsideVault(root, values) {
  return (Array.isArray(values) ? values : []).filter((value) => {
    if (!value || typeof value.localPath !== 'string' || !path.isAbsolute(value.localPath)) return false
    const relative = path.relative(root, value.localPath)
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
  }).slice(0, 24)
}

async function readAssignmentFileContents(payload) {
  const settings = await vaultSettings()
  const files = assignmentFilesInsideVault(settings.vaultRoot, payload?.files)
  const contents = []
  for (const file of files) {
    try {
      const result = await extractLocalDocumentText({ materialId: `assignment-file-${path.basename(file.localPath)}`, courseId: '', courseName: '', title: typeof file.title === 'string' ? file.title : path.basename(file.localPath), localPath: file.localPath })
      contents.push({ localPath: file.localPath, title: file.title, text: result.text, format: result.format })
    } catch (error) {
      contents.push({ localPath: file.localPath, title: file.title, text: '', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { contents }
}

async function removeAssignmentFiles(payload) {
  const assignmentId = typeof payload?.assignmentId === 'string' ? payload.assignmentId.trim() : ''
  const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
  const settings = await vaultSettings()
  return removeAssignmentFilesFromVault({ root: settings.vaultRoot, assignmentId, filePaths })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1080, minHeight: 720, backgroundColor: '#f6f7f3', autoHideMenuBar: true, icon: trayIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  mainWindow.on('close', (event) => {
    if (!isQuitting && appBehavior.keepRunningInTray) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = undefined })
  if (isDev) mainWindow.loadURL('http://localhost:5173')
  else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
}

async function cacheBlackboardFile(payload) {
  if (!(await blackboardStatus()).connected) throw new Error('请先完成 Blackboard 登录')
  const url = typeof payload?.url === 'string' ? payload.url : ''
  if (!isTrustedBlackboardResourceUrl(url)) throw new Error('只允许缓存 Blackboard 课程中的文件')
  const response = await getBlackboardSession().fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`文件下载失败（HTTP ${response.status}）`)
  if (Number(response.headers.get('content-length')) > MAX_CACHE_BYTES) throw new Error('文件超过 512 MB，请在 Blackboard 中手动下载')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_CACHE_BYTES) throw new Error('文件超过 512 MB，请在 Blackboard 中手动下载')
  const headerFilename = filenameFromDisposition(response.headers.get('content-disposition') ?? '')
  const title = headerFilename || (typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Blackboard 文件')
  const courseName = typeof payload?.courseName === 'string' && payload.courseName.trim() ? payload.courseName.trim() : '未分类课程'
  const folderPath = Array.isArray(payload?.folderPath) ? payload.folderPath.filter((item) => typeof item === 'string').slice(0, 12) : []
  const settings = await vaultSettings()
  const item = await importBufferToVault({
    root: settings.vaultRoot, courseName, folderPath, filename: title, buffer, sourceUrl: url,
    contentType: response.headers.get('content-type') ?? '',
  })
  return { vaultRoot: settings.vaultRoot, item }
}

ipcMain.handle('blackboard:connect', async () => { openBlackboardLogin(); return { started: true, portal: BLACKBOARD_ORIGIN } })
ipcMain.handle('blackboard:status', async () => blackboardStatus())
ipcMain.handle('gradescope:connect', async () => { openGradescopeLogin(); return { started: true, portal: GRADESCOPE_ORIGIN } })
ipcMain.handle('gradescope:status', async () => gradescopeStatus())
ipcMain.handle('gradescope:sync', async () => syncGradescope())
ipcMain.handle('assignment:details', async (_event, payload) => readAssignmentDetails(payload))
ipcMain.handle('assignment:import-files', async (_event, payload) => importAssignmentFiles(payload))
ipcMain.handle('assignment:file-contents', async (_event, payload) => readAssignmentFileContents(payload))
ipcMain.handle('assignment:remove-files', async (_event, payload) => removeAssignmentFiles(payload))
ipcMain.handle('vault:settings', async () => vaultSettings())

ipcMain.handle('vault:choose-root', async () => {
  const settings = await vaultSettings()
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择学径知识库位置', defaultPath: settings.vaultRoot, properties: ['openDirectory', 'createDirectory'] })
  return result.canceled || !result.filePaths[0]
    ? { cancelled: true, currentRoot: settings.vaultRoot }
    : { cancelled: false, currentRoot: settings.vaultRoot, vaultRoot: result.filePaths[0] }
})

ipcMain.handle('vault:migrate', async (_event, payload) => {
  const settings = await vaultSettings()
  const targetRoot = typeof payload?.targetRoot === 'string' ? payload.targetRoot : ''
  const mode = ['copy', 'move', 'switch'].includes(payload?.mode) ? payload.mode : 'copy'
  if (!targetRoot || !path.isAbsolute(targetRoot)) throw new Error('请选择有效的新资料库位置')
  if (path.resolve(targetRoot) === path.resolve(settings.vaultRoot)) return { vaultRoot: settings.vaultRoot, copied: 0, deduplicated: 0, moved: 0, missing: 0, relocated: [], failed: [] }
  if (mode === 'switch') {
    await saveVaultRoot(targetRoot)
    return { vaultRoot: targetRoot, copied: 0, deduplicated: 0, moved: 0, missing: 0, relocated: [], failed: [] }
  }
  const summary = await migrateVault({
    sourceRoot: settings.vaultRoot,
    targetRoot,
    mode,
    onProgress: (progress) => sendToRenderer(mainWindow, 'vault:migration-progress', progress),
  })
  await saveVaultRoot(targetRoot)
  return { vaultRoot: targetRoot, ...summary }
})

ipcMain.handle('vault:verify-files', async (_event, payload) => {
  const paths = Array.isArray(payload?.paths) ? payload.paths.filter((item) => typeof item === 'string').slice(0, 2000) : []
  return verifyVaultFiles(paths)
})

ipcMain.handle('vault:match-blackboard-files', async (_event, payload) => {
  const settings = await vaultSettings()
  const urls = Array.isArray(payload?.urls) ? payload.urls.filter((item) => typeof item === 'string').slice(0, 3000) : []
  return findBlackboardCachedFiles(settings.vaultRoot, urls)
})

function knowledgeDocuments(payload) {
  return (Array.isArray(payload?.documents) ? payload.documents : []).filter((document) => document
    && typeof document.materialId === 'string'
    && typeof document.localPath === 'string'
    && path.isAbsolute(document.localPath)
    && typeof document.title === 'string').slice(0, 2000)
}

ipcMain.handle('knowledge:status', async (_event, payload) => {
  const settings = await vaultSettings()
  return knowledgeStatus(settings.vaultRoot, knowledgeDocuments(payload))
})

ipcMain.handle('knowledge:document-content', async (_event, payload) => {
  const settings = await vaultSettings()
  return readKnowledgeDocumentContent({ root: settings.vaultRoot, documents: knowledgeDocuments(payload), materialId: typeof payload?.materialId === 'string' ? payload.materialId : '' })
})

ipcMain.handle('knowledge:search', async (_event, payload) => {
  const settings = await vaultSettings()
  return searchKnowledgeDocuments({ root: settings.vaultRoot, documents: knowledgeDocuments(payload), query: typeof payload?.query === 'string' ? payload.query : '', limit: payload?.limit })
})

ipcMain.handle('knowledge:document-file', async (_event, payload) => {
  const document = findPreviewDocument(knowledgeDocuments(payload), typeof payload?.materialId === 'string' ? payload.materialId : '')
  if (!document) throw new Error('找不到需要预览的资料')
  return readPreviewFile(document)
})

ipcMain.handle('knowledge:build', async (_event, payload) => {
  const settings = await vaultSettings()
  return buildKnowledgeIndex({
    root: settings.vaultRoot,
    documents: knowledgeDocuments(payload),
    onProgress: (progress) => sendToRenderer(mainWindow, 'knowledge:progress', progress),
  })
})

ipcMain.handle('knowledge:ocr', async (_event, payload) => {
  const settings = await vaultSettings()
  return ocrKnowledgeDocument({
    root: settings.vaultRoot,
    documents: knowledgeDocuments(payload),
    materialId: typeof payload?.materialId === 'string' ? payload.materialId : '',
    cachePath: path.join(app.getPath('userData'), 'ocr-language-cache'),
    onProgress: (progress) => sendToRenderer(mainWindow, 'knowledge:progress', progress),
  })
})

ipcMain.handle('knowledge:ocr-batch', async (_event, payload) => {
  const settings = await vaultSettings()
  return ocrKnowledgeDocuments({
    root: settings.vaultRoot,
    documents: knowledgeDocuments(payload),
    materialIds: Array.isArray(payload?.materialIds) ? payload.materialIds : [],
    cachePath: path.join(app.getPath('userData'), 'ocr-language-cache'),
    onProgress: (progress) => sendToRenderer(mainWindow, 'knowledge:progress', progress),
  })
})

ipcMain.handle('knowledge:refine', async (_event, payload) => {
  const settings = await vaultSettings()
  sendToRenderer(mainWindow, 'knowledge:progress', { completed: 0, total: 1, title: '正在读取加密保存的 AI 配置…' })
  const ai = await privateAiSettings()
  return refineKnowledgeDocument({
    root: settings.vaultRoot,
    documents: knowledgeDocuments(payload),
    materialId: typeof payload?.materialId === 'string' ? payload.materialId : '',
    force: payload?.force === true,
    refine: (document) => refineKnowledgeWithCloud({ config: ai, document }),
    onProgress: (progress) => sendToRenderer(mainWindow, 'knowledge:progress', progress),
  })
})

ipcMain.handle('knowledge:refine-batch', async (_event, payload) => {
  const settings = await vaultSettings()
  sendToRenderer(mainWindow, 'knowledge:progress', { completed: 0, total: 1, title: '正在读取加密保存的 AI 配置…' })
  const ai = await privateAiSettings()
  return refineKnowledgeDocuments({
    root: settings.vaultRoot,
    documents: knowledgeDocuments(payload),
    materialIds: Array.isArray(payload?.materialIds) ? payload.materialIds : [],
    refine: (document) => refineKnowledgeWithCloud({ config: ai, document }),
    onProgress: (progress) => sendToRenderer(mainWindow, 'knowledge:progress', progress),
  })
})

ipcMain.handle('ai:settings', async () => aiSettings())
ipcMain.handle('ai:save-settings', async (_event, payload) => saveAiSettings(payload))
ipcMain.handle('ai:test-connection', async (_event, payload) => testCloudConnection({ config: await aiSettingsForTest(payload) }))
ipcMain.handle('ai:chat', async (_event, payload) => chatWithCloud({
  config: await privateAiSettings(),
  context: typeof payload?.context === 'string' ? payload.context : '',
  messages: Array.isArray(payload?.messages) ? payload.messages : [],
}))
ipcMain.handle('email:settings', async () => emailSettings())
ipcMain.handle('email:save-settings', async (_event, payload) => saveEmailSettings(payload))
ipcMain.handle('email:test', async (_event, payload) => testEmailConnection(await privateEmailSettings(payload)))
ipcMain.handle('email:send-sync-update', async (_event, payload) => sendSyncUpdateEmail(payload))
ipcMain.handle('email:send-deadline', async (_event, payload) => sendDeadlineEmail(payload))
ipcMain.handle('email:send-deadline-digest', async (_event, payload) => sendDeadlineDigestEmail(payload))
ipcMain.handle('credentials:blackboard', async () => blackboardCredentials())
ipcMain.handle('credentials:save-blackboard', async (_event, payload) => saveBlackboardCredentials(payload))
ipcMain.handle('credentials:clear-blackboard', async () => clearBlackboardCredentials())

ipcMain.handle('vault:import-files', async (_event, payload) => {
  const courseName = typeof payload?.courseName === 'string' ? payload.courseName : '未分类课程'
  const folderPath = Array.isArray(payload?.folderPath) ? payload.folderPath.filter((item) => typeof item === 'string').slice(0, 12) : ['手动导入']
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要导入的课程资料', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '学习资料', extensions: ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip', 'mp4', 'mov', 'mkv'] }, { name: '所有文件', extensions: ['*'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return { cancelled: true, items: [] }
  const settings = await vaultSettings()
  const items = await importFilesToVault({ root: settings.vaultRoot, courseName, folderPath, filePaths: result.filePaths })
  return { cancelled: false, items, vaultRoot: settings.vaultRoot }
})

ipcMain.handle('blackboard:cache-file', async (_event, payload) => cacheBlackboardFile(payload))

ipcMain.handle('blackboard:cache-files', async (_event, payload) => {
  const files = Array.isArray(payload?.files) ? payload.files.slice(0, 1000) : []
  const completed = []
  const failed = []
  for (const file of files) {
    try {
      const result = await cacheBlackboardFile(file)
      completed.push({ clientId: file?.clientId, url: file?.url, item: result.item, vaultRoot: result.vaultRoot })
    } catch (error) {
      failed.push({ url: file?.url, title: file?.title, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { completed, failed }
})

ipcMain.handle('vault:repair-extensions', async () => {
  const settings = await vaultSettings()
  const result = await repairVaultExtensions(settings.vaultRoot)
  return { ...result, vaultRoot: settings.vaultRoot }
})

ipcMain.handle('blackboard:open-submission', async (_event, url) => {
  if (!isTrustedBlackboardUrl(url)) throw new Error('只允许打开 Blackboard 官方页面')
  await shell.openExternal(url)
  return { opened: true }
})

ipcMain.handle('gradescope:open-submission', async (_event, url) => {
  if (!isTrustedGradescopeUrl(url) || !/^\/courses\/\d+\/assignments\/\d+/.test(new URL(url).pathname)) throw new Error('只允许打开 Gradescope 官方作业页面')
  await shell.openExternal(url)
  return { opened: true }
})

ipcMain.handle('external:open-url', async (_event, url) => {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol')
    await shell.openExternal(parsed.toString())
    return { opened: true }
  } catch {
    throw new Error('无法打开此链接')
  }
})

ipcMain.handle('document:open-local', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('无效的本地资料路径')
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error('not a file')
  } catch {
    throw new Error('本地资料不存在或无法打开')
  }
  const error = await shell.openPath(filePath)
  if (error) throw new Error(error)
  return { opened: true }
})

ipcMain.handle('deadlines:notify', async (_event, payload) => {
  const title = typeof payload?.title === 'string' ? payload.title.slice(0, 120) : ''
  const body = typeof payload?.body === 'string' ? payload.body.slice(0, 300) : ''
  if (!title || !Notification.isSupported()) return { shown: false }
  new Notification({ title, body }).show()
  return { shown: true }
})

ipcMain.handle('app:settings', async () => appBehaviorSettings())
ipcMain.handle('app:save-settings', async (_event, payload) => saveAppBehavior(payload))

ipcMain.handle('blackboard:sync', async () => {
  const status = await blackboardStatus()
  if (!status.connected) return { connected: false, courses: [], message: '请先完成 Blackboard 登录', diagnostics: { stage: '未登录' } }
  try {
    const response = await getBlackboardSession().fetch(BLACKBOARD_PORTAL_URL, { redirect: 'follow' })
    const html = await response.text()
    const pageType = classifyBlackboardPage(html)
    if (pageType === 'authentication') {
      blackboardConnected = false
      broadcastBlackboardStatus()
      return { connected: false, courses: [], message: '登录会话已过期，请重新连接 Blackboard', diagnostics: { stage: '登录会话验证失败', httpStatus: response.status } }
    }
    const courses = parseCourseLinks(html)
    return { connected: true, courses, message: courses.length ? `已从 Blackboard 门户读取 ${courses.length} 门课程入口` : '已读取 Blackboard 页面，但未识别到课程链接', diagnostics: { stage: `页面读取完成（${pageType}）`, courseLinkCount: courses.length } }
  } catch (error) {
    return { connected: status.connected, courses: [], message: '同步请求未完成', diagnostics: { stage: '请求异常', error: error instanceof Error ? error.message : String(error) } }
  }
})

ipcMain.handle('blackboard:sync-materials', async (_event, requestedCourses) => {
  const status = await blackboardStatus()
  if (!status.connected) return { connected: false, materials: [], message: '请先完成 Blackboard 登录', diagnostics: { stage: '未登录' } }
  const courses = (Array.isArray(requestedCourses) ? requestedCourses : [])
    .filter((course) => course && typeof course.name === 'string' && typeof course.url === 'string' && isTrustedBlackboardUrl(course.url))
    .slice(0, MAX_COURSES_PER_SYNC)
  if (!courses.length) return { connected: true, materials: [], message: '没有可扫描的 Blackboard 课程入口', diagnostics: { stage: '课程入口为空' } }
  const materials = []
  let folders = 0
  let failures = 0
  for (const course of courses) {
    try {
      const result = await scanCourseMaterials(course)
      materials.push(...result.materials)
      folders += result.folders
    } catch {
      failures += 1
    }
  }
  return { connected: true, materials, message: `已扫描 ${courses.length} 门课程、${folders} 个内容页，发现 ${materials.length} 个资料或链接`, diagnostics: { stage: '课程内容扫描完成', scannedCourses: courses.length, scannedFolders: folders, materialCount: materials.length, failedCourses: failures } }
})

ipcMain.handle('blackboard:disconnect', async () => {
  await getBlackboardSession().clearStorageData({ storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb'] })
  blackboardConnected = false
  broadcastBlackboardStatus()
  return { connected: false }
})

ipcMain.handle('gradescope:disconnect', async () => {
  await getGradescopeSession().clearStorageData({ storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb'] })
  await clearPersistedGradescopeSession()
  gradescopeConnected = false
  gradescopeSessionKnownInvalid = true
  broadcastGradescopeStatus()
  return { connected: false }
})

app.whenReady().then(async () => {
  appBehavior = await appBehaviorSettings()
  await restoreGradescopeSession()
  syncTray()
  createWindow()
  app.on('activate', showMainWindow)
})

app.on('before-quit', () => { isQuitting = true })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !appBehavior.keepRunningInTray) app.quit()
})
