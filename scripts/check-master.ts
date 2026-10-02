// 快速验证母版对齐核心算法，可直接 node --import tsx 或 npx tsx 运行；
// 这里写成零依赖形式，手工内联断言关键数值。
import { computeLanding, parseMasterText, backfillMaster } from '../src/utils/master'
import type { Cue, VideoMaster } from '../src/types'

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    console.error('FAIL:', message)
    process.exit(1)
  }
  console.log('ok  -', message)
}

// 老母版：24fps、无片头；段落 960 帧（40s）
const oldMaster: VideoMaster = {
  id: 'm24', name: 'old', fps: 24, leaderFrames: 0, importedAt: 0, revision: 1,
  segments: [{ id: 'seg-a', name: '开场', startFrame: 0, endFrame: 960 }, { id: 'seg-b', name: '采访', startFrame: 960, endFrame: 2160 }],
}
// 新母版：25fps、片头彩条 250 帧（10s）；同名段落“开场”起止为 0–1000
const newMaster: VideoMaster = {
  id: 'm25', name: 'new', fps: 25, leaderFrames: 250, importedAt: 0, revision: 1,
  segments: [{ id: 'seg-a2', name: '开场', startFrame: 0, endFrame: 1000 }, { id: 'seg-b2', name: '采访', startFrame: 1000, endFrame: 2250 }],
}

const cue: Cue = {
  id: 'c1', start: 10, end: 12, source: 's', target: 't', actorId: 'a', speed: 1, termIds: [],
  status: 'reviewed', locked: true, segmentId: 'seg-a', anchorFrame: 240, durationFrames: 48,
}
const result = computeLanding(cue, oldMaster, newMaster)
assert(!!result.landing, '锚点完整的台词能算出落地')
// 240 帧 @24 -> 250 帧 @25；起点 = (250 + 0 + 250)/25 = 20s（彩条 10s + 正片 10s）
assert(Math.abs(result.landing!.start - 20) < 1e-9, `24->25 帧率换算 + 10s 彩条后起点为 20s，实际 ${result.landing!.start}`)
assert(result.landing!.anchorFrame === 250, `内容帧锚点 240->250，实际 ${result.landing!.anchorFrame}`)
assert(result.landing!.segmentId === 'seg-a2', '同名段落优先匹配')

const noAnchor: Cue = { ...cue, id: 'c2', segmentId: undefined, anchorFrame: undefined }
assert(computeLanding(noAnchor, oldMaster, newMaster).reason === 'missing-anchor', '无锚点台词标记 missing-anchor')

const oldMaster3: VideoMaster = {
  ...oldMaster,
  segments: [
    { id: 'seg-a', name: '开场', startFrame: 0, endFrame: 960 },
    { id: 'seg-b', name: '采访', startFrame: 960, endFrame: 2160 },
    { id: 'seg-x', name: '删掉的段', startFrame: 2160, endFrame: 3120 },
  ],
}
const gone: Cue = { ...cue, id: 'c3', segmentId: 'seg-x', anchorFrame: 0, durationFrames: 24 }
assert(computeLanding(gone, oldMaster3, newMaster).reason === 'segment-gone', '消失的段落标记 segment-gone')

const longCue: Cue = { ...cue, id: 'c4', anchorFrame: 900, durationFrames: 100 }
assert(computeLanding(longCue, oldMaster, newMaster).reason === 'anchor-out-of-range', '超出新段落起止标记 anchor-out-of-range')

// 顺序匹配：旧段落无名重合时按序号落到新段落
const ordinalCue: Cue = { ...cue, id: 'c5', segmentId: 'seg-b', anchorFrame: 0, durationFrames: 24 }
const ordinal = computeLanding(ordinalCue, oldMaster, newMaster)
assert(ordinal.landing?.segmentId === 'seg-b2' && Math.abs(ordinal.landing.start - (250 + 1000) / 25) < 1e-9, '按段落顺序映射并计入段落位移')

// 回填：老台词（只有秒数）-> 24fps 母版与锚点
const legacy: Cue[] = [
  { id: 'l1', start: 0, end: 4, source: 'a', target: '', actorId: 'a', speed: 1, termIds: [], status: 'draft', locked: false },
  { id: 'l2', start: 4.5, end: 8, source: 'b', target: '', actorId: 'a', speed: 1, termIds: [], status: 'draft', locked: false },
  { id: 'l3', start: 20, end: 24, source: 'c', target: '', actorId: 'a', speed: 1, termIds: [], status: 'draft', locked: false },
]
const backfilled = backfillMaster(legacy)
assert(backfilled.master.fps === 24 && backfilled.master.backfilled === true, '回填母版基准为 24fps')
assert(backfilled.master.segments.length === 2, '间隔超过 2s 的台词切成两个段落')
assert(backfilled.anchors.get('l1')!.anchorFrame === 0, '首条锚点为 0')
assert(backfilled.anchors.get('l3')!.segmentId === backfilled.master.segments[1].id, '远距台词归入第二段')

// 母版清单解析
const parsed = parseMasterText('fps=25\nleader=250\n开场 00:00:00:00 00:00:40:00\n采访 00:00:40:00 00:01:30:00\n', 'new-master')
assert(parsed.fps === 25 && parsed.leaderFrames === 250 && parsed.segments.length === 2, '母版清单解析 fps/片头/段落')
assert(parsed.segments[1].startFrame === 1000 && parsed.segments[1].endFrame === 2250, '时间码按 25fps 转帧')

let threw = false
try { parseMasterText('开场 00:00:00:00 00:00:40:00\n', 'x') } catch { threw = true }
assert(threw, '缺 fps 的清单报错')

console.log('\nAll master alignment checks passed.')
