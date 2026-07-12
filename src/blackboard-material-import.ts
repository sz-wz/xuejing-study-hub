import type { Course, Material } from './types'

export type BlackboardMaterial = {
  title: string
  type: 'PPT' | 'PDF' | '视频' | '文件' | '网页' | '作业'
  kind: 'folder' | 'file' | 'link' | 'assignment'
  url?: string
  meta: string
  courseName: string
  path: string[]
}

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function stableId(url: string) {
  let hash = 5381
  for (const character of url) hash = (hash * 33) ^ character.codePointAt(0)!
  return `bb-material-${(hash >>> 0).toString(36)}`
}

export function mergeBlackboardMaterials(existing: Material[], courses: Course[], remote: BlackboardMaterial[]) {
  const courseIds = new Map(courses.map((course) => [normalized(course.name), course.id]))
  const incoming: Material[] = []
  for (const item of remote) {
    const courseId = courseIds.get(normalized(item.courseName))
    if (!courseId) continue
    const identity = item.url ?? `${item.courseName}:${item.kind}:${item.path.join('/')}:${item.title}`
    incoming.push({
      id: stableId(identity),
      courseId,
      title: item.title,
      type: item.type,
      source: 'Blackboard',
      meta: item.meta || 'Blackboard 内容',
      concepts: [],
      url: item.url,
      folder: item.path.at(-1),
      path: item.path,
      kind: item.kind,
    })
  }
  const remoteIds = new Set(incoming.map((item) => item.id))
  const existingById = new Map(existing.map((item) => [item.id, item]))
  const refreshed = incoming.map((item) => {
    const previous = existingById.get(item.id)
    return previous?.localPath ? { ...item, localPath: previous.localPath, meta: previous.meta } : item
  })
  const refreshedCourseIds = new Set(refreshed.map((item) => item.courseId))
  const retained = existing.filter((item) => {
    if (remoteIds.has(item.id)) return false
    return item.source !== 'Blackboard' || !refreshedCourseIds.has(item.courseId)
  })
  return { materials: [...refreshed, ...retained], added: incoming.length }
}
