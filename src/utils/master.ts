import type { Cue, MasterSegment, VideoMaster } from '../types'
import { makeId } from './id'

export const SUPPORTED_FPS = [23.976, 24, 25, 29.97, 30] as const
export const DEFAULT_BACKFILL_FPS = 24
/** 相邻台词间隔超过该秒数时，回填母版切出新段落 */
const SEGMENT_GAP_SECONDS = 2

export const frameToSeconds = (frame: number, fps: number) => frame / fps

export const round2 = (value: number) => Math.round(value * 100) / 100

/** 段落首帧（不含片头）在成片上屏时间线上的秒数 */
export const segmentOnScreenStart = (segment: MasterSegment, master: VideoMaster) =>
  (master.leaderFrames + segment.startFrame) / master.fps

/** 母版成片总时长（秒，含片头） */
export const masterDuration = (master: VideoMaster) => {
  const last = master.segments[master.segments.length - 1]
  return last ? (master.leaderFrames + last.endFrame) / master.fps : master.leaderFrames / master.fps
}

const parseTcToFrames = (value: string, fps: number): number => {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[:.](\d{2})$/)
  if (!match) throw new Error('BAD_TIMECODE')
  const [, h, m, s, f] = match.map(Number)
  if (m >= 60 || s >= 60 || f >= Math.ceil(fps)) throw new Error('BAD_TIMECODE')
  return (((h * 60 + m) * 60) + s) * Math.round(fps) + f
}

/**
 * 母版清单文本格式（剪辑侧导出）：
 *   fps=25
 *   leader=240            # 片头彩条帧数；也可写时间码 00:00:10:00
 *   开场 00:00:00:00 00:00:40:00
 *   采访一 00:00:40:00 00:01:30:00
 */
export const parseMasterText = (text: string, name: string): VideoMaster => {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  let fps: number | undefined
  let leaderFrames = 0
  const segments: MasterSegment[] = []
  for (const line of lines) {
    const setting = line.match(/^(fps|frame[-_ ]?rate|leader|bars)\s*[=:]\s*(.+)$/i)
    if (setting) {
      const key = setting[1].toLowerCase()
      const raw = setting[2].trim()
      if (key.startsWith('fps') || key.startsWith('frame')) {
        fps = Number(raw)
        if (!fps || fps <= 0) throw new Error('BAD_FPS')
      } else {
        leaderFrames = raw.includes(':') ? parseTcToFrames(raw, fps ?? 25) : Math.max(0, Math.round(Number(raw)))
        if (Number.isNaN(leaderFrames)) throw new Error('BAD_LEADER')
      }
      continue
    }
    const seg = line.match(/^(.+?)\s{1,}(\d{1,3}:\d{2}:\d{2}[:.]\d{2})\s{1,}(\d{1,3}:\d{2}:\d{2}[:.]\d{2})$/)
    if (!seg) throw new Error('BAD_MASTER_LINE')
    if (!fps) throw new Error('NO_FPS')
    const startFrame = parseTcToFrames(seg[2], fps)
    const endFrame = parseTcToFrames(seg[3], fps)
    if (endFrame <= startFrame) throw new Error('BAD_SEGMENT_RANGE')
    segments.push({ id: makeId('seg'), name: seg[1].trim(), startFrame, endFrame })
  }
  if (!fps) throw new Error('NO_FPS')
  if (!segments.length) throw new Error('NO_SEGMENTS')
  segments.sort((a, b) => a.startFrame - b.startFrame)
  return { id: makeId('master'), name, fps, leaderFrames, segments, importedAt: Date.now(), revision: 1 }
}

/**
 * 老数据回填：没有基准记录时，按 24fps 从现有落地时间反推一份母版，
 * 并给每条台词写回段落与帧锚点。先回填，再启用换母版对齐。
 */
