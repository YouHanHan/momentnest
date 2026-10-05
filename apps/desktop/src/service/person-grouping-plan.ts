import { representativeFaces } from './face-grouping.ts'
import type { GroupFace } from './face-grouping.ts'

export interface RepairPersonGroup {
  id: string; name: string; embedding: number[]; samples: GroupFace[]; frames: Set<string>; assetCount: number
  protected?: boolean
  anchors?: number[][]
  trustedEmbeddings?: number[][]
}

type Similarity = (left: number[], right: number[]) => number
interface Component {
  root: RepairPersonGroup; anchors: number[][]; trustedEmbeddings: number[][]; samples: GroupFace[]; frames: Set<string>
}
interface MergePlan {
  merges: { sourceId: string; targetId: string; similarity: number }[]; ambiguous: number; conflicts: number
}
const strongThreshold = 0.8, anchorThreshold = 0.65, ambiguityGap = 0.06
const crossSupportThreshold = 0.5, crossStrongThreshold = 0.65, crossAnchorThreshold = 0.363
const named = (group: RepairPersonGroup): boolean => Boolean(group.name.trim())
// 人工或旧版确认过的合并根保留身份，不因未命名而再次成为自动合并来源。
const preserved = (group: RepairPersonGroup): boolean => named(group) || Boolean(group.protected)

/** 只保留有限场景样本；全部原始锚点独立保留，用于阻止连续合并的漂移。 */
function component(group: RepairPersonGroup, similarity: Similarity): Component {
  return { root: group, anchors: [group.embedding, ...(group.anchors ?? [])], trustedEmbeddings: [...(group.trustedEmbeddings ?? [])], samples: representativeFaces(group.samples, group.embedding, similarity), frames: new Set(group.frames) }
}

function score(left: number[], right: number[], similarity: Similarity): number {
  const value = similarity(left, right)
  return Number.isFinite(value) ? value : -1
}

/** 原始锚点和有限场景样本提供强匹配证据，自动样本不会替代原始锚点检查。 */
function strongest(source: Component, target: Component, similarity: Similarity): number {
  const left = [source.root.embedding, ...source.trustedEmbeddings, ...source.samples.map(face => face.embedding)]
  const right = [target.root.embedding, ...target.trustedEmbeddings, ...target.samples.map(face => face.embedding)]
  let maximum = -1
  for (const first of left) for (const second of right) maximum = Math.max(maximum, score(first, second, similarity))
  return maximum
}

/** 多照片证据需覆盖双方各两项独立媒体，同一视频的重复帧只提供一项支持。 */
function repeatedCrossSupport(source: Component, target: Component, similarity: Similarity): boolean {
  if (new Set(source.samples.map(face => face.assetId)).size < 2 || new Set(target.samples.map(face => face.assetId)).size < 2) return false
  const sourceAssets = new Set<string>(), targetAssets = new Set<string>()
  for (const first of source.samples) for (const second of target.samples) {
    if (score(first.embedding, second.embedding, similarity) < crossSupportThreshold) continue
    sourceAssets.add(first.assetId); targetAssets.add(second.assetId)
  }
  return sourceAssets.size >= 2 && targetAssets.size >= 2
}

/** 沿用严格证据；多照片补充路径仍检查所有自动原锚点，人工锚点只提供可信匹配证据。 */
function mergeEvidence(source: Component, target: Component, similarity: Similarity): number {
  const mutuallySupported = (minimum: number): boolean => source.anchors.every(first => target.anchors.every(second => score(first, second, similarity) >= minimum))
  if (!mutuallySupported(crossAnchorThreshold)) return -1
  const maximum = strongest(source, target, similarity)
  if (maximum >= strongThreshold && mutuallySupported(anchorThreshold)) return maximum
  return maximum >= crossStrongThreshold && repeatedCrossSupport(source, target, similarity) ? maximum : -1
}

/** 生成本地缓存分组提案，不改写输入或媒体；命名人物和不足以确定的来源保留原组。 */
export async function planPersonMerges(groups: readonly RepairPersonGroup[], similarity: Similarity): Promise<MergePlan> {
  const ordered = [...groups].sort((left, right) => Number(preserved(right)) - Number(preserved(left)) || right.assetCount - left.assetCount || left.id.localeCompare(right.id))
  const roots: Component[] = [], plan: MergePlan = { merges: [], ambiguous: 0, conflicts: 0 }
  for (let index = 0; index < ordered.length; index++) {
    const source = component(ordered[index], similarity)
    if (preserved(source.root)) roots.push(source)
    else {
      const candidates: { target: Component; similarity: number }[] = []
      let conflict = false
      for (const target of roots) {
        // 即使场景样本很相似，来源仍需得到目标组件每个原始人物的支持。
        // 跨次整理时两边都可能包含旧自动别名，所有原始锚点都必须互相支持。
        const maximum = mergeEvidence(source, target, similarity)
        if (maximum < 0) continue
        if ([...source.frames].some(frame => target.frames.has(frame))) { conflict = true; continue }
        candidates.push({ target, similarity: maximum })
      }
      candidates.sort((left, right) => right.similarity - left.similarity || left.target.root.id.localeCompare(right.target.root.id))
      const best = candidates[0]
      if (best && candidates[1] && best.similarity - candidates[1].similarity < ambiguityGap) plan.ambiguous++
      else if (best) {
        plan.merges.push({ sourceId: source.root.id, targetId: best.target.root.id, similarity: best.similarity })
        best.target.anchors.push(...source.anchors)
        for (const frame of source.frames) best.target.frames.add(frame)
        best.target.samples = representativeFaces([...best.target.samples, ...source.samples], best.target.root.embedding, similarity)
      } else {
        roots.push(source)
        if (conflict) plan.conflicts++
      }
      // 歧义来源不成为新候选目标，避免旧碎组反复增加后续判断的歧义。
    }
    // 分批让出工作线程，缓存整理期间仍能处理查询及任务进度。
    if ((index + 1) % 16 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  return plan
}
