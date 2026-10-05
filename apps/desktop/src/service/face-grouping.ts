export interface GroupFace { id: string; assetId: string; embedding: number[]; frameTime?: number }
export interface PersonFaceGroup { id: string; embedding: number[]; samples: GroupFace[]; trustedEmbeddings?: number[][] }
export type PersonMatchDecision = { kind: 'matched'; personId: string } | { kind: 'new' } | { kind: 'ambiguous' }
type Similarity = (left: number[], right: number[]) => number
export const personAnchorThreshold = 0.363, personMatchThreshold = 0.5

/** 保留有限且互补的场景样本，不持久化额外特征或只重复收集相近照片。 */
export function representativeFaces(faces: GroupFace[], anchor: number[], similarity: Similarity): GroupFace[] {
  const remaining = [...faces].sort((left, right) => left.id.localeCompare(right.id)), selected: GroupFace[] = []
  while (remaining.length && selected.length < 8) {
    let bestIndex = 0, bestDistance = -Infinity
    for (let index = 0; index < remaining.length; index++) {
      const face = remaining[index]
      const distance = 1 - Math.max(similarity(anchor, face.embedding), ...selected.map(sample => similarity(sample.embedding, face.embedding)))
      // 同一照片多帧不能挤占独立照片的参考位置。
      const independent = selected.some(sample => sample.assetId === face.assetId) ? 0 : 2
      if (distance + independent > bestDistance) { bestDistance = distance + independent; bestIndex = index }
    }
    selected.push(remaining.splice(bestIndex, 1)[0])
  }
  return selected
}

/** 多样本强匹配仍需组内支持和候选差距，避免跨场景漏组与相似人物误组。 */
export function matchingPerson(embedding: number[], groups: PersonFaceGroup[], excluded: Set<string>, similarity: Similarity): PersonMatchDecision {
  const candidates = groups.filter(group => !excluded.has(group.id)).map(group => {
    // 人工确认合并的原人物锚点也是可信参考，自动加入的样本不能成为新锚点。
    const anchorScore = Math.max(similarity(group.embedding, embedding), ...(group.trustedEmbeddings ?? []).map(anchor => similarity(anchor, embedding)))
    return { group, anchorScore }
  })
  const supported = candidates.filter(candidate => candidate.anchorScore >= personAnchorThreshold).map(({ group, anchorScore }) => {
    const matches = group.samples.map(face => similarity(face.embedding, embedding))
    // 自动样本只补场景差异，不能绕过可信锚点的最低支持而链式扩散。
    return { id: group.id, score: Math.max(anchorScore, ...matches) }
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  const best = supported[0]
  // 歧义与陌生人分开处理，历史自动样本不能阻挡有效锚点或不断催生新人物。
  // 达到最低相似支持但不足以确认的人脸先待归组，不能再次创建同人的碎组。
  // 没有可信候选时再核对场景样本，保留原有弱相似与无效分值的判断。
  if (!best) return { kind: candidates.some(({ group, anchorScore }) => Math.max(anchorScore, ...group.samples.map(face => similarity(face.embedding, embedding))) >= personAnchorThreshold) ? 'ambiguous' : 'new' }
  if (best.score < personMatchThreshold) return { kind: 'ambiguous' }
  if (supported[1] && best.score - supported[1].score < 0.06) return { kind: 'ambiguous' }
  return { kind: 'matched', personId: best.id }
}
