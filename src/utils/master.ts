import type { Cue, Master, MasterSegment, UnmatchedCue, UnmatchedReason } from '../types'
import { makeId } from './id'
import { parseTime } from './subtitle'

export const round3 = (n: number) => Math.round(n * 1000) / 1000
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export const MASTER_STORAGE_KEY = 'current-master'

export function parseMaster(text: string, fileName: string): Master {
  let data: { fps?: unknown; segments?: Array<Record<string, unknown>> }
  try {
    data = JSON.parse(text) as { fps?: unknown; segments?: Array<Record<string, unknown>> }
  } catch {
    throw new Error('masterParseError')
  }
  const fps = typeof data.fps === 'string' ? parseFloat(data.fps) : Number(data.fps)
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('masterBadFps')
  if (!Array.isArray(data.segments) || !data.segments.length) throw new Error('masterNoSegments')
  const segments: MasterSegment[] = data.segments
    .map((raw, index) => {
      const start = typeof raw.start === 'number' ? raw.start : parseTime(String(raw.start ?? ''))
      const end = typeof raw.end === 'number' ? raw.end : parseTime(String(raw.end ?? ''))
      return {
        id: raw.id ? String(raw.id) : `seg-${index + 1}`,
        name: raw.name ? String(raw.name) : `段 ${index + 1}`,
        start,
        end,
      }
    })
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
  if (!segments.length) throw new Error('masterNoSegments')
  return { id: makeId('master'), fileName, fps, importedAt: Date.now(), segments }
}

export interface AlignResult {
  updates: Map<string, { start: number; end: number; segmentId: string }>
  unmatched: UnmatchedCue[]
}

export function alignCues(cues: Cue[], oldMaster: Master | null | undefined, newMaster: Master): AlignResult {
  const updates = new Map<string, { start: number; end: number; segmentId: string }>()
  const unmatched: UnmatchedCue[] = []
  const oldFps = oldMaster?.fps ?? 24

  for (const cue of cues) {
    let oldSegment: MasterSegment | undefined
    if (cue.segmentId && oldMaster) {
      oldSegment = oldMaster.segments.find((segment) => segment.id === cue.segmentId)
    }
    if (!oldSegment && oldMaster) {
      oldSegment =
        oldMaster.segments.find((segment) => cue.start >= segment.start - 0.05 && cue.end <= segment.end + 0.05) ??
        oldMaster.segments.find((segment) => cue.start >= segment.start - 0.05 && cue.start < segment.end)
    }
    if (!oldSegment) {
      unmatched.push({ cueId: cue.id, reason: oldMaster ? 'no-old-segment' : 'no-baseline' })
      continue
    }
    const newSegment = newMaster.segments.find((segment) => segment.id === oldSegment.id)
    const oldStartFrame = Math.round(oldSegment.start * oldFps)
    const oldEndFrame = Math.round(oldSegment.end * oldFps)
    const cueStartFrame = Math.round(cue.start * oldFps)
    const cueEndFrame = Math.round(cue.end * oldFps)
    let rStart = (cueStartFrame - oldStartFrame) / (oldEndFrame - oldStartFrame)
    let rEnd = (cueEndFrame - oldStartFrame) / (oldEndFrame - oldStartFrame)
    rStart = clamp(rStart, 0, 1)
    rEnd = clamp(rEnd, 0, 1)
    if (rEnd <= rStart) rEnd = Math.min(1, rStart + 0.02)

    if (!newSegment) {
      unmatched.push({ cueId: cue.id, reason: 'segment-gone', oldSegmentId: oldSegment.id, rStart, rEnd })
      continue
    }

    const newStartFrame = Math.round(newSegment.start * newMaster.fps)
    const newEndFrame = Math.round(newSegment.end * newMaster.fps)
    if (oldEndFrame <= oldStartFrame || newEndFrame <= newStartFrame) {
      unmatched.push({ cueId: cue.id, reason: 'zero-segment', oldSegmentId: oldSegment.id, rStart, rEnd })
      continue
    }

    const landingStartFrame = Math.round(newStartFrame + rStart * (newEndFrame - newStartFrame))
    const landingEndFrame = Math.round(newStartFrame + rEnd * (newEndFrame - newStartFrame))
    updates.set(cue.id, {
      start: round3(landingStartFrame / newMaster.fps),
      end: round3(landingEndFrame / newMaster.fps),
      segmentId: newSegment.id,
    })
  }

  return { updates, unmatched }
}

export function backfillMaster(cues: Cue[]): Master {
  const sorted = [...cues].sort((a, b) => a.start - b.start)
  const segments: MasterSegment[] = []
  let current: MasterSegment | null = null
  let index = 1
  for (const cue of sorted) {
    if (!current || cue.start - current.end > 6) {
      if (current) segments.push(current)
      current = { id: 'seg-main', name: `段 ${index}`, start: cue.start, end: cue.end }
      index += 1
    } else {
      current.end = Math.max(current.end, cue.end)
    }
  }
  if (current) segments.push(current)
  if (!segments.length) segments.push({ id: 'seg-main', name: '段 1', start: 0, end: 60 })
  segments[0].id = 'seg-main'
  return {
    id: makeId('master'),
    fileName: '已回填基准',
    fps: 24,
    importedAt: Date.now(),
    backfilled: true,
    segments,
  }
}

export function demoMaster(): Master {
  return {
    id: makeId('master'),
    fileName: 'demo-master-25fps.json',
    fps: 25,
    importedAt: Date.now(),
    segments: [
      { id: 'seg-bars', name: '彩条', start: 0, end: 10 },
      { id: 'seg-main', name: '正片', start: 10, end: 310 },
    ],
  }
}

export function masterTemplate(): string {
  return JSON.stringify(
    {
      fps: 25,
      segments: [
        { id: 'seg-bars', name: '彩条', start: 0, end: 10 },
        { id: 'seg-main', name: '正片', start: 10, end: 310 },
      ],
    },
    null,
    2,
  )
}

export const unmatchedReasonKey = (reason: UnmatchedReason): string => {
  switch (reason) {
    case 'no-baseline':
      return 'unmatchedNoBaseline'
    case 'no-old-segment':
      return 'unmatchedNoOldSegment'
    case 'segment-gone':
      return 'unmatchedSegmentGone'
    case 'zero-segment':
      return 'unmatchedZeroSegment'
  }
}
