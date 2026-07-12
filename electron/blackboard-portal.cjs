const BLACKBOARD_ORIGIN = 'https://elearning.shanghaitech.edu.cn:8443'

function isBlackboardAuthenticatedPage(url) {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== BLACKBOARD_ORIGIN) return false
    return parsed.pathname.startsWith('/webapps/portal/') || parsed.pathname === '/webapps/bb-BB-BBLEARN/index.jsp'
  } catch {
    return false
  }
}

function classifyBlackboardPage(html) {
  const plainText = decodeHtml(html)
  if (/统一身份认证|账号登录|authserver\/login|请输入学号/i.test(plainText)) return 'authentication'
  if (/总课程列表|All\s*Course\s*List|Blackboard\s+Learn/i.test(plainText)) return 'blackboard-home'
  if (/\/webapps\/blackboard\/execute\/launcher|course_id=/i.test(html)) return 'blackboard-course'
  return 'unknown'
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function parseCourseLinks(html) {
  const found = new Map()
  const anchorPattern = /<a\b[^>]*href=(['"])([^'"]*\/webapps\/blackboard\/execute\/launcher[^'"]*)\1[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorPattern.exec(html))) {
    const name = decodeHtml(match[3])
    if (name.length > 1 && name.length < 160) {
      found.set(name, new URL(match[2], BLACKBOARD_ORIGIN).toString())
    }
  }
  return [...found].slice(0, 40).map(([name, url]) => ({ name, url }))
}

module.exports = { classifyBlackboardPage, isBlackboardAuthenticatedPage, parseCourseLinks }
