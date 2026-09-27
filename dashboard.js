const PAGE_SIZE = 50;
let currentPage = 0;
let totalCount = 0;
let currentSearch = '';

// ---------- 历史视图元素 ----------
const recordsBody = document.getElementById('recordsBody');
const statsEl = document.getElementById('stats');
const pageInfo = document.getElementById('pageInfo');
const searchInput = document.getElementById('searchInput');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');

// ---------- 统计视图元素 ----------
const statsStatusIndicator = document.getElementById('statsStatusIndicator');
const statsStatusText = document.getElementById('statsStatusText');
const statsSummary = document.getElementById('statsSummary');
const domainList = document.getElementById('domainList');

// ---------- 两个视图容器 ----------
const viewHistory = document.getElementById('view-history');
const viewStats = document.getElementById('view-stats');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// 通用状态切换
// ============================================================
function setStatus(el, textEl, state, text) {
  el.classList.remove('status-loading', 'status-done');
  el.classList.add(state === 'loading' ? 'status-loading' : 'status-done');
  textEl.textContent = text;
}

// ============================================================
// 历史列表部分
// ============================================================
async function waitForSyncEnd() {
  while (true) {
    try {
      const r = await chrome.runtime.sendMessage({ action: 'isSyncing' });
      if (!r || !r.syncing) return;
    } catch (e) {
      return;
    }
    await sleep(300);
  }
}

function startCountPolling() {
  let running = true;
  const task = (async () => {
    while (running) {
      try {
        const r = await chrome.runtime.sendMessage({ action: 'getCount', search: '' });
        statsEl.textContent = `共 ${r.count || 0} 条记录`;
      } catch (e) {}
      await sleep(300);
    }
  })();
  return () => { running = false; return task; };
}

async function loadRecords(doSync = false) {
  if (doSync) {
    setStatus(statusIndicator, statusText, 'loading', '正在加载');
    chrome.runtime.sendMessage({ action: 'syncHistory' }, () => {});
    const stopPolling = startCountPolling();
    await waitForSyncEnd();
    await stopPolling();
    setStatus(statusIndicator, statusText, 'done', '加载完成');
  }

  const response = await chrome.runtime.sendMessage({
    action: 'getRecords',
    page: currentPage,
    pageSize: PAGE_SIZE,
    search: currentSearch
  });
  renderRecords(response.records || []);

  const countResp = await chrome.runtime.sendMessage({
    action: 'getCount',
    search: currentSearch
  });
  totalCount = countResp.count || 0;
  statsEl.textContent = `共 ${totalCount} 条记录`;
  updatePagination();
}

function renderRecords(records) {
  recordsBody.innerHTML = '';
  if (records.length === 0) {
    recordsBody.innerHTML =
      '<tr><td colspan="3" style="text-align:center;color:#57606a;">暂无记录</td></tr>';
    return;
  }
  records.forEach(record => {
    const tr = document.createElement('tr');

    const urlTd = document.createElement('td');
    const link = document.createElement('a');
    link.href = record.url;
    link.target = '_blank';
    link.textContent =
      record.url.length > 80 ? record.url.slice(0, 80) + '...' : record.url;
    link.title = record.url;
    urlTd.appendChild(link);
    tr.appendChild(urlTd);

    const titleTd = document.createElement('td');
    titleTd.textContent = record.title || '*';
    tr.appendChild(titleTd);

    const timeTd = document.createElement('td');
    const date = new Date(record.visitTime);
    timeTd.textContent = date.toLocaleString('zh-CN', { hour12: false });
    tr.appendChild(timeTd);

    recordsBody.appendChild(tr);
  });
}

function updatePagination() {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  pageInfo.textContent = `第 ${currentPage + 1} 页 / 共 ${totalPages || 1} 页`;
  document.getElementById('prevPage').disabled = currentPage === 0;
  document.getElementById('nextPage').disabled = currentPage >= totalPages - 1;
}

// ============================================================
// 分页 / 搜索
// ============================================================
document.getElementById('prevPage').addEventListener('click', () => {
  if (currentPage > 0) {
    currentPage--;
    loadRecords();
  }
});

document.getElementById('nextPage').addEventListener('click', () => {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  if (currentPage < totalPages - 1) {
    currentPage++;
    loadRecords();
  }
});

searchInput.addEventListener('input', () => {
  currentSearch = searchInput.value.trim();
  currentPage = 0;
  loadRecords();
});

// ============================================================
// 手动同步 / 清空
// ============================================================
document.getElementById('syncBtn').addEventListener('click', async () => {
  setStatus(statusIndicator, statusText, 'loading', '正在加载');
  chrome.runtime.sendMessage({ action: 'syncHistory' }, () => {});
  const stopPolling = startCountPolling();
  await waitForSyncEnd();
  await stopPolling();
  setStatus(statusIndicator, statusText, 'done', '加载完成');
  currentPage = 0;
  await loadRecords();
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  if (confirm('确定要清空所有记录吗？此操作不可恢复。')) {
    await chrome.runtime.sendMessage({ action: 'clearAll' });
    currentPage = 0;
    await loadRecords();
  }
});

