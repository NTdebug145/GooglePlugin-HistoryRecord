const DB_NAME = 'HistoryRecordDB';
const DB_VERSION = 2;
const STORE_NAME = 'records';

let dbPromise = null;

// 同一 URL 同一秒只保留一条
function makeId(url, visitTime) {
  return `${url}|${Math.floor(visitTime / 1000)}`;
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      store.createIndex('visitTime', 'visitTime', { unique: false });
      store.createIndex('url', 'url', { unique: false });
    };
  });
  return dbPromise;
}

// (URL, 秒级时间) 已存在 → 直接忽略，不覆盖、不更新
async function addRecord(record) {
  const db = await openDB();
  const id = makeId(record.url, record.visitTime);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if (getReq.result) {
        // 完全一致，忽略
        return;
      }
      store.put({
        id,
        url: record.url,
        title: record.title || '*',
        visitTime: record.visitTime,
        source: record.source || 'live'
      });
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getRecordsByPage(page = 0, pageSize = 100, search = '') {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('visitTime');
    const req = index.openCursor(null, 'prev');
    const results = [];
    let skipped = 0;
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const record = cursor.value;
        if (search) {
          const s = search.toLowerCase();
          const inUrl = record.url && record.url.toLowerCase().includes(s);
          const inTitle = record.title && record.title.toLowerCase().includes(s);
          if (!inUrl && !inTitle) {
            cursor.continue();
            return;
          }
        }
        if (skipped < page * pageSize) {
          skipped++;
          cursor.continue();
          return;
        }
        if (results.length < pageSize) {
          results.push(record);
          cursor.continue();
        } else {
          resolve(results);
        }
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function getTotalCount(search = '') {
  if (!search) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const all = await getAllRecords();
  const s = search.toLowerCase();
  return all.filter(r =>
    (r.url && r.url.toLowerCase().includes(s)) ||
    (r.title && r.title.toLowerCase().includes(s))
  ).length;
}

async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

self.db = {
  openDB,
  addRecord,
  getAllRecords,
  getRecordsByPage,
  getTotalCount,
  clearAll
};