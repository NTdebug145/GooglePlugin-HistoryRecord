// ============================================================
// IndexedDB 部分
// ============================================================
const DB_NAME = 'HistoryRecordDB';
const DB_VERSION = 4;          // 升版本，触发 store 重建
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
      // 无论旧结构如何，一律删除重建
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

// (URL, 秒级时间) 已存在 → 忽略；不存在 → 新增
async function addRecord(record) {
  const db = await openDB();
  const id = makeId(record.url, record.visitTime);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if (getReq.result) return;    // 已存在，忽略
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

// ============================================================
// 同步逻辑：用 getVisits 展开每次访问
// ============================================================
let syncInProgress = false;

function shouldSkip(url) {
  if (!url) return true;
  if (url.startsWith('chrome-extension://')) return true;
  if (url.startsWith('chrome://')) return true;
  if (url.startsWith('devtools://')) return true;
  if (url.startsWith('edge://')) return true;
  if (url.startsWith('about:')) return true;
  if (url.startsWith('view-source:')) return true;
  return false;
}

async function syncAllHistory() {
  if (syncInProgress) {
    console.log('同步已在进行中，跳过');
    return;
  }
  syncInProgress = true;
  try {
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

    // 先取所有 URL（去重）
    const items = await chrome.history.search({
      text: '',
      startTime: ninetyDaysAgo,
      maxResults: 1000000
    });

    let totalVisits = 0;
    let skippedUrls = 0;
    let processedUrls = 0;

    for (const item of items) {
      if (shouldSkip(item.url)) {
        skippedUrls++;
        processedUrls++;
        continue;
      }
      let visits = [];
      try {
        visits = await chrome.history.getVisits({ url: item.url });
      } catch (e) {
        processedUrls++;
        continue;
      }
      for (const visit of visits) {
        if (visit.visitTime < ninetyDaysAgo) continue;
        try {
          await addRecord({
            url: item.url,
            title: item.title || '*',
            visitTime: visit.visitTime,
            source: 'history'
          });
          totalVisits++;
        } catch (e) {}
      }
      processedUrls++;
      if (processedUrls % 200 === 0) {
        console.log(`同步进度: ${processedUrls}/${items.length}`);
      }
    }

    console.log(
      `历史同步完成：共 ${items.length} 个 URL，` +
      `跳过 ${skippedUrls} 个插件/内部页，写入 ${totalVisits} 次访问`
    );
  } finally {
    syncInProgress = false;
  }
}

// ============================================================
// 触发时机
// ============================================================
chrome.alarms.create('syncHistory', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'syncHistory') syncAllHistory();
});

chrome.runtime.onInstalled.addListener(() => syncAllHistory());
chrome.runtime.onStartup.addListener(() => syncAllHistory());

// ============================================================
// 消息接口
// ============================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'isSyncing') {
    sendResponse({ syncing: syncInProgress });
    return false;
  }
  if (request.action === 'syncHistory') {
    syncAllHistory().then(() => sendResponse({ success: true }));
    return true;
  }
  if (request.action === 'getRecords') {
    getRecordsByPage(request.page, request.pageSize, request.search)
      .then(records => sendResponse({ records }));
    return true;
  }
  if (request.action === 'getCount') {
    getTotalCount(request.search)
      .then(count => sendResponse({ count }));
    return true;
  }
  if (request.action === 'clearAll') {
    clearAll().then(() => sendResponse({ success: true }));
    return true;
  }
  if (request.action === 'importRecords') {
    (async () => {
      let count = 0;
      for (const record of request.records) {
        try {
          await addRecord(record);
          count++;
        } catch (e) {}
      }
      sendResponse({ success: true, count });
    })();
    return true;
  }
  if (request.action === 'getAllRecords') {
    getAllRecords().then(records => sendResponse({ records }));
    return true;
  }
});