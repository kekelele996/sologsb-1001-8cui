export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

export interface Cue {
  id: string
  /** 上屏落地开始时间（秒），由母版基准与锚点算出，可手工微调 */
  start: number
  /** 上屏落地结束时间（秒） */
  end: number
  source: string
  target: string
  actorId: string
  speed: number
  termIds: string[]
  status: CueStatus
  locked: boolean
  /** 工作台数据：所属母版段落（无锚点的老台词为空，等待回填或人工指定） */
  segmentId?: string
  /** 工作台数据：相对段落首帧的内容帧序号（以段落内容帧率计） */
  anchorFrame?: number
  /** 工作台数据：台词持续帧数（以段落内容帧率计） */
  durationFrames?: number
}

export interface Actor {
  id: string
  name: string
  color: string
  localeHint: string
}

export interface Term {
  id: string
  source: string
  target: string
  note: string
}

export interface Snapshot {
  id: string
  name: string
  createdAt: number
  cues: Cue[]
}

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  cues: Cue[]
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
  updatedAt: number
  revision: number
  lastWriter: string
}

export interface CueConflict {
  cueId: string
  type: 'actor' | 'tone' | 'address'
  message: string
}

export interface HistoryEntry {
  label: string
  cues: Cue[]
  selectedCueId: string | null
}

// ---- 母版（剪辑侧）：基准帧率 + 片头 + 每段起止，工作台不直接修改 ----

export interface MasterSegment {
  id: string
  name: string
  /** 段落首帧在母版成片时间线上的帧序号（已含片头） */
  startFrame: number
  /** 段落末帧（不含），即下一帧边界 */
  endFrame: number
}

export interface VideoMaster {
  id: string
  name: string
  /** 基准帧率：24、25 等，母版换基准时变化 */
  fps: number
  /** 片头（彩条等）长度，单位帧 */
  leaderFrames: number
  segments: MasterSegment[]
  importedAt: number
  revision: number
  /** 回填生成的母版标记，尚未从剪辑侧真正导入过 */
  backfilled?: boolean
}

// ---- 换母版对齐作业：断点检查点，算了一半失败可从这里重试 ----

export type UnmatchedReason = 'missing-anchor' | 'segment-gone' | 'anchor-out-of-range'

export interface AlignmentItem {
  cueId: string
  status: 'pending' | 'done' | 'unmatched'
  /** 本次计划归属的新段落 */
  segmentId?: string
  reason?: UnmatchedReason
}

export interface AlignmentJob {
  id: string
  /** running：批次执行中（失败停留在此，可重试）；done：批次跑完，可能仍有接不上的台词 */
  state: 'running' | 'done'
  /** 已完成的批次号（断点检查点），重试只跑剩余 pending 项 */
  processedBatches: number
  /** 计划在启动时一次性生成，重试只重跑 pending 项 */
  items: AlignmentItem[]
  /** 对齐目标母版（对齐完成后才成为当前母版） */
  masterId: string
  masterRevision: number
  masterName: string
  /** 旧母版快照，保留规划依据；接不上的台词仍保留原落地时间 */
  baseMaster: VideoMaster | null
  error?: string
  startedAt: number
  updatedAt: number
}
