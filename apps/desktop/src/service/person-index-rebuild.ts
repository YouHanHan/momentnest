import { createHash } from 'node:crypto'
import { matchingPerson, representativeFaces } from './face-grouping.ts'
import type { GroupFace, PersonFaceGroup } from './face-grouping.ts'
import { planPersonMerges } from './person-grouping-plan.ts'

export interface RebuildFace extends GroupFace {
  x: number; y: number; width: number; height: number; score: number; personId?: string; reviewRequired?: boolean
}
export interface RebuildPerson {
  id: string; name: string; embedding: number[]; mergedIntoId?: string; mergeOrigin?: 'manual' | 'automatic'
}
export interface RebuildAsset { id: string; kind: 'photo' | 'video' }
export interface RebuildBabyReference { id: string; referenceFaces: { assetId: string; faceId: string }[] }
export interface PersonRebuildInput<F extends RebuildFace = RebuildFace> {
  faces: readonly F[]; people: readonly RebuildPerson[]; assets: readonly RebuildAsset[]
  babies?: readonly RebuildBabyReference[]; editableAssetIds?: readonly string[]
}
export interface PersonRebuildProgress {
  phase: 'initial' | 'revisit' | 'merge' | 'complete'; pass: number; processed: number; total: number
  groups: number; assignedFaces: number; ungroupedFaces: number
}
export interface PersonRebuildSummary {
  beforeGroups: number; afterGroups: number; protectedGroups: number; externalGroups: number
  assignedFaces: number; ungroupedFaces: number; invalidFaces: number; invalidVectors: number
  conflictedFaces: number; reviewRequiredFaces: number; lowScoreFaces: number; ambiguousFaces: number
  matchedFaces: number; newGroups: number; preservedFaces: number; manualFaces: number; referenceFaces: number
  removedAutomaticGroups: number; removedAutomaticAliases: number; revisitPasses: number; recoveredFaces: number
  automaticMergedGroups: number; mergeAmbiguousGroups: number; mergeConflicts: number
}

/** 建立严格的人物根索引，循环、悬空及矛盾的人工记录均停止维护。 */
function personRoots(people: readonly RebuildPerson[]) {
  const records = new Map<string, RebuildPerson>(), roots = new Map<string, string>()
  for (const person of people) {
    if (!person || typeof person.id !== 'string' || !person.id || records.has(person.id)) throw new Error('人物 ID 缺失或重复，重建已停止。')
    if (typeof person.name !== 'string') throw new Error('人物名称记录无效，重建已停止。')
    if (person.mergedIntoId !== undefined && (typeof person.mergedIntoId !== 'string' || !person.mergedIntoId)) throw new Error('人物合并目标无效，重建已停止。')
    if (person.mergeOrigin !== undefined && person.mergeOrigin !== 'manual' && person.mergeOrigin !== 'automatic') throw new Error('人物合并来源无效，重建已停止。')
    records.set(person.id, person)
  }
  for (const person of people) {
    if (roots.has(person.id)) continue
    const visited = new Set<string>(), path: string[] = []
    let current = person.id
    while (!roots.has(current)) {
      if (visited.has(current)) throw new Error('人物合并记录存在循环，重建已停止。')
      const record = records.get(current)
      if (!record) throw new Error('人物合并目标不存在，重建已停止。')
      visited.add(current); path.push(current)
      if (!record.mergedIntoId) break
      current = record.mergedIntoId
    }
    const rootId = roots.get(current) ?? current
    for (const id of path) roots.set(id, rootId)
  }
  const protectedIds = new Set<string>(), preservedIds = new Set<string>()
  for (const person of people) {
    if (person.mergedIntoId && person.mergeOrigin === 'automatic' && person.name.trim()) throw new Error('自动人物别名含有姓名，无法安全清理，重建已停止。')
    if (!person.name.trim() && !(person.mergedIntoId && person.mergeOrigin !== 'automatic')) continue
    const rootId = roots.get(person.id)!
    protectedIds.add(rootId); preservedIds.add(rootId)
    let current = person.id
    while (current !== rootId) {
      const record = records.get(current)!
      if (record.mergeOrigin === 'automatic') throw new Error('人工人物合并经过自动别名，无法安全清理，重建已停止。')
      preservedIds.add(current); current = record.mergedIntoId!
    }
  }
  return { records, roots, protectedIds, preservedIds }
}