export const backfillMaster = (cues: Cue[]): { master: VideoMaster; anchors: Map<string, { segmentId: string; anchorFrame: number; durationFrames: number }> } => {
  const fps = DEFAULT_BACKFILL_FPS
  const ordered = [...cues].filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end)).sort((a, b) => a.start - b.start)
  const groups: Cue[][] = []
  for (const cue of ordered) {
    const group = groups[groups.length - 1]
    if (group && cue.start - group[group.length - 1].end < SEGMENT_GAP_SECONDS) group.push(cue)
    else groups.push([cue])
  }
  const segments: MasterSegment[] = groups.map((group, index) => {
    const startFrame = Math.floor(group[0].start * fps)
    const endFrame = Math.max(startFrame + 1, Math.ceil(group[group.length - 1].end * fps))
    return { id: makeId('seg'), name: `段落 ${index + 1}`, startFrame, endFrame }
  })
  const master: VideoMaster = {
    id: makeId('master'),
    name: '回填母版（24fps 基准）',
    fps,
    leaderFrames: 0,
    segments,
    importedAt: Date.now(),
    revision: 1,
    backfilled: true,
  }
  const anchors = new Map<string, { segmentId: string; anchorFrame: number; durationFrames: number }>()
  groups.forEach((group, index) => {
    const segment = segments[index]
    for (const cue of group) {
      const anchorFrame = Math.max(0, Math.round(cue.start * fps - segment.startFrame))
      const durationFrames = Math.max(1, Math.round((cue.end - cue.start) * fps))
      anchors.set(cue.id, { segmentId: segment.id, anchorFrame, durationFrames })
    }
  })
  return { master, anchors }
}

/** 按落地时间为（新导入等）没有锚点的台词补锚点；起点落不进任一段落时返回 null */
export const anchorFromLanding = (cue: Cue, master: VideoMaster): { segmentId: string; anchorFrame: number; durationFrames: number } | null => {
  const startFrame = Math.round(cue.start * master.fps) - master.leaderFrames
  const durationFrames = Math.max(1, Math.round((cue.end - cue.start) * master.fps))
  const segment = master.segments.find((item) => startFrame >= item.startFrame && startFrame < item.endFrame)
  if (!segment) return null
  const anchorFrame = Math.max(0, startFrame - segment.startFrame)
  // 手工微调后终点超出段落边界的台词不写锚点，留给人工在接不上清单里定
  if (anchorFrame + durationFrames > segment.endFrame - segment.startFrame) return null
  return { segmentId: segment.id, anchorFrame, durationFrames }
}

/** 旧母版段落如何对应到新母版：优先同名，否则按段落顺序 */
export const mapSegment = (oldSegmentId: string, oldMaster: VideoMaster | null, newMaster: VideoMaster): MasterSegment | undefined => {
  const oldIndex = oldMaster?.segments.findIndex((segment) => segment.id === oldSegmentId) ?? -1
  const oldSegment = oldIndex >= 0 ? oldMaster!.segments[oldIndex] : undefined
  if (oldSegment) {
    const byName = newMaster.segments.find((segment) => segment.name === oldSegment.name)
    if (byName) return byName
  }
  const ordinal = oldIndex >= 0 ? oldIndex : newMaster.segments.findIndex((segment) => segment.id === oldSegmentId)
  return ordinal >= 0 ? newMaster.segments[ordinal] : undefined
}

export interface LandingResult {
  cueId: string
  start: number
  end: number
  segmentId: string
  anchorFrame: number
  durationFrames: number
}

/** 换基准核心：帧率换算锚点，再按新母版的片头与段落起止算落地时间 */
export const computeLanding = (
  cue: Cue,
  oldMaster: VideoMaster | null,
  newMaster: VideoMaster,
): { landing?: LandingResult; reason?: 'missing-anchor' | 'segment-gone' | 'anchor-out-of-range' } => {
  if (!cue.segmentId || cue.anchorFrame === undefined || cue.durationFrames === undefined) return { reason: 'missing-anchor' }
  const segment = mapSegment(cue.segmentId, oldMaster, newMaster)
  if (!segment) return { reason: 'segment-gone' }
  const oldFps = oldMaster?.fps ?? newMaster.fps
  const scale = newMaster.fps / oldFps
  const anchorFrame = Math.round(cue.anchorFrame * scale)
  const durationFrames = Math.max(1, Math.round(cue.durationFrames * scale))
  if (anchorFrame + durationFrames > segment.endFrame - segment.startFrame) return { reason: 'anchor-out-of-range' }
  const start = (newMaster.leaderFrames + segment.startFrame + anchorFrame) / newMaster.fps
  const end = (newMaster.leaderFrames + segment.startFrame + anchorFrame + durationFrames) / newMaster.fps
  return { landing: { cueId: cue.id, start: round2(start), end: round2(end), segmentId: segment.id, anchorFrame, durationFrames } }
}
