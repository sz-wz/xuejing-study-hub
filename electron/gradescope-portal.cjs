const GRADESCOPE_ORIGIN = 'https://www.gradescope.com'

function hasGradescopeSessionCookie(cookies) {
  return (Array.isArray(cookies) ? cookies : []).some((cookie) => {
    const name = String(cookie?.name ?? '').toLowerCase()
    if (!name || /^(?:_ga|_gid|_hj|__cf|cf_|csrf)/.test(name)) return false
    return /(?:gradescope.*session|session|remember.*(?:user|me)|user.*(?:token|session)|signed[_-]?in|auth)/.test(name)
  })
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function isGradescopeAuthenticatedPage(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin === GRADESCOPE_ORIGIN && (parsed.pathname === '/account' || /^\/courses\/\d+/.test(parsed.pathname))
  } catch {
    return false
  }
}

function classifyGradescopePage(html) {
  const text = decodeHtml(html)
  if (/(?:log\s*in|sign\s*in|forgot\s+your\s+password|reset\s+password)/i.test(text) && !/(?:course\s+dashboard|your\s+courses|regrade\s+requests)/i.test(text)) return 'authentication'
  if (/(?:course\s+dashboard|your\s+courses|regrade\s+requests|course\s+id|\bassignments?\b)/i.test(text)) return 'authenticated'
  return 'unknown'
}

function isGradescopeAssignmentResponseAuthenticated(finalUrl, html) {
  return isGradescopeAuthenticatedPage(finalUrl) && classifyGradescopePage(html) !== 'authentication'
}

function parseGradescopeCourses(html) {
  const found = new Map()
  const value = String(html ?? '')
  const anchorPattern = /<a\b[^>]*href=(['"])([^'"]*\/courses\/\d+\/?[^'"]*)\1[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorPattern.exec(value))) {
    const name = decodeHtml(match[3])
    if (!name || name.length > 180 || /^add\s+a\s+course$/i.test(name)) continue
    const url = new URL(match[2], GRADESCOPE_ORIGIN).toString()
    const preceding = decodeHtml(value.slice(0, match.index))
    const terms = [...preceding.matchAll(/\b(?:spring|summer|fall|winter)\s+\d{4}\b/gi)]
    const term = terms.at(-1)?.[0]?.replace(/\s+/g, ' ').trim() || '未分期'
    found.set(url, { name, term })
  }
  return [...found].map(([url, course]) => ({ ...course, url })).slice(0, 60)
}

function assignmentMeta(html, anchorEnd) {
  const rowEnd = html.indexOf('</tr>', anchorEnd)
  const fragment = decodeHtml(html.slice(anchorEnd, rowEnd >= 0 ? rowEnd : anchorEnd + 400))
  const due = fragment.match(/(?:due|late due date)\s*:?[\s\S]{0,70}/i)?.[0]?.replace(/\s+/g, ' ').trim()
  return due || 'Gradescope 作业'
}

function dateFromGradescopeText(value, term) {
  const text = decodeHtml(value)
  const match = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i)
  if (!match) return {}
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
  const termYear = Number(String(term ?? '').match(/\b(20\d{2})\b/)?.[1])
  if (!termYear) return { dueLabel: `Due ${match[0]}` }
  const month = months[match[1].toLowerCase().slice(0, 3)]
  let year = termYear
  if (/fall/i.test(term) && month <= 6) year += 1
  if (/spring/i.test(term) && month >= 8) year -= 1
  let hour = Number(match[3]) % 12
  if (/pm/i.test(match[5])) hour += 12
  const dueAt = `${year}-${String(month).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${match[4]}:00+08:00`
  return { dueAt, dueLabel: `Due ${match[0]}` }
}

function assignmentDetails(html, anchorIndex, anchorEnd, term) {
  const rowStart = html.lastIndexOf('<tr', anchorIndex)
  const rowEnd = html.indexOf('</tr>', anchorEnd)
  const row = html.slice(rowStart >= 0 ? rowStart : anchorIndex, rowEnd >= 0 ? rowEnd + 5 : anchorEnd + 500)
  const text = decodeHtml(row)
  const scoreMatch = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/)
  const dueAtFromMarkup = row.match(/\bdatetime=(['"])([^'"]+)\1/i)?.[2]
    || text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:?\d{2}|Z)?\b/)?.[0]
  const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1])
  const visibleDue = dateFromGradescopeText(cells.at(-1) ?? text, term)
  let status = 'unknown'
  if (scoreMatch) status = 'graded'
  else if (/\b(?:submitted|submission\s+received|resubmitted)\b/i.test(text)) status = 'submitted'
  else if (/\b(?:not\s+submitted|no\s+submission|missing)\b/i.test(text)) status = 'not_submitted'
  return {
    dueAt: dueAtFromMarkup || visibleDue.dueAt,
    dueLabel: dueAtFromMarkup ? assignmentMeta(html, anchorEnd) : visibleDue.dueLabel,
    status,
    score: scoreMatch ? Number(scoreMatch[1]) : undefined,
    maxScore: scoreMatch ? Number(scoreMatch[2]) : undefined,
  }
}

function parseGradescopeAssignments(html, term = '') {
  const value = String(html ?? '')
  const found = new Map()
  const anchorPattern = /<a\b[^>]*href=(['"])([^'"]*\/courses\/\d+\/assignments\/\d+(?:\/submissions\/new)?[^'"]*)\1[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorPattern.exec(value))) {
    const title = decodeHtml(match[3])
    if (!title || title.length > 180) continue
    const url = new URL(match[2], GRADESCOPE_ORIGIN).toString()
    if (!found.has(url)) {
      const details = assignmentDetails(value, match.index, match.index + match[0].length, term)
      const { dueLabel, ...rest } = details
      found.set(url, { title, url, meta: dueLabel || assignmentMeta(value, match.index + match[0].length), ...rest })
    }
  }
  return [...found.values()].slice(0, 200)
}

module.exports = { GRADESCOPE_ORIGIN, hasGradescopeSessionCookie, isGradescopeAuthenticatedPage, isGradescopeAssignmentResponseAuthenticated, classifyGradescopePage, parseGradescopeCourses, parseGradescopeAssignments }