// ============================================================
// 导入 TSV（兼容两种格式）
//   格式 A：URL \t U<时间戳> \t 标志 \t 标题 \t ... \t ...
//   格式 B：URL \t 标题 \t 2026-6-10 16:49:53 \t *
// 解析策略：不依赖固定列位置，逐列扫描自动识别「时间戳列」和「标题列」
// ============================================================

// 合理时间范围：2000-01-01 ~ 2100-01-01
const TS_MIN = Date.UTC(2000, 0, 1);
const TS_MAX = Date.UTC(2100, 0, 1);
const inTsRange = (t) => Number.isFinite(t) && t >= TS_MIN && t <= TS_MAX;

/**
 * 尝试把任意一列字符串解析成毫秒时间戳。
 * 支持：
 *   - "U1787578351947.208"  → U 前缀（毫秒浮点 / 微秒 / 秒，自动识别）
 *   - "1787578351947"       → 纯数字（毫秒 / 秒，自动识别）
 *   - "2026-6-10 16:49:53"  → 可读日期
 *   - "2026-06-10T16:49:53" → ISO
 * 解析失败返回 null。
 */
function parseTimestamp(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === '*') return null;

  // 1) U 前缀
  if (/^U/i.test(s)) {
    const num = parseFloat(s.slice(1));
    if (Number.isNaN(num)) return null;
    if (inTsRange(num))        return Math.round(num);          // 毫秒
    if (inTsRange(num / 1000)) return Math.round(num / 1000);   // 微秒
    if (inTsRange(num * 1000)) return Math.round(num * 1000);   // 秒
    return null;
  }

  // 2) 纯数字
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const num = parseFloat(s);
    if (inTsRange(num))        return Math.round(num);          // 毫秒
    if (inTsRange(num * 1000)) return Math.round(num * 1000);   // 秒
    if (inTsRange(num / 1000)) return Math.round(num / 1000);   // 微秒
    return null;
  }

  // 3) 可读日期字符串（先归一化 '-' → '/' 提高兼容性）
  let parsed = Date.parse(s.replace(/-/g, '/'));
  if (Number.isNaN(parsed)) parsed = Date.parse(s);
  if (Number.isNaN(parsed)) parsed = Date.parse(s.replace(' ', 'T'));
  if (!Number.isNaN(parsed) && inTsRange(parsed)) return parsed;

  return null;
}

/**
 * 解析 TSV 文本 → 记录数组（已按时间升序排序）
 */
function parseTsvText(text) {
  if (!text) return [];
  // 去掉 BOM
  text = text.replace(/^\uFEFF/, '');

  const lines = text.split(/\r?\n/);
  const records = [];

  for (const rawLine of lines) {
    if (!rawLine) continue;
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    const parts = line.split('\t');
    const url = (parts[0] || '').trim();
    if (!url) continue;
    // 跳过表头
    if (/^url$/i.test(url)) continue;

    // ---- 扫描时间戳列 ----
    let visitTime = null;
    let tsIdx = -1;
    for (let i = 1; i < parts.length; i++) {
      const t = parseTimestamp(parts[i]);
      if (t !== null) {
        visitTime = t;
        tsIdx = i;
        break;
      }
    }
    if (visitTime === null) continue; // 没有有效时间戳则跳过

    // ---- 扫描标题列 ----
    let title = '*';
    for (let i = 1; i < parts.length; i++) {
      if (i === tsIdx) continue;
      const v = (parts[i] || '').trim();
      if (!v) continue;
      if (v === '*') continue;
      if (/^\d+$/.test(v)) continue;                 // 跳过 "0" / "1" 这类标志位
      if (parseTimestamp(v) !== null) continue;      // 跳过其它时间戳列
      title = v;
      break;
    }

    records.push({ url, title, visitTime, source: 'import' });
  }

  // 按时间升序排列（写入顺序不影响展示，展示按 visitTime 倒序索引）
  records.sort((a, b) => a.visitTime - b.visitTime);
  return records;
}

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const records = parseTsvText(e.target.result);

    if (records.length === 0) {
      alert('未解析到有效记录，请检查文件格式');
      event.target.value = '';
      return;
    }

    setStatus(statusIndicator, statusText, 'loading', '正在导入');
    const stopPolling = startCountPolling();

    await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: 'importRecords', records },
        (resp) => resolve(resp)
      );
    });

    await stopPolling();
    setStatus(statusIndicator, statusText, 'done', '加载完成');
    currentPage = 0;
    await loadRecords();
    alert(`导入完成，共解析 ${records.length} 条记录`);
  };

  reader.readAsText(file);
  event.target.value = '';
});

