const nodemailer = require('nodemailer')

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function clean(value, max = 320) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function secret(value, max = 1024) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function normalizeEmailSettings(value) {
  const source = value && typeof value === 'object' ? value : {}
  const port = Number(source.port)
  return {
    enabled: source.enabled === true,
    host: clean(source.host, 255),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 465,
    secure: source.secure !== false,
    username: clean(source.username, 320),
    from: clean(source.from, 320),
    recipient: clean(source.recipient, 320),
    notifyCourseUpdates: source.notifyCourseUpdates !== false,
    notifyDeadlines: source.notifyDeadlines !== false,
    encryptedPassword: clean(source.encryptedPassword, 8192),
    password: secret(source.password),
  }
}

function publicEmailSettings(value) {
  const settings = normalizeEmailSettings(value)
  return {
    configured: Boolean(settings.host && settings.username && settings.encryptedPassword && settings.recipient),
    enabled: settings.enabled,
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    username: settings.username,
    from: settings.from,
    recipient: settings.recipient,
    notifyCourseUpdates: settings.notifyCourseUpdates,
    notifyDeadlines: settings.notifyDeadlines,
  }
}

function validateEmailSettings(settings, requirePassword = true) {
  const normalized = normalizeEmailSettings(settings)
  if (!normalized.host) throw new Error('请填写 SMTP 服务器地址')
  if (!EMAIL_PATTERN.test(normalized.username)) throw new Error('SMTP 登录账号需要是有效邮箱地址')
  if (!EMAIL_PATTERN.test(normalized.recipient)) throw new Error('请填写有效的收件邮箱地址')
  if (normalized.from && !EMAIL_PATTERN.test(normalized.from)) throw new Error('发件地址格式无效')
  if (requirePassword && !normalized.password && !normalized.encryptedPassword) throw new Error('请填写邮箱密码或应用专用密码')
  return normalized
}

function transportFor(settings) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.username, pass: settings.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 25_000,
  })
}

function smtpDeliveryAccepted(info, recipient) {
  const expected = clean(recipient).toLowerCase()
  const accepted = Array.isArray(info?.accepted) ? info.accepted.map((value) => clean(typeof value === 'string' ? value : value?.address).toLowerCase()) : []
  const rejected = Array.isArray(info?.rejected) ? info.rejected.map((value) => clean(typeof value === 'string' ? value : value?.address).toLowerCase()) : []
  return Boolean(expected && accepted.includes(expected) && !rejected.includes(expected))
}

function acceptedDeliveryResult(info, recipient) {
  if (!smtpDeliveryAccepted(info, recipient)) throw new Error('SMTP 服务器没有接受收件地址，请检查收件邮箱、垃圾邮件策略或服务器退信')
  return { sent: true, messageId: info.messageId || '', accepted: [...(info.accepted ?? [])].map(String), rejected: [...(info.rejected ?? [])].map(String), response: clean(info.response, 1000) }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function safeEvents(events) {
  if (!Array.isArray(events)) return []
  return events.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const title = clean(item.title, 160)
    const detail = clean(item.detail, 1000)
    if (!title || !detail) return []
    return [{ title, detail, source: clean(item.source, 32) }]
  })
}

function buildSyncUpdateMessage(events, generatedAt = new Date()) {
  const items = safeEvents(events)
  const date = generatedAt.toLocaleString('zh-CN', { hour12: false })
  return {
    subject: `学径：发现 ${items.length} 项学习信息变化`,
    text: [`学径同步摘要（${date}）`, '', ...items.flatMap((item, index) => [`${index + 1}. ${item.title}`, `   ${item.detail}`, `   来源：${item.source || '学习平台'}`, ''])].join('\n'),
    html: `<div style="font-family:Segoe UI,Microsoft YaHei,sans-serif;color:#263c31"><h2>学径同步摘要</h2><p>${escapeHtml(date)}，发现 ${items.length} 项变化。</p><ol>${items.map((item) => `<li style="margin-bottom:12px"><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.detail)}<br><small style="color:#738279">来源：${escapeHtml(item.source || '学习平台')}</small></li>`).join('')}</ol><p style="color:#738279;font-size:12px">此邮件由你本机上的学径应用发送。</p></div>`,
    count: items.length,
  }
}

