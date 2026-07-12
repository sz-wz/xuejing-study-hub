export type AssignmentAiMatch = { conceptIds: string[]; explanation: string }

export function assignmentAiSourceKey(title: string, detailsText: string, candidateValues: string[] = []) {
  const candidates = [...new Set(candidateValues.map((value) => value.trim()).filter(Boolean))].sort().join('\n')
  const value = `${title}\n${detailsText}\n${candidates}`.trim()
  let hash = 5381
  for (const character of value) hash = (hash * 33) ^ character.codePointAt(0)!
  return `assignment-ai-${(hash >>> 0).toString(36)}`
}

export function parseAssignmentAiMatch(value: string, candidateIds: string[], limit = 8): AssignmentAiMatch | null {
  const raw = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').match(/\{[\s\S]*\}/)?.[0]
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.conceptIds)) return null
    const candidates = new Set(candidateIds)
    const conceptIds: string[] = []
    for (const rawId of parsed.conceptIds) {
      if (typeof rawId !== 'string') continue
      const id = rawId.trim().replace(/^C:/i, '')
      if (!candidates.has(id) || conceptIds.includes(id)) continue
      conceptIds.push(id)
      if (conceptIds.length >= limit) break
    }
    if (!conceptIds.length) return null
    return { conceptIds, explanation: typeof parsed.explanation === 'string' ? parsed.explanation.trim().slice(0, 360) : '' }
  } catch {
    return null
  }
}
