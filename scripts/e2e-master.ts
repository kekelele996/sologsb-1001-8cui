// 端到端持久化验证（node + fake-indexeddb，不依赖浏览器）：
// 1) 老数据（无基准）初始化 -> 自动回填 24fps 母版与锚点
// 2) 导入 25fps + 10s 彩条母版 -> 落地重算，锁定/已确认内容不动
// 3) 作业检查点落库 -> 模拟刷新重建 store -> 重试链路可用
// 4) 接不上的台词进清单，人工指定段落后落地
// 5) 母版初始化抛错时工作台仍可正常初始化
import indexedDbFactory, { IDBKeyRange } from 'fake-indexeddb'

globalThis.indexedDB = indexedDbFactory as unknown as IDBFactory
globalThis.IDBKeyRange = IDBKeyRange
;(globalThis as { navigator?: unknown }).navigator = { onLine: true }
;(globalThis as { window?: unknown }).window = globalThis
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value))
}

import { createPinia, setActivePinia } from 'pinia'
import { useEditorStore } from '../src/store/editor'
import { useMasterStore } from '../src/store/master'
import { loadAlignmentJob } from '../src/utils/db'

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    console.error('FAIL:', message)
    process.exit(1)
  }
  console.log('ok  -', message)
}

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

const MASTER_25 = ['fps=25', 'leader=250', '开场 00:00:00:00 00:00:40:00', '采访一 00:00:40:00 00:01:30:00'].join('\n')

const fresh = () => setActivePinia(createPinia())

// 1. 回填
fresh()
let editor = useEditorStore()
let master = useMasterStore()
await editor.initialize()
assert(master.backfilled, '回填标记置位')
assert(master.activeMaster?.fps === 24, '回填母版基准为 24fps')
assert(editor.document.cues.every((cue) => cue.segmentId && cue.anchorFrame !== undefined && cue.durationFrames !== undefined), '每条台词都写回了段落与帧锚点')
const demo01 = editor.document.cues.find((cue) => cue.id === 'cue-demo-01')!
const sourceBefore = demo01.source
const targetBefore = demo01.target
assert(demo01.locked && demo01.status === 'reviewed', '锁定且已确认的示例数据保持')

// 2. 换母版 24 -> 25
await master.importMaster(MASTER_25, 'final-25fps.txt', true, editor.document.cues)
assert(master.activeMaster?.fps === 25, '当前母版切到 25fps')
assert(master.activeMaster.leaderFrames === 250, '片头彩条 250 帧')
const after01 = editor.document.cues.find((cue) => cue.id === 'cue-demo-01')!
assert(close(after01.start, 10), `首条 0s 内容落到彩条后 10s，实际 ${after01.start}`)
assert(after01.source === sourceBefore && after01.target === targetBefore, '锁定条目的原文/译文不动，只动落地时间')
assert(after01.status === 'reviewed' && after01.locked, '校对状态与锁定不动')
assert(master.job?.state === 'done', '作业状态 done')
const storedJob = await loadAlignmentJob()
assert(storedJob?.state === 'done', '作业检查点已持久化到 IndexedDB')

// 3. 模拟刷新：重新建 pinia/store，从持久层恢复
fresh()
editor = useEditorStore()
master = useMasterStore()
await editor.initialize()
assert(master.activeMaster?.fps === 25, '刷新后仍记住 25fps 当前母版')
assert(master.backfilled, '刷新后回填标记仍在，且没有重复造母版')
assert(master.job?.state === 'done', '刷新后恢复作业记录')
// 重试是幂等空操作，不报错
await master.retryAlignment(editor.document.cues)
assert(master.job?.state === 'done', '已完成作业重试保持 done')

// 4. 接不上的清单与人工落地
fresh()
editor = useEditorStore()
master = useMasterStore()
await editor.initialize()
editor.document.cues[0].segmentId = undefined
editor.document.cues[0].anchorFrame = undefined
editor.document.cues[0].durationFrames = undefined
await master.importMaster(MASTER_25, 'broken-25fps.txt', true, editor.document.cues)
assert(master.hasUnmatched, '缺锚点的台词进入接不上清单')
const item = master.unmatchedItems[0]
const targetSegment = master.activeMaster!.segments[1] // 采访一
await master.resolveUnmatched(item.cueId, targetSegment.id, editor.document.cues)
const cue = editor.document.cues.find((entry) => entry.id === item.cueId)!
assert(close(cue.start, (250 + targetSegment.startFrame) / 25), `人工指定段落后落到段落起点，实际 ${cue.start}`)
assert(cue.segmentId === targetSegment.id, '锚点改写为新段落')
assert(!master.hasUnmatched || master.unmatchedItems.every((entry) => entry.cueId !== item.cueId), '该条从未接清单移除')

// 5. 母版存储不可用时工作台不炸
fresh()
editor = useEditorStore()
master = useMasterStore()
master.initialized = false
let threw = false
try {
  await editor.initialize()
} catch (error) {
  threw = true
  console.error(error)
}
assert(!threw && editor.document.cues.length > 0, '母版层异常时工作台照常初始化和使用')

console.log('\nAll end-to-end master/cue checks passed.')
process.exit(0)