// ============================================================
// 导出 TSV（保持原样，输出格式 B）
// ============================================================
document.getElementById('exportBtn').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ action: 'getAllRecords' });
  const records = response.records || [];
  if (records.length === 0) {
    alert('没有记录可导出');
    return;
  }
  records.sort((a, b) => a.visitTime - b.visitTime);

  const lines = ['URL\t标题\t访问时间\t浏览记录'];
  records.forEach(record => {
    const url = record.url || '*';
    const title = record.title || '*';
    const date = new Date(record.visitTime);
    const timeStr = date
      .toLocaleString('zh-CN', { hour12: false })
      .replace(/\//g, '-');
    lines.push(`${url}\t${title}\t${timeStr}\t*`);
  });

  const tsvContent = lines.join('\n');
  const blob = new Blob([tsvContent], { type: 'text/tab-separated-values' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `history_Record_${new Date().toISOString().slice(0, 10)}.tsv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ============================================================
// 视图切换
// ============================================================
function showHistoryView() {
  viewStats.style.display = 'none';
  viewHistory.style.display = '';
}

function showStatsView() {
  viewHistory.style.display = 'none';
  viewStats.style.display = '';
  loadStats();
}

document.getElementById('statsBtn').addEventListener('click', showStatsView);
document.getElementById('backBtn').addEventListener('click', showHistoryView);
document.getElementById('refreshStatsBtn').addEventListener('click', loadStats);

// ============================================================
// 统计逻辑
// ============================================================
const MAX_SLICES = 20;

// 匹配 http:// 或 https:// 到第 3 个 / 之间的域名
const DOMAIN_RE = /^https?:\/\/([^\/?#]+)/i;

async function loadStats() {
  setStatus(statsStatusIndicator, statsStatusText, 'loading', '正在加载');
  statsSummary.textContent = '共 0 条记录';
  domainList.innerHTML = '';

  const resp = await chrome.runtime.sendMessage({ action: 'getAllRecords' });
  const records = resp.records || [];

  const domainCount = new Map();
  let unmatched = 0;

  for (const r of records) {
    const url = r.url || '';
    const m = url.match(DOMAIN_RE);
    if (m) {
      let domain = m[1].toLowerCase().split(':')[0];
      domainCount.set(domain, (domainCount.get(domain) || 0) + 1);
    } else {
      unmatched++;
    }
  }

  const sorted = Array.from(domainCount.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, MAX_SLICES);
  const restSum = sorted.slice(MAX_SLICES).reduce((s, [, c]) => s + c, 0);

  const slices = top.map(([name, count]) => ({ name, count }));
  const otherTotal = restSum + unmatched;
  if (otherTotal > 0) slices.push({ name: '其他', count: otherTotal });

  statsSummary.textContent =
    `共 ${records.length} 条记录 · ${domainCount.size} 个域名`;

  drawPie(slices);
  renderDomainList(slices);

  setStatus(statsStatusIndicator, statsStatusText, 'done', '加载完成');
}

function drawPie(slices) {
  const canvas = document.getElementById('pie');
  const ctx = canvas.getContext('2d');

  const size = 460;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 16;
  const innerR = outerR * 0.58;

  const total = slices.reduce((s, x) => s + x.count, 0);
  if (total === 0) {
    ctx.fillStyle = '#57606a';
    ctx.font = '14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('暂无数据', cx, cy);
    return;
  }

  let startAngle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const angle = (slice.count / total) * Math.PI * 2;
    const endAngle = startAngle + angle;
    const color = `hsl(${(i * 137.508) % 360}, 62%, 56%)`;
    slice.color = color;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    startAngle = endAngle;
  });

  // 挖空中心，形成甜甜圈
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // 中心文字
  ctx.fillStyle = '#57606a';
  ctx.font = '13px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('总访问', cx, cy - 16);

  ctx.fillStyle = '#24292f';
  ctx.font = '600 24px -apple-system, sans-serif';
  ctx.fillText(total.toLocaleString(), cx, cy + 12);
}

function renderDomainList(slices) {
  const total = slices.reduce((s, x) => s + x.count, 0);
  domainList.innerHTML = '';

  slices.forEach(slice => {
    const pct = total ? (slice.count / total) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'list-row';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = slice.color || '#ccc';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = slice.name;
    name.title = slice.name;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = slice.count.toLocaleString();

    const pctEl = document.createElement('span');
    pctEl.className = 'pct';
    pctEl.textContent = pct.toFixed(2) + '%';

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(count);
    row.appendChild(pctEl);
    domainList.appendChild(row);
  });
}

// ============================================================
// 启动
// ============================================================
loadRecords(true);