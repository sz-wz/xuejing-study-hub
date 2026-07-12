function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<(?:script|style|noscript|svg)\b[\s\S]*?<\/(?:script|style|noscript|svg)>/gi, ' ')
    .replace(/<(?:nav|header|footer|aside)\b[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function extractAssignmentText(html, limit = 12_000) {
  const text = decodeHtml(html)
  if (!text) return ''
  const marker = text.search(/(?:assignment\s+(?:details|instructions?|description)|instructions?|description|题目说明|作业说明|作业要求|题目内容|提交说明)/i)
  const relevant = marker >= 0 ? text.slice(marker) : text
  return relevant.slice(0, Math.max(500, Math.min(Number(limit) || 12_000, 12_000))).trim()
}

module.exports = { extractAssignmentText }
