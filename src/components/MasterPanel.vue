<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { UploadFilled, VideoPause, Warning } from '@element-plus/icons-vue'
import { useMasterStore } from '../store/master'
import { useEditorStore } from '../store/editor'
import { frameToSeconds } from '../utils/master'
import { formatTime } from '../utils/subtitle'
import type { MessageKey } from '../i18n'

const masterStore = useMasterStore()
const editorStore = useEditorStore()
const { masters, activeMaster, storageError, job, running } = storeToRefs(masterStore)
const fileInput = ref<HTMLInputElement>()
const alignOnImport = ref(true)

const progress = computed(() => {
  if (!job.value) return { done: 0, total: 0, unmatched: 0, pending: 0 }
  const done = job.value.items.filter((item) => item.status === 'done').length
  const unmatched = job.value.items.filter((item) => item.status === 'unmatched').length
  const pending = job.value.items.filter((item) => item.status === 'pending').length
  return { done, total: job.value.items.length, unmatched, pending }
})
const progressPercent = computed(() => (progress.value.total ? Math.round(((progress.value.done + progress.value.unmatched) / progress.value.total) * 100) : 0))
const targetMaster = computed(() => masters.value.find((master) => master.id === job.value?.masterId) ?? null)
const reasonLabel = (reason?: string) =>
  ({ 'missing-anchor': 'reasonMissingAnchor', 'segment-gone': 'reasonSegmentGone', 'anchor-out-of-range': 'reasonAnchorOutOfRange' }[reason ?? ''] ?? 'reasonMissingAnchor') as MessageKey

function frameRange(master: { fps: number; leaderFrames: number }, startFrame: number, endFrame: number) {
  return editorStore.t('segmentRange', {
    from: formatTime(frameToSeconds(startFrame + master.leaderFrames, master.fps)),
    to: formatTime(frameToSeconds(endFrame + master.leaderFrames, master.fps)),
  })
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const result = await masterStore.importMaster(await file.text(), file.name, alignOnImport.value, editorStore.document.cues)
    ElMessage.success(editorStore.t('masterImportDone', { name: result.master.name, count: result.count, unmatched: result.unmatched }))
  } catch {
    ElMessage.error(editorStore.t('masterImportError'))
  } finally {
    input.value = ''
  }
}
async function retry() {
  await masterStore.retryAlignment(editorStore.document.cues)
}
async function assign(cueId: string, segmentId: string) {
  if (!segmentId) return
  await masterStore.resolveUnmatched(cueId, segmentId, editorStore.document.cues)
  if (!masterStore.hasUnmatched) ElMessage.success(editorStore.t('unmatchedCleared'))
}
function cuePreview(cueId: string) {
  return editorStore.document.cues.find((cue) => cue.id === cueId)?.source ?? cueId
}
</script>

<template>
  <section class="master-panel">
    <div class="section-heading">
      <span><el-icon><VideoPause /></el-icon>{{ editorStore.t('masterPanel') }}</span>
      <el-tag v-if="activeMaster" size="small" type="success">{{ activeMaster.fps }}fps</el-tag>
    </div>

    <div v-if="storageError" class="master-warning">
      <el-icon><Warning /></el-icon>{{ editorStore.t('masterMissing') }}
    </div>

    <div v-if="activeMaster" class="master-card">
      <b>{{ activeMaster.name }}</b>
      <span class="master-meta">
        {{ editorStore.t('masterFps') }}：{{ activeMaster.fps }} ·
        {{ editorStore.t('masterLeader') }}：{{ editorStore.t('frames', { count: activeMaster.leaderFrames }) }} ·
        {{ activeMaster.segments.length }} {{ editorStore.t('masterSegments') }}
      </span>
      <ul v-if="activeMaster.segments.length" class="segment-list">
        <li v-for="segment in activeMaster.segments" :key="segment.id">
          <code>{{ segment.name }}</code>
          <small>{{ frameRange(activeMaster, segment.startFrame, segment.endFrame) }}</small>
        </li>
      </ul>
      <p v-if="activeMaster.backfilled" class="master-note">{{ editorStore.t('masterBackfilled') }}</p>
    </div>

    <input ref="fileInput" class="file-input" type="file" accept=".txt,.edl,text/plain" @change="importFile" />
    <el-checkbox v-model="alignOnImport" class="align-toggle">{{ editorStore.t('alignOnImport') }}</el-checkbox>
    <el-button :icon="UploadFilled" size="small" class="master-import-btn" @click="fileInput?.click()">{{ editorStore.t('importMaster') }}</el-button>
    <p class="master-note">{{ editorStore.t('masterImportHint') }}</p>

    <div v-if="masters.length > 1" class="master-history">
      <label>{{ editorStore.t('masterActive') }}</label>
      <el-select :model-value="activeMaster?.id" size="small" @change="masterStore.activate(String($event))">
        <el-option v-for="master in masters" :key="master.id" :label="`${master.name} · ${master.fps}fps`" :value="master.id" />
      </el-select>
    </div>

    <div v-if="job" class="align-job">
      <template v-if="job.state === 'running'">
        <div class="align-head">
          <strong>{{ editorStore.t(running ? 'aligning' : 'alignFailed', { done: progress.done, total: progress.total, batch: job.processedBatches + 1 }) }}</strong>
          <small v-if="job.error">{{ job.error }}</small>
        </div>
        <el-progress :percentage="progressPercent" :stroke-width="8" />
        <el-button v-if="!running && (job.error || progress.pending)" size="small" type="warning" @click="retry">{{ editorStore.t('retryAlign') }}</el-button>
      </template>
      <template v-else>
        <p class="align-done">{{ editorStore.t('alignDone', { done: progress.done, unmatched: progress.unmatched }) }}</p>
      </template>

      <div v-if="progress.unmatched" class="unmatched-list">
        <h4><el-icon><Warning /></el-icon>{{ editorStore.t('unmatchedTitle') }}</h4>
        <p class="unmatched-body">{{ editorStore.t('unmatchedBody') }}</p>
        <div v-for="item in job.items.filter((entry) => entry.status === 'unmatched')" :key="item.cueId" class="unmatched-item">
          <p>{{ cuePreview(item.cueId) }}</p>
          <el-tag size="small" type="danger">{{ editorStore.t(reasonLabel(item.reason)) }}</el-tag>
          <el-select v-if="targetMaster" size="small" :placeholder="editorStore.t('pickSegment')" @change="(value: unknown) => assign(item.cueId, String(value))">
            <el-option v-for="segment in targetMaster.segments" :key="segment.id" :label="segment.name" :value="segment.id" />
          </el-select>
        </div>
      </div>
      <el-button v-if="job.state === 'done' && !progress.unmatched" size="small" text @click="masterStore.dismissJob">{{ editorStore.t('dismissJob') }}</el-button>
    </div>
  </section>
</template>
