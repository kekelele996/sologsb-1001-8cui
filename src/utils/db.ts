import type { EditorDocument, Master } from '../types'
import { MASTER_STORAGE_KEY } from './master'

const DB_NAME = 'sologsb-1001'
const DOC_STORE = 'documents'
const MASTER_STORE = 'master'

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 2)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE, { keyPath: 'id' })
    if (!db.objectStoreNames.contains(MASTER_STORE)) db.createObjectStore(MASTER_STORE, { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transact = async <T>(mode: IDBTransactionMode, storeName: string, action: (store: IDBObjectStore) => IDBRequest<T>) => {
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

export const loadDocument = (id: string) => transact<EditorDocument | undefined>('readonly', DOC_STORE, (store) => store.get(id))

export const saveDocument = async (document: EditorDocument, expectedRevision?: number) => {
  const db = await openDb()
  return new Promise<EditorDocument>((resolve, reject) => {
    const tx = db.transaction(DOC_STORE, 'readwrite')
    const store = tx.objectStore(DOC_STORE)
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
      next = { ...document, revision: (current?.revision ?? document.revision ?? 0) + 1, updatedAt: Date.now() }
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

export const loadMaster = async (): Promise<Master | undefined> => {
  const db = await openDb()
  return new Promise<Master | undefined>((resolve, reject) => {
    const tx = db.transaction(MASTER_STORE, 'readonly')
    const request = tx.objectStore(MASTER_STORE).get(MASTER_STORAGE_KEY)
    request.onsuccess = () => resolve(request.result as Master | undefined)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })
}

export const saveMaster = async (master: Master): Promise<Master> => {
  const db = await openDb()
  return new Promise<Master>((resolve, reject) => {
    const tx = db.transaction(MASTER_STORE, 'readwrite')
    const stored: Master = { ...master, id: MASTER_STORAGE_KEY }
    tx.objectStore(MASTER_STORE).put(stored)
    tx.oncomplete = () => {
      db.close()
      resolve(stored)
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error ?? new Error('TRANSACTION_ABORTED'))
    }
  })
}