function buildDeadlineMessage(payload) {
  const course = clean(payload?.course, 160)
  const title = clean(payload?.title, 240)
  const deadline = clean(payload?.deadline, 160)
  const label = clean(payload?.label, 160)
  if (!title || !deadline) throw new Error('DDL 邮件缺少作业标题或截止时间')
  return {
    subject: `学径 DDL 提醒：${title}`,
    text: [`课程：${course || '未分类课程'}`, `作业：${title}`, `截止时间：${deadline}`, label ? `提醒：${label}` : ''].filter(Boolean).join('\n'),
    html: `<div style="font-family:Segoe UI,Microsoft YaHei,sans-serif;color:#263c31"><h2>DDL 提醒</h2><p><strong>${escapeHtml(course || '未分类课程')}</strong></p><p>${escapeHtml(title)}</p><p>截止时间：<strong>${escapeHtml(deadline)}</strong></p>${label ? `<p>${escapeHtml(label)}</p>` : ''}<p style="color:#738279;font-size:12px">此邮件由你本机上的学径应用发送。</p></div>`,
  }
}

function buildDeadlineDigestMessage(items, generatedAt = new Date()) {
  const safe = Array.isArray(items) ? items.slice(0, 50).flatMap((item) => {
    const course = clean(item?.course, 160)
    const title = clean(item?.title, 240)
    const deadline = clean(item?.deadline, 160)
    const label = clean(item?.label, 160)
    if (!title || !deadline) return []
    return [{ course, title, deadline, label }]
  }) : []
  if (!safe.length) throw new Error('DDL 摘要没有可发送的作业')
  const date = generatedAt.toLocaleString('zh-CN', { hour12: false })
  return {
    subject: `学径 DDL 提醒：${safe.length} 项作业即将截止`,
    text: [`学径 DDL 提醒（${date}）`, '', ...safe.flatMap((item, index) => [`${index + 1}. ${item.course || '未分类课程'} · ${item.title}`, `   截止时间：${item.deadline}`, item.label ? `   ${item.label}` : '', ''].filter(Boolean))].join('\n'),
    html: `<div style="font-family:Segoe UI,Microsoft YaHei,sans-serif;color:#263c31"><h2>DDL 提醒</h2><p>${escapeHtml(date)}，共有 ${safe.length} 项作业达到提醒阈值。</p><ol>${safe.map((item) => `<li style="margin-bottom:12px"><strong>${escapeHtml(item.course || '未分类课程')} · ${escapeHtml(item.title)}</strong><br>截止时间：${escapeHtml(item.deadline)}${item.label ? `<br>${escapeHtml(item.label)}` : ''}</li>`).join('')}</ol><p style="color:#738279;font-size:12px">此邮件由你本机上的学径应用发送。</p></div>`,
    count: safe.length,
  }
}

async function sendMail(settings, message) {
  const validated = validateEmailSettings(settings)
  const transport = transportFor(validated)
  try {
    const info = await transport.sendMail({ from: validated.from || validated.username, to: validated.recipient, ...message })
    return acceptedDeliveryResult(info, validated.recipient)
  } finally {
    transport.close()
  }
}

async function testEmailConnection(settings) {
  const validated = validateEmailSettings(settings)
  const started = Date.now()
  const transport = transportFor(validated)
  try {
    await transport.verify()
    const info = await transport.sendMail({
      from: validated.from || validated.username,
      to: validated.recipient,
      subject: '学径邮箱连接测试',
      text: '如果你收到这封邮件，说明学径的 SMTP 邮箱配置可以正常发送通知。',
      html: '<div style="font-family:Segoe UI,Microsoft YaHei,sans-serif"><h2>学径邮箱连接成功</h2><p>SMTP 配置可以正常发送学习通知。</p></div>',
    })
    return { ...acceptedDeliveryResult(info, validated.recipient), latencyMs: Date.now() - started }
  } finally {
    transport.close()
  }
}

module.exports = { buildDeadlineDigestMessage, buildDeadlineMessage, buildSyncUpdateMessage, normalizeEmailSettings, publicEmailSettings, sendMail, smtpDeliveryAccepted, testEmailConnection, validateEmailSettings }
