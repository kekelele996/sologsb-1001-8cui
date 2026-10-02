export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

export interface Cue {
  id: string
  start: number
  end: number
  source: string
  target: string
  actorId: string
  speed: number
  termIds: string[]
  status: CueStatus
  locked: boolean
  segmentId?: string
}

export interface MasterSegment {
  id: string
  name: string
  start: number
  end: number
}

export interface Master {
  id: string
  fileName: string
  fps: number
  importedAt: number
  backfilled?: boolean
  segments: MasterSegment[]
}

export type UnmatchedReason = 'no-baseline' | 'no-old-segment' | 'segment-gone' | 'zero-segment'

export interface UnmatchedCue {
  cueId: string
  reason: UnmatchedReason
  oldSegmentId?: string
  rStart?: number
  rEnd?: number
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
