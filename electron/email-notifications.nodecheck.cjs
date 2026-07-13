const test = require('node:test')
const assert = require('node:assert/strict')
const { buildDeadlineDigestMessage, buildDeadlineMessage, buildSyncUpdateMessage, normalizeEmailSettings, publicEmailSettings, smtpDeliveryAccepted, validateEmailSettings } = require('./email-notifications.cjs')

test('email settings are opt-in and expose no encrypted password', () => {
  const settings = normalizeEmailSettings({ host: 'smtp.example.com', port: 587, secure: false, username: 'student@example.com', recipient: 'notify@example.com', encryptedPassword: 'secret' })
  assert.equal(settings.enabled, false)
  assert.equal(settings.port, 587)
  assert.equal(publicEmailSettings(settings).configured, true)
  assert.equal(Object.hasOwn(publicEmailSettings(settings), 'encryptedPassword'), false)
})

test('invalid recipient and incomplete SMTP settings are rejected', () => {
  assert.throws(() => validateEmailSettings({ host: 'smtp.example.com', username: 'student@example.com', recipient: 'bad', password: 'x' }), /收件邮箱/)
})

test('sync and deadline emails escape external content', () => {
  const sync = buildSyncUpdateMessage([{ title: '<新作业>', detail: 'DDL & update', source: 'Blackboard' }], new Date('2026-07-13T00:00:00Z'))
  assert.equal(sync.count, 1)
  assert.match(sync.html, /&lt;新作业&gt;/)
  assert.doesNotMatch(sync.html, /<新作业>/)
  const deadline = buildDeadlineMessage({ course: 'CS101', title: 'Homework 1', deadline: '2026-07-20 20:00', label: '24 小时内截止' })
  assert.match(deadline.subject, /Homework 1/)
  const digest = buildDeadlineDigestMessage([{ course: 'CS101', title: 'HW1', deadline: '2026-07-20 20:00', label: '提前 3 天' }, { course: 'MATH', title: 'Quiz', deadline: '2026-07-21 10:00', label: '提前 5 天' }])
  assert.equal(digest.count, 2)
  assert.match(digest.subject, /2 项/)
})

test('SMTP completion only counts when the intended recipient was accepted', () => {
  assert.equal(smtpDeliveryAccepted({ accepted: ['notify@example.com'], rejected: [] }, 'notify@example.com'), true)
  assert.equal(smtpDeliveryAccepted({ accepted: [], rejected: ['notify@example.com'] }, 'notify@example.com'), false)
  assert.equal(smtpDeliveryAccepted({ accepted: ['other@example.com'], rejected: [] }, 'notify@example.com'), false)
})
