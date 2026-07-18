const PAGE_INDEX_VERSION = 1

function clean(value) {
  return String(value ?? '').normalize('NFKC').replace(/[−–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
}

function normalizedText(value) {
  return clean(value).toLocaleLowerCase().replace(/\s+/g, '')
}

function normalizedFormula(value) {
  return clean(value).toLocaleLowerCase()
    .replace(/[𝜔ω]/g, 'ω')
    .replace(/[𝜏τ]/g, 'τ')
    .replace(/[()[\]{}\s,，。；;:：]/g, '')
    .replace(/[·⋅×]/g, '*')
    .replace(/÷/g, '/')
}

function textTokens(value) {
  const source = clean(value).toLocaleLowerCase()
    .replace(/properties\b/g, 'property')
    .replace(/systems\b/g, 'system')
    .replace(/signals\b/g, 'signal')
    .replace(/responses\b/g, 'response')
    .replace(/filters\b/g, 'filter')
  const tokens = new Set(source.match(/[a-z][a-z0-9-]{2,}/g) ?? [])
  for (const sequence of source.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    if (sequence.length <= 5) tokens.add(sequence)
    for (let index = 0; index < sequence.length - 1; index += 1) tokens.add(sequence.slice(index, index + 2))
  }
  return tokens
}

function ngramOverlap(query, source, size = 4) {
  if (query.length < size || source.length < size) return source.includes(query) ? 1 : 0
  const grams = new Set()
  for (let index = 0; index <= query.length - size; index += 1) grams.add(query.slice(index, index + size))
  let matched = 0
  for (const gram of grams) if (source.includes(gram)) matched += 1
  return grams.size ? matched / grams.size : 0
}

function pageHeading(text, pageNumber) {
  const lines = String(text ?? '').split(/\r?\n/).map(clean).filter(Boolean)
  for (const raw of lines.slice(0, 8)) {
    const line = raw.replace(new RegExp(`^${pageNumber}\\s+`), '').trim()
    const letters = (line.match(/[\p{L}\p{N}]/gu) ?? []).length
    if (line.length < 3 || line.length > 120 || letters < 3 || letters / line.length < 0.45) continue
    if (/^(?:outline|contents?|page|slide)\b/i.test(line)) continue
    return line
  }
  return ''
}

function buildPageCards(segments) {
  return (Array.isArray(segments) ? segments : []).filter((segment) => segment && typeof segment.text === 'string' && segment.text.trim()).map((segment) => {
    const text = String(segment.text)
    return {
      kind: segment.kind,
      start: Number(segment.start),
      end: Number(segment.end ?? segment.start),
      heading: pageHeading(text, Number(segment.start)),
      snippet: clean(text).slice(0, 900),
      text,
      normalized: normalizedText(text),
      formula: normalizedFormula(text),
      tokens: textTokens(text),
    }
  }).filter((card) => Number.isInteger(card.start) && card.start >= 1)
}

function pageCardForCloud(card) {
  return { kind: card.kind, start: card.start, end: card.end, heading: card.heading, snippet: card.snippet.slice(0, 620) }
}

function scorePageCard(concept, card) {
  const evidence = normalizedText(concept.evidence)
  const title = normalizedText(concept.title)
  if (evidence.length >= 5 && card.normalized.includes(evidence)) return { score: 0.99, method: 'exact-evidence' }
  if (title.length >= 3 && card.normalized.includes(title)) return { score: 0.94, method: 'exact-title' }

  const formulaSource = String(concept.evidence ?? '')
  if (/[=∠∑∫ττω𝜔^_+\-*/]/u.test(formulaSource)) {
    const formula = normalizedFormula(formulaSource)
    const overlap = ngramOverlap(formula, card.formula)
    if (formula.length >= 6 && overlap >= 0.46) return { score: Math.min(0.93, 0.7 + overlap * 0.25), method: 'formula' }
  }

  const queryTokens = textTokens(`${concept.title ?? ''} ${concept.evidence ?? ''}`)
  if (!queryTokens.size) return { score: 0, method: 'none' }
  const overlap = [...queryTokens].filter((token) => card.tokens.has(token)).length / queryTokens.size
  const headingTokens = textTokens(card.heading)
  const headingOverlap = [...queryTokens].filter((token) => headingTokens.has(token)).length / queryTokens.size
  const score = Math.min(0.78, overlap * 0.68 + headingOverlap * 0.28)
  return { score, method: headingOverlap > overlap * 0.5 ? 'heading-tokens' : 'tokens' }
}

function clusterHits(hits, materialId, evidence, threshold, candidate = false) {
  if (!hits.length) return []
  const best = Math.max(...hits.map((hit) => hit.score))
  const selected = hits.filter((hit) => hit.score >= Math.max(threshold, best * 0.68)).sort((left, right) => left.card.start - right.card.start)
  const clusters = []
  for (const hit of selected) {
    const current = clusters.at(-1)
    if (current && current.kind === hit.card.kind && hit.card.start <= current.end + 1) {
      current.end = Math.max(current.end, hit.card.end)
      current.confidence = Math.max(current.confidence, hit.score)
      current.methods.add(hit.method)
    } else {
      clusters.push({ kind: hit.card.kind, start: hit.card.start, end: hit.card.end, confidence: hit.score, methods: new Set([hit.method]) })
    }
  }
  return clusters.sort((left, right) => right.confidence - left.confidence || left.start - right.start).slice(0, 4).sort((left, right) => left.start - right.start).map((cluster) => ({
    materialId,
    kind: cluster.kind,
    start: cluster.start,
    end: cluster.end,
    confidence: Number(cluster.confidence.toFixed(2)),
    evidence: String(evidence ?? '').slice(0, 240),
    method: [...cluster.methods].sort().join('+'),
    ...(candidate ? { candidate: true } : {}),
  }))
}

function localPageMapping(concept, cards, materialId) {
  const hits = cards.map((card) => ({ card, ...scorePageCard(concept, card) })).filter((hit) => hit.score >= 0.28)
  const confirmedHits = hits.filter((hit) => hit.score >= 0.78)
  const confirmed = clusterHits(confirmedHits, materialId, concept.evidence, 0.78)
  const confirmedPages = new Set(confirmed.flatMap((location) => Array.from({ length: location.end - location.start + 1 }, (_, index) => `${location.kind}:${location.start + index}`)))
  const candidateHits = hits.filter((hit) => hit.score < 0.78 && !confirmedPages.has(`${hit.card.kind}:${hit.card.start}`))
  return { locations: confirmed, candidates: clusterHits(candidateHits, materialId, concept.evidence, 0.28, true) }
}

function locationSignature(location) {
  return `${location.kind}:${Number(location.start)}:${Number(location.end ?? location.start)}`
}

function mergeLocations(locations, limit = 6) {
  const unique = []
  for (const location of Array.isArray(locations) ? locations : []) {
    if (!location || !Number.isInteger(Number(location.start)) || Number(location.start) < 1) continue
    const stored = { ...location, start: Number(location.start), end: Number(location.end ?? location.start), confidence: Number(location.confidence ?? 0.5) }
    const existing = unique.find((item) => locationSignature(item) === locationSignature(stored))
    if (!existing) unique.push(stored)
    else if (stored.confidence > existing.confidence) Object.assign(existing, stored)
  }
  const merged = []
  for (const location of unique.sort((left, right) => left.start - right.start || left.end - right.end)) {
    const current = merged.at(-1)
    if (current && current.materialId === location.materialId && current.kind === location.kind && Boolean(current.candidate) === Boolean(location.candidate) && location.start <= current.end) {
      current.end = Math.max(current.end, location.end)
      current.confidence = Math.max(current.confidence, location.confidence)
      current.manual = Boolean(current.manual || location.manual)
      current.method = [...new Set([...(String(current.method ?? '').split('+').filter(Boolean)), ...(String(location.method ?? '').split('+').filter(Boolean))])].sort().join('+') || undefined
      if (!current.evidence && location.evidence) current.evidence = location.evidence
    } else merged.push({ ...location })
  }
  return merged.sort((left, right) => right.confidence - left.confidence || left.start - right.start).slice(0, limit).sort((left, right) => left.start - right.start)
}

function cloudRangesForConcept(mapping, cards, materialId) {
  const allowed = new Set(cards.map((card) => `${card.kind}:${card.start}`))
  const locations = []
  const candidates = []
  for (const range of Array.isArray(mapping?.ranges) ? mapping.ranges : []) {
    const start = Number(range.start)
    const end = Number(range.end ?? start)
    const confidence = Number(range.confidence)
    const kind = typeof range.kind === 'string' ? range.kind : cards[0]?.kind
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || !allowed.has(`${kind}:${start}`) || !allowed.has(`${kind}:${end}`)) continue
    const location = { materialId, kind, start, end, confidence: Number(Math.max(0, Math.min(1, confidence || 0.6)).toFixed(2)), evidence: String(range.reason ?? '').slice(0, 240), method: 'ai-page-map' }
    if (location.confidence >= 0.8) locations.push(location)
    else if (location.confidence >= 0.55) candidates.push({ ...location, candidate: true })
  }
  return { locations: mergeLocations(locations), candidates: mergeLocations(candidates) }
}

function applyLocationOverrides(concept, override, materialId) {
  const removed = new Set((Array.isArray(override?.removed) ? override.removed : []).map(locationSignature))
  const added = (Array.isArray(override?.added) ? override.added : []).map((location) => ({ ...location, materialId, confidence: 1, method: 'manual', manual: true }))
  const locations = mergeLocations([...(concept.locations ?? []).filter((location) => !removed.has(locationSignature(location))), ...added])
  const candidates = mergeLocations((concept.locationCandidates ?? []).filter((location) => !removed.has(locationSignature(location)) && !locations.some((confirmed) => locationSignature(confirmed) === locationSignature(location))))
  return { ...concept, locations, locationCandidates: candidates }
}

module.exports = {
  PAGE_INDEX_VERSION,
  applyLocationOverrides,
  buildPageCards,
  cloudRangesForConcept,
  localPageMapping,
  locationSignature,
  mergeLocations,
  normalizedFormula,
  normalizedText,
  pageCardForCloud,
  scorePageCard,
}
