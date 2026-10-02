import type { AlignmentJob, EditorDocument, VideoMaster } from '../types'

const DB_NAME = 'sologsb-1001'
const STORE_DOCUMENTS = 'documents'
const STORE_MASTERS = 'masters'
const STORE_JOBS = 'alignmentJobs'
const STORE_META = 'meta'

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 2)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'id' })
    if (!db.objectStoreNames.contains(STORE_MASTERS)) db.createObjectStore(STORE_MASTERS, { keyPath: 'id' })
    if (!db.objectStoreNames.contains(STORE_JOBS)) db.createObjectStore(STORE_JOBS, { keyPath: 'id' })
    if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transact = async <T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const request = action(tx.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })
}

export const loadDocument = (id: string) => transact<EditorDocument | undefined>(STORE_DOCUMENTS, 'readonly', (store) => store.get(id))

export const saveDocument = async (document: EditorDocument, expectedRevision?: number) => {
  const db = await openDb()
  return new Promise<EditorDocument>((resolve, reject) => {
    const tx = db.transaction(STORE_DOCUMENTS, 'readwrite')
    const store = tx.objectStore(STORE_DOCUMENTS)
    const getRequest = store.get(document.id)
    let next: EditorDocument | undefined
    let settled = false
    getRequest.onsuccess = () => {
      const current = getRequest.result as EditorDocument | undefined
      if (expectedRevision !== undefined && current && current.revision !== expectedRevision) {
        settled = true
        reject(new Error('REVISION_CONFLICT'))
        return
      }
      next = { ...JSON.parse(JSON.stringify(document)) as EditorDocument, revision: (current?.revision ?? document.revision ?? 0) + 1, updatedAt: Date.now() }
      store.put(next)
    }
    tx.oncomplete = () => {
      db.close()
      if (!settled && next) resolve(next)
    }
    tx.onerror = () => {
      db.close()
      if (!settled) reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      if (!settled) reject(tx.error ?? new Error('TRANSACTION_ABORTED'))
    }
  })
}

// ---- 母版：与工作台文档分开存储，母版读不出来时不影响工作台 ----

/** 落库前去响应式代理：IndexedDB 结构化克隆需要纯对象 */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const loadMasters = () => transact<VideoMaster[]>(STORE_MASTERS, 'readonly', (store) => store.getAll())

export const putMaster = (master: VideoMaster) => transact<IDBValidKey>(STORE_MASTERS, 'readwrite', (store) => store.put(plain(master)))

export const deleteMaster = (id: string) => transact<undefined>(STORE_MASTERS, 'readwrite', (store) => store.delete(id) as IDBRequest<undefined>)

// ---- 对齐作业检查点 ----

const JOB_KEY = 'active-alignment'

export const loadAlignmentJob = () => transact<AlignmentJob | undefined>(STORE_JOBS, 'readonly', (store) => store.get(JOB_KEY))

export const saveAlignmentJob = (job: AlignmentJob) =>
  transact<IDBValidKey>(STORE_JOBS, 'readwrite', (store) => store.put(plain({ ...job, id: JOB_KEY })))

export const clearAlignmentJob = () => transact<undefined>(STORE_JOBS, 'readwrite', (store) => store.delete(JOB_KEY) as IDBRequest<undefined>)

// ---- 杂项元数据 ----

export const loadMeta = async (key: string): Promise<unknown> => {
  const row = await transact<{ key: string; value: unknown } | undefined>(STORE_META, 'readonly', (store) => store.get(key))
  return row?.value
}

export const saveMeta = (key: string, value: unknown) =>
  transact<IDBValidKey>(STORE_META, 'readwrite', (store) => store.put(plain({ key, value })))
