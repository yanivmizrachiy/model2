const settingsKey = 'model2-mobile-settings-v1';
const state = { rawRows: [], daily: [], files: [] };
let deferredPrompt = null;

const defaultSettings = { owner: 'yanivmizrachiy', repo: 'model2', branch: 'main' };
const GAP_MINUTES_FOR_BREAK = 15;
const $ = (id) => document.getElementById(id);

function loadSettings() {
  try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(settingsKey) || '{}') }; }
  catch { return { ...defaultSettings }; }
}
function saveSettings(s) { localStorage.setItem(settingsKey, JSON.stringify(s)); }
function setStatus(msg) { const el = $('repoStatus'); if (el) el.textContent = msg; }
function setRefresh() { const el = $('lastRefresh'); if (el) el.textContent = 'עודכן: ' + new Date().toLocaleString('he-IL'); }

function activateScreen(name) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  const screen = $('screen-' + name);
  if (screen) screen.classList.add('active');
  const btn = document.querySelector(`.nav-btn[data-screen="${name}"]`);
  if (btn) btn.classList.add('active');
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (btn) activateScreen(btn.dataset.screen);
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = $('installBtn');
  if (btn) btn.classList.remove('hidden');
});

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function parseHebrewDateTime(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toDateKey(dateObj) {
  return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
}

function minsToText(mins) {
  if (mins == null || Number.isNaN(mins)) return 'לא ידוע';
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function durationText(mins) {
  if (mins == null || Number.isNaN(mins)) return 'לא ידוע';
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h} שעות ו-${m} דקות`;
}

function timeOfDayMinutes(dateObj) {
  return dateObj.getHours() * 60 + dateObj.getMinutes();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('שגיאת רשת: ' + res.status);
  return res.json();
}
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('שגיאת רשת: ' + res.status);
  return res.text();
}
async function fetchArrayBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('שגיאת רשת: ' + res.status);
  return res.arrayBuffer();
}

async function walkRepo(owner, repo, branch, path = '') {
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const data = await fetchJson(api);
  const list = Array.isArray(data) ? data : [];
  let results = [];
  for (const item of list) {
    if (item.type === 'dir') results = results.concat(await walkRepo(owner, repo, branch, item.path));
    else results.push(item);
  }
  return results;
}

function isDataFile(path) {
  return /\.(xlsx|xls|csv)$/i.test(path) && !/node_modules|dist|build|\.git/i.test(path);
}
function isRulesFile(path) {
  return /(^|\/)(RULES\.md|rules\.md|README\.md|AGENTS\.md|RULES_APPEND\.md)$/i.test(path);
}
function detectClassFromFilename(filePath) {
  const name = String(filePath || '');
  if (name.includes('ח1')) return 'ח׳';
  if (name.includes('ט1')) return 'ט׳';
  return '';
}

function normalizeLogRow(row, sourceFile, sourceSheet, sourceRow) {
  const timeValue = row['זמן'] || row['time'] || '';
  const student = String(row['שם מלא'] || row['משתמש מושפע'] || '').trim();
  const rawTask = String(row['הארוע מתייחס ל:'] || '').trim();
  const isQuizTask = /^בוחן:\s*/.test(rawTask);
  const task = rawTask.replace(/^בוחן:\s*/, '').trim();

  const dt = parseHebrewDateTime(timeValue);
  if (!dt || !student || !task || !isQuizTask) return null;

  return {
    student,
    className: detectClassFromFilename(sourceFile),
    task,
    timestamp: dt.getTime(),
    date: toDateKey(dt),
    minuteOfDay: timeOfDayMinutes(dt),
    sourceFile,
    sourceSheet,
    sourceRow,
    eventName: String(row['שם האירוע'] || '').trim(),
    component: String(row['רכיב'] || '').trim(),
    description: String(row['תיאור'] || '').trim(),
  };
}

function parseWorkbook(wb, filePath) {
  const rows = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    json.forEach((row, idx) => {
      const normalized = normalizeLogRow(row, filePath, sheetName, idx + 2);
      if (normalized) rows.push(normalized);
    });
  }
  return rows;
}

function parseCsv(text, filePath) {
  const wb = XLSX.read(text, { type: 'string' });
  return parseWorkbook(wb, filePath);
}

function aggregateDaily(rawRows) {
  const buckets = new Map();
  for (const row of rawRows) {
    const key = [row.student, row.className, row.date, row.task].join('||');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  const dailyMap = new Map();

  for (const events of buckets.values()) {
    events.sort((a, b) => a.timestamp - b.timestamp);

    const student = events[0].student;
    const className = events[0].className;
    const date = events[0].date;
    const task = events[0].task;

    let sessions = [];
    let sessionStart = events[0];
    let prev = events[0];

    for (let i = 1; i < events.length; i++) {
      const curr = events[i];
      const gapMin = Math.round((curr.timestamp - prev.timestamp) / 60000);
      if (gapMin >= GAP_MINUTES_FOR_BREAK) {
        sessions.push({ start: sessionStart, end: prev });
        sessionStart = curr;
      }
      prev = curr;
    }
    sessions.push({ start: sessionStart, end: prev });

    const dailyKey = [student, className, date].join('||');
    if (!dailyMap.has(dailyKey)) {
      dailyMap.set(dailyKey, {
        student, className, date,
        start: null, end: null,
        totalNet: 0,
        tasks: new Set(),
        sources: [],
        sessionCount: 0
      });
    }

    const day = dailyMap.get(dailyKey);
    day.tasks.add(task);
    day.sessionCount += sessions.length;

    for (const s of sessions) {
      const startMin = s.start.minuteOfDay;
      const endMin = s.end.minuteOfDay;
      const duration = Math.max(Math.round((s.end.timestamp - s.start.timestamp) / 60000), 0);

      day.start = day.start == null ? startMin : Math.min(day.start, startMin);
      day.end = day.end == null ? endMin : Math.max(day.end, endMin);
      day.totalNet += duration;
      day.sources.push(`${s.start.sourceFile} • ${s.start.sourceSheet} • משימה: ${task}`);
    }
  }

  return [...dailyMap.values()]
    .map(d => ({ ...d, tasks: [...d.tasks] }))
    .sort((a, b) => `${b.date}${b.student}`.localeCompare(`${a.date}${a.student}`, 'he'));
}

function filteredDaily() {
  const q = $('searchInput')?.value.trim().toLowerCase() || '';
  const cls = $('classFilter')?.value || '';
  const stu = $('studentFilter')?.value || '';
  const from = $('dateFrom')?.value || '';
  const to = $('dateTo')?.value || '';

  return state.daily.filter(r => {
    if (cls && r.className !== cls) return false;
    if (stu && r.student !== stu) return false;
    if (from && r.date && r.date < from) return false;
    if (to && r.date && r.date > to) return false;
    if (q) {
      const hay = [r.student, r.className, r.date, ...r.tasks].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function fillSelect(id, values, placeholder) {
  const sel = $(id);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>` + values.map(v => `<option value="${htmlEscape(v)}">${htmlEscape(v)}</option>`).join('');
  if (values.includes(current)) sel.value = current;
}

function groupBy(arr, fn) {
  return arr.reduce((acc, item) => {
    const k = fn(item);
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}

function renderDailyCard(r) {
  return `<article class="card">
    <h3>${htmlEscape(r.student)}</h3>
    <div class="meta">
      <div><strong>כיתה:</strong> ${htmlEscape(r.className || 'לא ידוע')}</div>
      <div><strong>תאריך:</strong> ${htmlEscape(r.date || 'לא ידוע')}</div>
      <div><strong>משעה:</strong> ${minsToText(r.start)}</div>
      <div><strong>עד שעה:</strong> ${minsToText(r.end)}</div>
      <div><strong>זמן נטו:</strong> ${durationText(r.totalNet)}</div>
      <div><strong>כמות משימות:</strong> ${r.tasks.length}</div>
    </div>
    <div class="muted">נספרות רק משימות שמתחילות ב־"בוחן:" ופער של 15 דקות ומעלה נחשב הפסקה.</div>
    <details class="source">
      <summary>משימות שתרגל ביממה הזאת</summary>
      <div class="tag-list">${r.tasks.length ? r.tasks.map(t => `<span class="tag">${htmlEscape(t)}</span>`).join('') : '<span class="muted">לא זוהתה משימה</span>'}</div>
    </details>
    <details class="source">
      <summary>מקור הנתון</summary>
      <ul>${r.sources.map(s => `<li>${htmlEscape(s)}</li>`).join('')}</ul>
    </details>
  </article>`;
}

function renderAll() {
  const daily = filteredDaily();
  const classes = [...new Set(state.daily.map(r => r.className).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
  const students = [...new Set(state.daily.map(r => r.student).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));

  fillSelect('classFilter', classes, 'כל הכיתות');
  fillSelect('studentFilter', students, 'כל התלמידים');

  const summary = $('summaryBar');
  if (summary) summary.textContent = `נמצאו ${daily.length} רשומות יומיות • ${students.length} תלמידים • ${classes.length} כיתות`;

  const dailyList = $('dailyList');
  if (dailyList) dailyList.innerHTML = daily.map(renderDailyCard).join('') || '<div class="card">לא נמצאו נתונים להצגה.</div>';

  const byStudent = groupBy(daily, r => r.student);
  const studentView = $('studentView');
  if (studentView) {
    studentView.innerHTML = Object.entries(byStudent).map(([student, rows]) => `<div class="card"><h3>${htmlEscape(student)}</h3><div class="muted">סה״כ ימים: ${rows.length}</div>${rows.map(r => `<div class="source"><strong>${htmlEscape(r.date || 'ללא תאריך')}</strong> • ${minsToText(r.start)}–${minsToText(r.end)} • ${durationText(r.totalNet)}</div>`).join('')}</div>`).join('') || '<div class="card">אין נתונים.</div>';
  }

  const byClass = groupBy(daily, r => r.className || 'ללא כיתה');
  const classView = $('classView');
  if (classView) {
    classView.innerHTML = Object.entries(byClass).map(([className, rows]) => {
      const total = rows.reduce((s, r) => s + (r.totalNet || 0), 0);
      return `<div class="card"><h3>${htmlEscape(className)}</h3><div class="muted">ימים: ${rows.length} • זמן נטו מצטבר: ${durationText(total)}</div></div>`;
    }).join('') || '<div class="card">אין נתונים.</div>';
  }
}

async function loadRules(files) {
  const first = files.find(f => isRulesFile(f.path));
  const rulesMeta = $('rulesMeta');
  const rulesContent = $('rulesContent');
  if (!first) {
    if (rulesMeta) rulesMeta.textContent = 'לא נמצא קובץ כללים מוכר בריפו.';
    if (rulesContent) rulesContent.textContent = '';
    return;
  }
  try {
    const text = await fetchText(first.download_url);
    if (rulesMeta) rulesMeta.textContent = `נטען: ${first.path}`;
    if (rulesContent) rulesContent.textContent = text;
  } catch (e) {
    if (rulesMeta) rulesMeta.textContent = `נמצא ${first.path} אך הקריאה נכשלה.`;
    if (rulesContent) rulesContent.textContent = String(e.message || e);
  }
}

async function loadData() {
  const settings = loadSettings();
  setStatus(`סורק את ${settings.owner}/${settings.repo}@${settings.branch}…`);

  try {
    const files = await walkRepo(settings.owner, settings.repo, settings.branch);
    state.files = files;
    const dataFiles = files.filter(f => isDataFile(f.path));
    setStatus(`נמצאו ${dataFiles.length} קבצי נתונים בריפו`);

    let rows = [];
    for (const f of dataFiles) {
      try {
        if (/\.csv$/i.test(f.path)) {
          const text = await fetchText(f.download_url);
          rows.push(...parseCsv(text, f.path));
        } else {
          const buf = await fetchArrayBuffer(f.download_url);
          const wb = XLSX.read(buf, { type: 'array' });
          rows.push(...parseWorkbook(wb, f.path));
        }
      } catch (e) {
        console.error('data file parse failed', f.path, e);
      }
    }

    state.rawRows = rows;
    state.daily = aggregateDaily(rows);
    await loadRules(files);
    renderAll();
    setRefresh();

    if (!state.daily.length) {
      setStatus('לא נמצאו רשומות תרגול אמיתיות לפי כלל בוחנים.');
    }
  } catch (e) {
    setStatus('שגיאה בטעינת הריפו: ' + (e.message || e));
    const dailyList = $('dailyList');
    if (dailyList) dailyList.innerHTML = `<div class="card">הטעינה נכשלה: ${htmlEscape(e.message || String(e))}</div>`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  ['searchInput', 'classFilter', 'studentFilter', 'dateFrom', 'dateTo'].forEach(id => {
    const el = $(id);
    if (el) { el.addEventListener('input', renderAll); el.addEventListener('change', renderAll); }
  });

  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadData);

  const resetBtn = $('resetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      ['searchInput', 'classFilter', 'studentFilter', 'dateFrom', 'dateTo'].forEach(id => {
        const el = $(id);
        if (el) el.value = '';
      });
      renderAll();
    });
  }

  const installBtn = $('installBtn');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.classList.add('hidden');
    });
  }

  loadData();
});
