export type RefinementCandidate = {
  materialId: string
  status: string
  hash?: string
  knowledgeRole?: 'courseware' | 'reference'
  ai?: { sourceHash?: string; mode?: 'quick' | 'deep' | 'original'; analysisMethod?: string }
  aiProfiles?: { quick?: { sourceHash?: string }; deep?: { sourceHash?: string }; original?: { sourceHash?: string } }
}

export type RefinementState = 'new' | 'stale' | 'current'

export function eligibleRefinementDocuments<T extends RefinementCandidate>(documents: T[]): T[] {
  return documents.filter((document) =>
    ['parsed', 'ocr'].includes(document.status) && document.knowledgeRole !== 'reference',
  )
}

export function refinementState(document: RefinementCandidate): RefinementState {
  const profile = document.aiProfiles?.original
    ?? (document.ai?.mode === 'original' || document.ai?.analysisMethod === 'original-file' ? document.ai : undefined)
  if (!profile) return 'new'
  return profile.sourceHash === document.hash ? 'current' : 'stale'
}

export function defaultRefinementSelection(documents: RefinementCandidate[]): string[] {
  return eligibleRefinementDocuments(documents)
    .filter((document) => refinementState(document) !== 'current')
    .map((document) => document.materialId)
}

export function toggleAllRefinementSelection(documents: RefinementCandidate[], selectedIds: string[]): string[] {
  const eligibleIds = eligibleRefinementDocuments(documents).map((document) => document.materialId)
  const selected = new Set(selectedIds)
  return eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id)) ? [] : eligibleIds
}