/** 缓存向量范数，余弦值与正式实现保持一致；仅样本选择缓存成对结果。 */
function similarityCache() {
  const norms = new WeakMap<number[], number>(), sampleScores = new WeakMap<number[], WeakMap<number[], number>>()
  let incoming: number[] | undefined, incomingScores = new WeakMap<number[], number>()
  function norm(vector: number[]): number {
    if (!Array.isArray(vector)) return -1
    if (norms.has(vector)) return norms.get(vector)!
    let value = 0
    for (const item of vector) {
      if (typeof item !== 'number' || !Number.isFinite(item)) { value = -1; break }
      value += item ** 2
    }
    if (!vector.length || !Number.isFinite(value) || value <= 0) value = -1
    norms.set(vector, value)
    return value
  }
  function cosine(left: number[], right: number[]): number {
    const first = norm(left), second = norm(right)
    if (first < 0 || second < 0 || left.length !== right.length) return -1
    let product = 0
    for (let index = 0; index < left.length; index++) product += left[index] * right[index]
    const result = product / Math.sqrt(first * second)
    return Number.isFinite(result) ? result : -1
  }
  function matching(left: number[], right: number[]): number {
    const other = left === incoming ? right : right === incoming ? left : undefined
    if (!other) return cosine(left, right)
    if (incomingScores.has(other)) return incomingScores.get(other)!
    const result = cosine(left, right)
    incomingScores.set(other, result)
    return result
  }
  function samples(left: number[], right: number[]): number {
    if (!Array.isArray(left) || !Array.isArray(right)) return -1
    const known = sampleScores.get(left)?.get(right)
    if (known !== undefined) return known
    const result = matching(left, right)
    let related = sampleScores.get(left)
    if (!related) { related = new WeakMap(); sampleScores.set(left, related) }
    related.set(right, result)
    return result
  }
  return { norm, matching, samples, begin(vector: number[]) { incoming = vector; incomingScores = new WeakMap() } }
}

/** 使用稳定人脸 ID 生成维护专用人物 ID，不依赖数据库遍历次序。 */
function newPersonId(faceId: string, reserved: Set<string>): string {
  for (let attempt = 0; ; attempt++) {
    const bytes = createHash('sha256').update(`momentnest-person-rebuild-v2:${faceId}:${attempt}`).digest().subarray(0, 16)
    bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128
    const hex = bytes.toString('hex'), id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    if (!reserved.has(id)) return id
  }
}

