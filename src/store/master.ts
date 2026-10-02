import { defineStore } from 'pinia'
import type { AlignmentItem, AlignmentJob, Cue, VideoMaster } from '../types'
import { clearAlignmentJob, deleteMaster as deleteMasterRecord, loadAlignmentJob, loadMasters, loadMeta, putMaster, saveAlignmentJob, saveMeta } from '../utils/db'
import { makeId } from '../utils/id'
import { computeLanding, parseMasterText, round2, type LandingResult } from '../utils/master'
import { useEditorStore } from './editor'

export type { LandingResult }

const ACTIVE_MASTER_KEY = 'activeMasterId'
const BACKFILLED_KEY = 'masterBackfilled'
/** 每批条数：批次之间让出主线程并写检查点，失败后从下一批重试 */
const BATCH_SIZE = 25

export const useMasterStore = defineStore('video-master', {
  state: () => ({
    masters: [] as VideoMaster[],
    activeMaster: null as VideoMaster | null,
    /** 回填基准并写完锚点后置 true；此前换母版入口禁用 */
    backfilled: false,
    job: null as AlignmentJob | null,
    initialized: false,
    /** 母版存储读取失败（如 IndexedDB 不可用），工作台照常工作 */
    storageError: false,
    running: false,
  }),
  getters: {
    activeId: (state) => state.activeMaster?.id ?? null,
    hasUnmatched(state): boolean {
      return !!state.job?.items.some((item) => item.status === 'unmatched')
    },
    unmatchedItems(state): AlignmentItem[] {
      return state.job?.items.filter((item) => item.status === 'unmatched') ?? []
    },
  },
  actions: {
    async initialize() {
      if (this.initialized) return
      try {
        const [masters, activeId, job, backfilled] = await Promise.all([
          loadMasters(),
          loadMeta(ACTIVE_MASTER_KEY) as Promise<string | undefined>,
          loadAlignmentJob().catch(() => undefined),
          loadMeta(BACKFILLED_KEY) as Promise<boolean | undefined>,
        ])
        this.masters = masters
        this.backfilled = backfilled === true
        this.activeMaster = masters.find((master) => master.id === activeId) ?? null
        this.job = job ?? null
        if (this.job && this.job.state === 'running' && job?.masterId && !masters.some((master) => master.id === job.masterId)) {
          // 目标母版已不在：清掉僵尸作业，工作台保持可用
          this.job = null
          await clearAlignmentJob().catch(() => undefined)
        }
      } catch (error) {
        // 母版读不出来：工作台照旧能用，只标记状态
        this.storageError = true
        console.error('master-storage-unavailable', error)
      }
      this.initialized = true
    },
    /** 老数据回填完成后由工作台 store 调用，登记结果 */
    async registerBackfilled(master: VideoMaster) {
      this.masters = [master, ...this.masters.filter((item) => item.id !== master.id)]
      this.activeMaster = master
      this.backfilled = true
      await this.persistMaster(master)
      await saveMeta(ACTIVE_MASTER_KEY, master.id).catch(() => undefined)
      await saveMeta(BACKFILLED_KEY, true).catch(() => undefined)
    },
    async persistMaster(master: VideoMaster) {
      const next: VideoMaster = { ...master }
      this.masters = [next, ...this.masters.filter((item) => item.id !== next.id)]
      if (this.activeMaster?.id === next.id) this.activeMaster = next
      try {
        await putMaster(next)
      } catch (error) {
        this.storageError = true
        console.error('master-save-failed', error)
      }
      return next
    },
    /** 导入剪辑侧新母版；importAndAlign 决定是否立即按新基准对齐 */
    async importMaster(text: string, filename: string, andAlign: boolean, cues: Cue[]): Promise<{ master: VideoMaster; count: number; unmatched: number }> {
      const name = filename.replace(/\.[^.]+$/, '') || `母版 ${this.masters.length + 1}`
      const master = parseMasterText(text, name)
      await this.persistMaster(master)
      let count = 0
      let unmatched = 0
      if (andAlign) {
        await this.startAlignment(master.id, cues)
        count = this.job?.items.length ?? 0
        unmatched = this.unmatchedItems.length
      }
      return { master, count, unmatched }
    },
    async activate(id: string) {
      const master = this.masters.find((item) => item.id === id)
      if (!master) return
      this.activeMaster = master
      await saveMeta(ACTIVE_MASTER_KEY, id).catch(() => undefined)
    },
    async removeMaster(id: string) {
      if (this.job && this.job.masterId === id) return
      this.masters = this.masters.filter((master) => master.id !== id)
      await deleteMasterRecord(id).catch(() => undefined)
      if (this.activeMaster?.id === id) {
        this.activeMaster = this.masters[0] ?? null
        if (this.activeMaster) await saveMeta(ACTIVE_MASTER_KEY, this.activeMaster.id).catch(() => undefined)
      }
    },
    /**
     * 换母版：一次性生成每条台词的落地计划，再分批执行。
     * 计划中即记录“接不上”的台词；批次检查点持久化，失败可重试。
     */
    async startAlignment(masterId: string, cues: Cue[]) {
      const target = this.masters.find((master) => master.id === masterId)
      if (!target) throw new Error('MASTER_NOT_FOUND')
      const base = this.activeMaster
      const items: AlignmentItem[] = cues.map((cue) => {
        const { landing, reason } = computeLanding(cue, base, target)
        if (landing) return { cueId: cue.id, status: 'pending', segmentId: landing.segmentId }
        return { cueId: cue.id, status: 'unmatched', reason }
      })
      const now = Date.now()
      const job: AlignmentJob = {
        id: makeId('align'),
        state: 'running',
        processedBatches: 0,
        items,
        masterId: target.id,
        masterRevision: target.revision,
        masterName: target.name,
        baseMaster: base ? JSON.parse(JSON.stringify(base)) as VideoMaster : null,
        startedAt: now,
        updatedAt: now,
      }
      this.job = job
      await saveAlignmentJob(job).catch(() => undefined)
      await this.runBatches(cues, false)
    },
    /** 算了一半失败：从检查点继续，只处理剩余 pending 项 */
    async retryAlignment(cues: Cue[]) {
      if (!this.job) return
      const target = this.masters.find((master) => master.id === this.job!.masterId)
      if (!target) {
        this.job = { ...JSON.parse(JSON.stringify(this.job)) as AlignmentJob, state: 'running', error: 'MASTER_GONE', updatedAt: Date.now() }
        await saveAlignmentJob(this.job).catch(() => undefined)
        return
      }
      await this.runBatches(cues, true)
    },
    async runBatches(cues: Cue[], isRetry: boolean) {
      if (!this.job || this.running) return
      const job = this.job
      const target = this.masters.find((master) => master.id === job.masterId)
      if (!target) {
        this.job = { ...job, error: 'MASTER_GONE', updatedAt: Date.now() }
        return
      }
      this.running = true
      const base = job.baseMaster
      this.job = JSON.parse(JSON.stringify(job)) as AlignmentJob
      const work = this.job
      try {
        // 批次按完整计划表的固定区间切分：processedBatches 之前的批次已全部落地，
        // 重试时从下一批开始，批次内只处理仍为 pending 的台词（结果幂等可重复计算）
        const totalBatches = Math.ceil(work.items.length / BATCH_SIZE)
        for (; work.processedBatches < totalBatches; work.processedBatches += 1) {
          const batch = work.items.slice(work.processedBatches * BATCH_SIZE, (work.processedBatches + 1) * BATCH_SIZE)
          const landings = new Map<string, LandingResult>()
          for (const item of batch) {
            if (item.status !== 'pending') continue
            const cue = cues.find((candidate) => candidate.id === item.cueId)
            if (!cue) {
              item.status = 'unmatched'
              item.reason = 'missing-anchor'
              continue
            }
            const { landing, reason } = computeLanding(cue, base, target)
            if (landing) {
              item.status = 'done'
              item.segmentId = landing.segmentId
              landings.set(cue.id, landing)
            } else {
              item.status = 'unmatched'
              item.reason = reason
            }
          }
          if (landings.size) this.applyLandings(landings, !isRetry && work.processedBatches === 0)
          // 每批结束写检查点：刷新或失败后可从 processedBatches 继续
          work.updatedAt = Date.now()
          this.job = JSON.parse(JSON.stringify(work)) as AlignmentJob
          await saveAlignmentJob(work).catch((error) => {
            throw error instanceof Error ? error : new Error('JOB_PERSIST_FAILED')
          })
          // 让出主线程，避免大批台词阻塞界面
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        work.state = 'done'
        work.error = undefined
        work.updatedAt = Date.now()
        await saveAlignmentJob(work).catch(() => undefined)
        this.job = JSON.parse(JSON.stringify(work)) as AlignmentJob
        // 全部批次跑完：工作台落地结果立即落库，再切当前母版
        await useEditorStore().flushAfterAlignment().catch(() => undefined)
        if (this.activeMaster?.id !== target.id) {
          this.activeMaster = target
          await saveMeta(ACTIVE_MASTER_KEY, target.id).catch(() => undefined)
        }
        this.job = JSON.parse(JSON.stringify(work)) as AlignmentJob
      } catch (error) {
        // 算了一半失败：作业与检查点保留，error 记录原因，界面提供“从断点重试”
        work.error = error instanceof Error ? error.message : 'ALIGN_FAILED'
        work.updatedAt = Date.now()
        await saveAlignmentJob(work).catch(() => undefined)
        this.job = JSON.parse(JSON.stringify(work)) as AlignmentJob
        console.error('alignment-failed', error)
      } finally {
        this.running = false
      }
    },
    /** 由工作台 store 覆写：真正改 cue 并写撤销历史 */
    applyLandings(_landings: Map<string, LandingResult>, _firstBatch: boolean) {
      // override by editor store
    },
    /** 人工指定接不上台词的新段落，重新算这一条 */
    async resolveUnmatched(cueId: string, segmentId: string, cues: Cue[]) {
      if (!this.job) return
      const work: AlignmentJob = JSON.parse(JSON.stringify(this.job))
      const target = this.masters.find((master) => master.id === work.masterId)
      if (!target) return
      const cue = cues.find((item) => item.id === cueId)
      if (!cue) return
      const segment = target.segments.find((item) => item.id === segmentId)
      if (!segment) return
      const durationFrames = cue.durationFrames
        ? Math.max(1, Math.round(cue.durationFrames * (target.fps / (work.baseMaster?.fps ?? target.fps))))
        : Math.max(1, Math.round((cue.end - cue.start) * target.fps))
      const start = (target.leaderFrames + segment.startFrame) / target.fps
      const end = (target.leaderFrames + segment.startFrame + durationFrames) / target.fps
      const landing: LandingResult = { cueId, start: round2(start), end: round2(end), segmentId, anchorFrame: 0, durationFrames }
      const item = work.items.find((entry) => entry.cueId === cueId)
      if (item) {
        item.status = 'done'
        item.segmentId = segmentId
        item.reason = undefined
      }
      this.applyLandings(new Map([[cueId, landing]]), false)
      work.updatedAt = Date.now()
      this.job = work
      await saveAlignmentJob(work).catch(() => undefined)
    },
    async dismissJob() {
      await clearAlignmentJob().catch(() => undefined)
      this.job = null
    },
  },
})
