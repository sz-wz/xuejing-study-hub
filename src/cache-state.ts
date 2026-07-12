import type { Material } from './types'

type CachedItem = Pick<Material, 'title' | 'type' | 'localPath' | 'meta'>
type CacheCompletion = { clientId?: string; url: string; item: CachedItem }

export function applyCachedItems(materials: Material[], completed: CacheCompletion[]) {
  const byId = new Map(completed.filter((entry) => entry.clientId).map((entry) => [entry.clientId!, entry.item]))
  const byUrl = new Map(completed.map((entry) => [entry.url, entry.item]))
  return materials.map((material) => {
    const item = byId.get(material.id) ?? (material.url ? byUrl.get(material.url) : undefined)
    return item ? { ...material, title: item.title, type: item.type, localPath: item.localPath, meta: item.meta } : material
  })
}