/** 使用新检测缓存重建人物，保留人工身份及范围外数据；回访只恢复匹配，不创建新人物。 */
export async function rebuildPersonGroups<F extends RebuildFace>(input: PersonRebuildInput<F>, onProgress?: (progress: PersonRebuildProgress) => void | Promise<void>): Promise<{ faces: F[]; people: RebuildPerson[]; summary: PersonRebuildSummary }> {
  const { faces, people, assets, babies = [], editableAssetIds } = input
  if (![faces, people, assets, babies].every(Array.isArray)) throw new Error('人物维护输入必须为记录数组。')
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('人物维护进度回调无效。')
  if (editableAssetIds !== undefined && (!Array.isArray(editableAssetIds) || editableAssetIds.some(id => typeof id !== 'string' || !id))) throw new Error('人物维护范围无效。')
  const { records, roots, protectedIds, preservedIds } = personRoots(people)
  const editable = editableAssetIds === undefined ? undefined : new Set(editableAssetIds)
  const editableFace = (face: RebuildFace): boolean => editable === undefined || editable.has(face.assetId)
  const assetMap = new Map<string, RebuildAsset>(), faceMap = new Map<string, F>()
  const metadata = new Map<string, { frame: string; eligible: boolean; sceneValid: boolean }>()
  const assignments = new Map<string, string>(), originalAssignments = new Map<string, string>(), manualAssignments = new Set<string>(), externalRoots = new Set<string>(), externalPersonIds = new Set<string>()
  const cache = similarityCache()
  for (const asset of assets) {
    if (!asset || typeof asset.id !== 'string' || !asset.id || assetMap.has(asset.id)) throw new Error('媒体 ID 缺失或重复，重建已停止。')
    assetMap.set(asset.id, asset)
  }
  const summary: PersonRebuildSummary = {
    beforeGroups: people.filter(person => !person.mergedIntoId).length, afterGroups: 0, protectedGroups: protectedIds.size, externalGroups: 0,
    assignedFaces: 0, ungroupedFaces: 0, invalidFaces: 0, invalidVectors: 0, conflictedFaces: 0, reviewRequiredFaces: 0, lowScoreFaces: 0,
    ambiguousFaces: 0, matchedFaces: 0, newGroups: 0, preservedFaces: 0, manualFaces: 0, referenceFaces: 0,
    removedAutomaticGroups: 0, removedAutomaticAliases: 0, revisitPasses: 0, recoveredFaces: 0, automaticMergedGroups: 0, mergeAmbiguousGroups: 0, mergeConflicts: 0
  }
  for (const face of faces) {
    if (!face || typeof face.id !== 'string' || !face.id || faceMap.has(face.id)) throw new Error('人脸 ID 缺失或重复，重建已停止。')
    faceMap.set(face.id, face)
    const asset = assetMap.get(face.assetId), vectorValid = cache.norm(face.embedding) > 0
    const scoreValid = Number.isFinite(face.score), lowScore = scoreValid && face.score < 0.5
    const boxValid = [face.x, face.y, face.width, face.height].every(Number.isFinite) && face.x >= 0 && face.y >= 0 && face.width > 0 && face.height > 0 && face.x + face.width <= 1.000001 && face.y + face.height <= 1.000001
    const frameValid = face.frameTime === undefined || (Number.isFinite(face.frameTime) && face.frameTime >= 0)
    const assetValid = asset?.kind === 'photo' || asset?.kind === 'video'
    const valid = vectorValid && scoreValid && boxValid && frameValid && assetValid
    if (!valid) summary.invalidFaces++
    if (!vectorValid) summary.invalidVectors++
    if (lowScore) summary.lowScoreFaces++
    if (face.reviewRequired) summary.reviewRequiredFaces++
    const frame = `${face.assetId}:${asset?.kind === 'photo' ? 'photo' : face.frameTime ?? 'unknown'}`
    metadata.set(face.id, { frame, eligible: valid && !lowScore && !face.reviewRequired, sceneValid: assetValid && frameValid })
    if (face.personId !== undefined && (typeof face.personId !== 'string' || !records.has(face.personId))) throw new Error('人脸所属人物不存在，重建已停止。')
    if (!face.personId) continue
    const rootId = roots.get(face.personId)!
    if (!editableFace(face)) {
      externalRoots.add(rootId)
      let current = face.personId
      while (true) { preservedIds.add(current); externalPersonIds.add(current); const parent = records.get(current)!.mergedIntoId; if (!parent) break; current = parent }
    }
    if (preservedIds.has(face.personId) && (protectedIds.has(rootId) || !editableFace(face))) {
      if (!assetValid || !frameValid) throw new Error('人工人物的共现信息无效，重建已停止。')
      originalAssignments.set(face.id, face.personId); assignments.set(face.id, face.personId)
      if (protectedIds.has(rootId)) manualAssignments.add(face.id)
    }
  }
  const outputPeople = people.filter(person => preservedIds.has(person.id)).map(person => ({ ...person }))
  const outputMap = new Map(outputPeople.map(person => [person.id, person])), reservedIds = new Set(preservedIds)
  // 旧模型锚点已清空时，只用范围内已还原人工身份的新检测人脸恢复参考。
  for (const person of outputPeople) if (!externalPersonIds.has(person.id) && cache.norm(person.embedding) < 0) {
    const fresh = faces.filter(face => editableFace(face) && metadata.get(face.id)!.eligible && originalAssignments.get(face.id) === person.id)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))[0]
    if (fresh) person.embedding = fresh.embedding
  }
  const groups: PersonFaceGroup[] = [], groupMap = new Map<string, PersonFaceGroup>(), framePeople = new Map<string, Set<string>>()
  const trusted = new Map<string, number[][]>(), preservedSamples = new Map<string, F[]>()
  for (const person of outputPeople) if (person.mergedIntoId && person.mergeOrigin !== 'automatic' && cache.norm(person.embedding) > 0) {
    const rootId = roots.get(person.id)!, anchors = trusted.get(rootId) ?? []
    anchors.push(person.embedding); trusted.set(rootId, anchors)
  }
  // 人工身份优先保留原归属；低质量的已知人脸不会成为匹配样本。
  for (const face of faces) if (originalAssignments.has(face.id)) {
    const rootId = roots.get(originalAssignments.get(face.id)!)!, { frame, eligible } = metadata.get(face.id)!
    const occupied = framePeople.get(frame) ?? new Set<string>()
    if (occupied.has(rootId)) throw new Error('保留的人工人物存在同图或同帧冲突，重建已停止。')
    occupied.add(rootId); framePeople.set(frame, occupied)
    if (eligible) { const related = preservedSamples.get(rootId) ?? []; related.push(face); preservedSamples.set(rootId, related) }
  }
  for (const person of outputPeople.filter(person => !person.mergedIntoId).sort((left, right) => left.id.localeCompare(right.id))) {
    let anchor = cache.norm(person.embedding) > 0 ? person.embedding : []
    if (!anchor.length) {
      const fresh = (preservedSamples.get(person.id) ?? []).filter(face => editableFace(face))
        .sort((left, right) => (faceMap.get(right.id)?.score ?? 0) - (faceMap.get(left.id)?.score ?? 0) || left.id.localeCompare(right.id))[0]
      if (fresh) { anchor = fresh.embedding; if (!externalPersonIds.has(person.id)) person.embedding = anchor }
    }
    const group: PersonFaceGroup = { id: person.id, embedding: anchor, samples: representativeFaces(preservedSamples.get(person.id) ?? [], anchor, cache.samples), trustedEmbeddings: trusted.get(person.id) ?? [] }
    groups.push(group); groupMap.set(group.id, group)
  }
  const referenceOwners = new Map<string, string>(), referenceRoots = new Map<string, string>(), babyIds = new Set<string>()
  if (babies.some(baby => !baby || typeof baby.id !== 'string')) throw new Error('宝宝参考身份记录无效，重建已停止。')
  for (const baby of [...babies].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!baby || typeof baby.id !== 'string' || !baby.id || babyIds.has(baby.id) || !Array.isArray(baby.referenceFaces)) throw new Error('宝宝参考身份记录无效，重建已停止。')
    babyIds.add(baby.id)
    const references = new Map<string, F>(), scenes = new Set<string>(), knownRoots = new Set<string>()
    for (const reference of baby.referenceFaces) {
      if (!reference || typeof reference.faceId !== 'string' || typeof reference.assetId !== 'string') throw new Error('宝宝参考身份记录无效，重建已停止。')
      const face = faceMap.get(reference.faceId)
      if (!face || face.assetId !== reference.assetId || !metadata.get(face.id)!.sceneValid) throw new Error('宝宝参考未对应有效的新检测人脸，重建已停止。')
      if (references.has(face.id)) continue
      const owner = referenceOwners.get(face.id)
      if (owner && owner !== baby.id) throw new Error('同一人脸被两个宝宝同时设为参考，重建已停止。')
      const frame = metadata.get(face.id)!.frame
      if (scenes.has(frame)) throw new Error('同一宝宝参考包含同图或同帧中的不同人脸，重建已停止。')
      scenes.add(frame); references.set(face.id, face); referenceOwners.set(face.id, baby.id)
      const existing = assignments.get(face.id)
      if (existing) knownRoots.add(roots.get(existing) ?? existing)
    }
    if (!references.size) continue
    if (knownRoots.size > 1) throw new Error('宝宝参考对应多个已有人工或范围外人物，重建已停止。')
    const orderedReferences = [...references.values()].sort((left, right) => Number(metadata.get(right.id)!.eligible) - Number(metadata.get(left.id)!.eligible) || right.score - left.score || left.id.localeCompare(right.id))
    const existingRoot = knownRoots.values().next().value as string | undefined
    const rootId = existingRoot ?? newPersonId(`baby:${baby.id}:${orderedReferences[0].id}`, reservedIds)
    const owner = referenceRoots.get(rootId)
    if (owner && owner !== baby.id) throw new Error('两个宝宝参考对应同一已知人物，重建已停止。')
    referenceRoots.set(rootId, baby.id)
    if (!existingRoot) {
      reservedIds.add(rootId)
      const embedding = metadata.get(orderedReferences[0].id)!.eligible ? orderedReferences[0].embedding : []
      const person: RebuildPerson = { id: rootId, name: '', embedding }, group: PersonFaceGroup = { id: rootId, embedding, samples: [], trustedEmbeddings: [] }
      outputPeople.push(person); outputMap.set(rootId, person); groups.push(group); groupMap.set(rootId, group); summary.newGroups++
    }
    protectedIds.add(rootId)
    const group = groupMap.get(rootId)!
    for (const face of orderedReferences) {
      const { frame, eligible } = metadata.get(face.id)!, occupied = framePeople.get(frame) ?? new Set<string>()
      if (!assignments.has(face.id) && occupied.has(rootId)) throw new Error('宝宝参考与人工人物存在同图或同帧冲突，重建已停止。')
      if (editableFace(face)) assignments.set(face.id, originalAssignments.get(face.id) ?? rootId)
      occupied.add(rootId); framePeople.set(frame, occupied); manualAssignments.add(face.id)
      if (!eligible) continue
      group.trustedEmbeddings!.push(face.embedding)
      group.samples = representativeFaces([...group.samples.filter(sample => sample.id !== face.id), face], group.embedding, cache.samples)
      if (cache.samples(outputMap.get(rootId)!.embedding, face.embedding) >= 0.999999) continue
      if (outputPeople.some(person => person.mergedIntoId === rootId && person.mergeOrigin !== 'automatic' && cache.samples(person.embedding, face.embedding) >= 0.999999)) continue
      const aliasId = newPersonId(`baby-reference:${baby.id}:${face.id}`, reservedIds)
      reservedIds.add(aliasId)
      const alias: RebuildPerson = { id: aliasId, name: '', embedding: face.embedding, mergedIntoId: rootId, mergeOrigin: 'manual' }
      outputPeople.push(alias); outputMap.set(aliasId, alias)
    }
  }
  const noExclusions = new Set<string>(), conflicted = new Set<string>()
  const ordered = [...faces].filter(editableFace).sort((left, right) => (Number.isFinite(right.score) ? right.score : -Infinity) - (Number.isFinite(left.score) ? left.score : -Infinity) || left.id.localeCompare(right.id))
  const report = async (phase: PersonRebuildProgress['phase'], pass: number, processed: number, total: number): Promise<void> => {
    if (onProgress) await onProgress({ phase, pass, processed, total, groups: groups.filter(group => !outputMap.get(group.id)?.mergedIntoId).length, assignedFaces: assignments.size, ungroupedFaces: faces.length - assignments.size })
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const assign = (face: F, group: PersonFaceGroup): void => {
    const frame = metadata.get(face.id)!.frame, occupied = framePeople.get(frame) ?? new Set<string>()
    assignments.set(face.id, group.id); occupied.add(group.id); framePeople.set(frame, occupied)
    group.samples = representativeFaces([...group.samples, face], group.embedding, cache.samples)
  }
  const decide = (face: F) => {
    cache.begin(face.embedding)
    const excluded = framePeople.get(metadata.get(face.id)!.frame) ?? noExclusions
    if (excluded.size && matchingPerson(face.embedding, groups.filter(group => excluded.has(group.id)), noExclusions, cache.matching).kind !== 'new') conflicted.add(face.id)
    return matchingPerson(face.embedding, groups, excluded, cache.matching)
  }
  for (let index = 0; index < ordered.length; index++) {
    const face = ordered[index]
    if (!assignments.has(face.id) && metadata.get(face.id)!.eligible) {
      const decision = decide(face)
      if (decision.kind === 'matched') { assign(face, groupMap.get(decision.personId)!); summary.matchedFaces++ }
      else if (decision.kind === 'new') {
        const id = newPersonId(face.id, reservedIds), person: RebuildPerson = { id, name: '', embedding: face.embedding }, group: PersonFaceGroup = { id, embedding: face.embedding, samples: [] }
        reservedIds.add(id); outputPeople.push(person); outputMap.set(id, person); groups.push(group); groupMap.set(id, group); summary.newGroups++
        assign(face, group)
      }
    }
    if ((index + 1) % 128 === 0) await report('initial', 0, index + 1, ordered.length)
  }
  await report('initial', 0, ordered.length, ordered.length)
  for (let pass = 1; pass <= 3; pass++) {
    const remaining = ordered.filter(face => !assignments.has(face.id) && metadata.get(face.id)!.eligible)
    if (!remaining.length) break
    let recovered = 0
    for (let index = 0; index < remaining.length; index++) {
      const face = remaining[index], decision = decide(face)
      if (decision.kind === 'matched') { assign(face, groupMap.get(decision.personId)!); recovered++; summary.matchedFaces++ }
      if ((index + 1) % 128 === 0) await report('revisit', pass, index + 1, remaining.length)
    }
    summary.revisitPasses++; summary.recoveredFaces += recovered
    await report('revisit', pass, remaining.length, remaining.length)
    if (!recovered) break
  }
  const related = new Map<string, F[]>(), sceneSets = new Map<string, Set<string>>()
  for (const face of faces) {
    const id = assignments.get(face.id)
    if (!id) continue
    const rootId = roots.get(id) ?? id, groupFaces = related.get(rootId) ?? [], scenes = sceneSets.get(rootId) ?? new Set<string>()
    groupFaces.push(face); related.set(rootId, groupFaces); scenes.add(metadata.get(face.id)!.frame); sceneSets.set(rootId, scenes)
  }
  await report('merge', 0, 0, groups.length)
  const mergePlan = await planPersonMerges(groups.map(group => {
    const aliases = outputPeople.filter(person => person.mergedIntoId && person.mergeOrigin === 'automatic' && (roots.get(person.id) ?? person.mergedIntoId) === group.id)
    return { ...group, name: outputMap.get(group.id)!.name, frames: sceneSets.get(group.id) ?? new Set<string>(), assetCount: new Set((related.get(group.id) ?? []).map(face => face.assetId)).size, protected: protectedIds.has(group.id) || externalRoots.has(group.id), anchors: aliases.map(person => person.embedding) }
  }), cache.samples)
  for (const merge of mergePlan.merges) {
    const source = outputMap.get(merge.sourceId)!
    outputMap.set(source.id, { ...source, mergedIntoId: merge.targetId, mergeOrigin: 'automatic' })
    for (const [faceId, personId] of assignments) if (personId === source.id) assignments.set(faceId, merge.targetId)
  }
  summary.automaticMergedGroups = mergePlan.merges.length; summary.mergeAmbiguousGroups = mergePlan.ambiguous; summary.mergeConflicts = mergePlan.conflicts
  summary.afterGroups = groups.length - mergePlan.merges.length; summary.protectedGroups = protectedIds.size; summary.externalGroups = externalRoots.size
  summary.assignedFaces = assignments.size; summary.ungroupedFaces = faces.length - assignments.size; summary.conflictedFaces = conflicted.size
  summary.preservedFaces = originalAssignments.size; summary.manualFaces = manualAssignments.size; summary.referenceFaces = referenceOwners.size
  summary.ambiguousFaces = ordered.filter(face => !assignments.has(face.id) && metadata.get(face.id)!.eligible).length
  summary.removedAutomaticGroups = people.filter(person => !person.mergedIntoId && !preservedIds.has(person.id)).length
  summary.removedAutomaticAliases = people.filter(person => person.mergedIntoId && person.mergeOrigin === 'automatic' && !preservedIds.has(person.id)).length
  const outputFaces = faces.map(face => {
    if (!editableFace(face)) return { ...face }
    const result = { ...face }
    delete result.personId
    if (assignments.has(face.id)) result.personId = assignments.get(face.id)
    return result
  })
  await report('complete', summary.revisitPasses, faces.length, faces.length)
  return { people: outputPeople.map(person => outputMap.get(person.id)!).sort((left, right) => left.id.localeCompare(right.id)), faces: outputFaces, summary }
}
