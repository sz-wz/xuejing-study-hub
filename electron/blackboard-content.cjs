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

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : ''
}

function anchors(html, baseUrl) {
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  const result = []
  let match
  while ((match = pattern.exec(html))) {
    const href = decodeHtml(attribute(match[1], 'href'))
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) continue
    try {
      const url = new URL(href, baseUrl)
      const title = decodeHtml(match[2]) || decodeHtml(attribute(match[1], 'title'))
      result.push({ title, url: url.toString() })
    } catch {
      // Blackboard 页面中偶尔会出现无效的展示链接，忽略即可。
    }
  }
  return result
}

function parseContentLinks(html, baseUrl) {
  const found = new Map()
  for (const item of anchors(html, baseUrl)) {
    const parsed = new URL(item.url)
    if (!parsed.pathname.endsWith('/webapps/blackboard/content/listContent.jsp') || !item.title) continue
    found.set(item.url, { title: item.title, url: item.url })
  }
  return [...found.values()]
}

function materialType(filename) {
  const extension = filename.toLowerCase().split('.').pop() ?? ''
  if (['ppt', 'pptx', 'pps', 'ppsx'].includes(extension)) return 'PPT'
  if (extension === 'pdf') return 'PDF'
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'].includes(extension)) return '视频'
  return '文件'
}

function titleWithoutSize(title) {
  return title.replace(/\s*\([^()]+?(?:KB|MB|GB)\)\s*$/i, '').trim()
}

function isGenericDownloadLabel(title) {
  return /^(?:click here|download|点击(?:此处)?|此处|下载(?:文件)?|file)$/i.test(title.trim())
}

function parseAttachments(html, baseUrl) {
  const found = new Map()
  const filenamePattern = /([^/\\\s]+\.(?:pptx?|ppsx?|pdf|docx?|xlsx?|csv|txt|zip|rar|7z|mp4|mov|avi|mkv|webm|wmv|mp3|wav))(?:\s|\(|$)/i
  for (const item of anchors(html, baseUrl)) {
    const parsed = new URL(item.url)
    const decodedPath = decodeURIComponent(parsed.pathname)
    const fileEndpoint = /\/bbcswebdav\/|\/download|\/attachment|\/files\//i.test(parsed.pathname)
    const queryFilename = parsed.searchParams.get('filename') ?? parsed.searchParams.get('fileName')
    const label = titleWithoutSize(item.title)
    const filename = item.title.match(filenamePattern)?.[1]
      ?? decodedPath.match(filenamePattern)?.[1]
      ?? queryFilename
      ?? (!isGenericDownloadLabel(label) ? label : '')
    if (!filename || !fileEndpoint) continue
    const size = item.title.match(/\(([^()]+?(?:KB|MB|GB))\)/i)?.[1] ?? ''
    found.set(item.url, { title: filename, type: materialType(filename), url: item.url, meta: size })
  }
  return [...found.values()]
}

function isNavigationExternalLink(item, parsed) {
  const host = parsed.hostname.toLowerCase()
  const title = item.title.trim().toLowerCase()
  const isRoot = parsed.pathname === '/' || parsed.pathname === ''
  const genericTitle = /^(?:主页|首页|blackboard learn|帮助|help|隐私|privacy|terms)$/i.test(title)
  return host.endsWith('blackboard.com') || (isRoot && genericTitle && host.endsWith('shanghaitech.edu.cn'))
}

function parseExternalLinks(html, baseUrl) {
  const found = new Map()
  const baseOrigin = new URL(baseUrl).origin
  for (const item of anchors(html, baseUrl)) {
    const parsed = new URL(item.url)
    if (!item.title || parsed.origin === baseOrigin || !['http:', 'https:'].includes(parsed.protocol)) continue
    if (isNavigationExternalLink(item, parsed)) continue
    found.set(item.url, { title: item.title, type: '网页', url: item.url, meta: parsed.hostname })
  }
  return [...found.values()]
}

module.exports = { parseAttachments, parseContentLinks, parseExternalLinks }
