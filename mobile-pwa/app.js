const settingsKey = 'model2-mobile-settings-v1';
const state = { rawRows: [], daily: [], files: [] };
let deferredPrompt = null;

const defaultSettings = { owner: 'yanivmizrachiy', repo: 'model2', branch: 'main' };
const GAP_MINUTES_FOR_BREAK = 15;
const VERIFIED_JSON_CANDIDATES = ['./STATE/daily_practice.json', '../STATE/daily_practice.json'];
const $ = (id) => document.getElementById(id);

const ALLOWED_EVENT_NAMES = new Set([
  'צפייה בנסיון מענה',
  'Quiz attempt updated',
  'נסיון בוחן נצפה',
  'נסיון בוחן עודכן',
  'Quiz attempt viewed',
  'Quiz attempt started',
  'Quiz attempt submitted',
  'נסיון בוחן נשלח'
]);

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

  const studentBtn = e.target.closest('[data-open-student]');
  if (studentBtn) {
    const student = studentBtn.getAttribute('data-open-student') || '';
    if (student && $('studentFilter')) {
      $('studentFilter').value = student;
      activateScreen('student');
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
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
  const total = Math.max(Number(mins) || 0, 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} דקות`;
  if (m === 0) return `${h} שעות`;
  return `${h} שעות ו-${m} דקות`;
}

function timeOfDayMinutes(dateObj) {
  return dateObj.getHours() * 60 + dateObj.getMinutes();
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('שגיאת רשת: ' + res.status);
  return res.json();
}
async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('שגיאת רשת: ' + res.status);
  return res.text();
}
async function fetchArrayBuffer(url) {
  const res = await fetch(url, { cache: 'no-store' });
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
function detectClassFromFilename(filePath) {
  const name = String(filePath || '');
  if (name.includes('ח1')) return 'ח׳';
  if (name.includes('ט1')) return 'ט׳';
  return 'לא ידוע';
}

function normalizeLogRow(row, sourceFile, sourceSheet, sourceRow) {
  const timeValue = row['זמן'] || row['time'] || '';
  const student = String(row['שם מלא'] || row['משתמש מושפע'] || '').trim();
  const rawTask = String(row['הארוע מתייחס ל:'] || '').trim();
  const eventName = String(row['שם האירוע'] || '').trim();
  const description = String(row['תיאור'] || '').trim();

  const isQuizTask = /^בוחן:\s*/.test(rawTask);
  const task = rawTask.replace(/^בוחן:\s*/, '').trim();
  const dt = parseHebrewDateTime(timeValue);

  if (!dt || !student || !task || !isQuizTask) return null;

  const looksLikeRealQuizAction =
    ALLOWED_EVENT_NAMES.has(eventName) ||
    /attempt/i.test(eventName) ||
    /נסיון/i.test(eventName) ||
    /quiz/i.test(description) ||
    /attempt/i.test(description);

  if (!looksLikeRealQuizAction) return null;

  return {
    student,
    className: detectClassFromFilename(sourceFile),
    task,
    timestamp: dt.getTime(),
    date: toDateKey(dt),
    minuteOfDay: timeOfDayMinutes(dt),
    sourceFile,
    sourceSheet,
    sourceRow
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

function validateDailyRow(row) {
  if (!row || !Array.isArray(row.sessions) || !row.sessions.length) return false;
  const sessions = [...row.sessions].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.start == null || s.end == null || s.start > s.end) return false;
    if (i > 0 && sessions[i - 1].end > s.start) return false;
    if (s.duration !== Math.max(s.end - s.start, 0)) return false;
  }
  const total = sessions.reduce((sum, s) => sum + s.duration, 0);
  if (total !== row.totalNet) return false;
  if (sessions[0].start !== row.start) return false;
  if (sessions[sessions.length - 1].end !== row.end) return false;
  return true;
}

function normalizeVerifiedRows(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  return rows.filter(validateDailyRow).map(row => ({
    ...row,
    tasks: Array.isArray(row.tasks) ? row.tasks : [],
    sources: Array.isArray(row.sources) ? row.sources : [],
    sessions: Array.isArray(row.sessions) ? row.sessions : []
  })).sort((a, b) => `${b.date}${b.student}`.localeCompare(`${a.date}${a.student}`, 'he'));
}

async function tryLoadVerifiedDaily() {
  for (const url of VERIFIED_JSON_CANDIDATES) {
    try {
      const payload = await fetchJson(url + `?v=${Date.now()}`);
      const rows = normalizeVerifiedRows(payload);
      if (rows.length) return { url, rows, generatedFrom: payload.generated_from || [] };
    } catch (_) {}
  }
  return null;
}

function aggregateDaily(rawRows) {
  const byDay = new Map();

  for (const row of rawRows) {
    const key = [row.student, row.className, row.date].join('||');
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }

  const dailyRows = [];

  for (const events of byDay.values()) {
    events.sort((a, b) => a.timestamp - b.timestamp);

    const student = events[0].student;
    const className = events[0].className;
    const date = events[0].date;
    const tasks = [...new Set(events.map(e => e.task).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
    const sources = [...new Set(events.map(e => `${e.sourceFile} • ${e.sourceSheet}`).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));

    const sessions = [];
    let sessionStart = events[0];
    let prev = events[0];

    for (let i = 1; i < events.length; i++) {
      const curr = events[i];
      const gapMin = Math.round((curr.timestamp - prev.timestamp) / 60000);
      if (gapMin >= GAP_MINUTES_FOR_BREAK) {
        sessions.push({ start: sessionStart.minuteOfDay, end: prev.minuteOfDay });
        sessionStart = curr;
      }
      prev = curr;
    }
    sessions.push({ start: sessionStart.minuteOfDay, end: prev.minuteOfDay });

    const normalizedSessions = sessions
      .map(s => ({ start: s.start, end: s.end, duration: Math.max(s.end - s.start, 0) }))
      .sort((a, b) => a.start - b.start);

    const row = {
      student,
      className,
      date,
      start: normalizedSessions.length ? normalizedSessions[0].start : null,
      end: normalizedSessions.length ? normalizedSessions[normalizedSessions.length - 1].end : null,
      totalNet: normalizedSessions.reduce((sum, s) => sum + s.duration, 0),
      tasks,
      sources,
      eventCount: events.length,
      sessions: normalizedSessions
    };

    if (validateDailyRow(row)) dailyRows.push(row);
  }

  return dailyRows.sort((a, b) => `${b.date}${b.student}`.localeCompare(`${a.date}${a.student}`, 'he'));
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

function summarizeStudentRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const sorted = [...safeRows].sort((a, b) => `${b.date}${b.start}`.localeCompare(`${a.date}${a.start}`, 'he'));
  const totalMinutes = sorted.reduce((sum, r) => sum + (Number(r.totalNet) || 0), 0);
  const lastDate = sorted[0]?.date || '';
  const className = sorted[0]?.className || 'לא ידוע';
  const tasks = [...new Set(sorted.flatMap(r => Array.isArray(r.tasks) ? r.tasks : []).filter(Boolean))];
  return {
    rows: sorted,
    totalMinutes,
    lastDate,
    className,
    totalDays: sorted.length,
    totalTasks: tasks.length
  };
}

function renderSessions(r) {
  if (!r.sessions || !r.sessions.length) return '<span class="muted">לא זוהו סשנים</span>';
  return r.sessions.map(s => `<span class="tag">${minsToText(s.start)}–${minsToText(s.end)}</span>`).join('');
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
    <div class="muted">פער של 15 דקות ומעלה נחשב הפסקה. הסיכום מחושב לפי תלמיד ויממה בלבד.</div>
    <details class="source" open>
      <summary>סשני התרגול באותה יממה</summary>
      <div class="tag-list">${renderSessions(r)}</div>
    </details>
    <details class="source">
      <summary>משימות שבוצעו באותה יממה</summary>
      <div class="tag-list">${r.tasks.length ? r.tasks.map(t => `<span class="tag">${htmlEscape(t)}</span>`).join('') : '<span class="muted">לא זוהתה משימה</span>'}</div>
    </details>
    <details class="source">
      <summary>מקור הנתון</summary>
      <ul>${r.sources.map(s => `<li>${htmlEscape(s)}</li>`).join('')}</ul>
    </details>
  </article>`;
}

function renderClassScreen() {
  const classView = $('classView');
  const sel = $('classScreenFilter');
  if (!classView || !sel) return;
  const selected = sel.value || '';
  if (!selected) {
    classView.innerHTML = '<div class="card">בחר כיתה כדי לראות סיכום מלא של תלמידי אותה כיתה.</div>';
    return;
  }

  const rows = state.daily.filter(r => r.className === selected);
  const grouped = groupBy(rows, r => r.student);
  const students = Object.entries(grouped)
    .map(([student, studentRows]) => ({ student, summary: summarizeStudentRows(studentRows) }))
    .sort((a, b) => a.student.localeCompare(b.student, 'he'));

  if (!students.length) {
    classView.innerHTML = `<div class="card">לא נמצאו תלמידים לכיתה ${htmlEscape(selected)}.</div>`;
    return;
  }

  const totalMinutes = students.reduce((sum, item) => sum + item.summary.totalMinutes, 0);
  classView.innerHTML = `
    <div class="card">
      <h3>כיתה ${htmlEscape(selected)}</h3>
      <div class="meta">
        <div><strong>סה״כ תלמידים:</strong> ${students.length}</div>
        <div><strong>סה״כ דקות נטו:</strong> ${totalMinutes}</div>
      </div>
      <div class="muted">לחיצה על "פתח תלמיד" מסננת אוטומטית למסך לפי תלמיד.</div>
    </div>
    ${students.map(({ student, summary }) => `
      <article class="card">
        <h3>${htmlEscape(student)}</h3>
        <div class="meta">
          <div><strong>דקות נטו מצטבר:</strong> ${summary.totalMinutes}</div>
          <div><strong>מספר ימים:</strong> ${summary.totalDays}</div>
          <div><strong>תאריך אחרון:</strong> ${htmlEscape(summary.lastDate || 'לא ידוע')}</div>
          <div><strong>מספר משימות ייחודיות:</strong> ${summary.totalTasks}</div>
        </div>
        <button class="secondary" data-open-student="${htmlEscape(student)}">פתח תלמיד</button>
      </article>`).join('')}`;
}

function renderAll() {
  const daily = filteredDaily();
  const classes = [...new Set(state.daily.map(r => r.className).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
  const students = [...new Set(state.daily.map(r => r.student).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));

  fillSelect('classFilter', classes, 'כל הכיתות');
  fillSelect('studentFilter', students, 'כל התלמידים');
  fillSelect('classScreenFilter', classes, 'בחר כיתה');

  const summary = $('summaryBar');
  if (summary) summary.textContent = `נמצאו ${daily.length} רשומות יומיות • ${students.length} תלמידים • ${classes.length} כיתות`;

  const dailyList = $('dailyList');
  if (dailyList) dailyList.innerHTML = daily.map(renderDailyCard).join('') || '<div class="card">לא נמצאו נתונים להצגה.</div>';

  const byStudent = groupBy(daily, r => r.student);
  const studentView = $('studentView');
  if (studentView) {
    const studentCards = Object.entries(byStudent)
      .sort(([a], [b]) => a.localeCompare(b, 'he'))
      .map(([student, rows]) => {
        const summary = summarizeStudentRows(rows);
        return `
          <div class="card">
            <h3>${htmlEscape(student)}</h3>
            <div class="meta">
              <div><strong>כיתה:</strong> ${htmlEscape(summary.className)}</div>
              <div><strong>סה״כ ימים:</strong> ${summary.totalDays}</div>
              <div><strong>סה״כ דקות נטו:</strong> ${summary.totalMinutes}</div>
              <div><strong>תאריך אחרון:</strong> ${htmlEscape(summary.lastDate || 'לא ידוע')}</div>
            </div>
            ${summary.rows.map(r => `
              <div class="source">
                <strong>${htmlEscape(r.date || 'ללא תאריך')}</strong> • ${durationText(r.totalNet)}
                <div class="tag-list" style="margin-top:8px">${renderSessions(r)}</div>
              </div>`).join('')}
          </div>`;
      });
    studentView.innerHTML = studentCards.join('') || '<div class="card">אין נתונים.</div>';
  }

  renderClassScreen();
}

async function loadData() {
  const settings = loadSettings();
  setStatus(`סורק את ${settings.owner}/${settings.repo}@${settings.branch}…`);

  try {
    const verified = await tryLoadVerifiedDaily();
    if (verified) {
      state.rawRows = [];
      state.daily = verified.rows;
      state.files = verified.generatedFrom;
      renderAll();
      setRefresh();
      setStatus(`מקור נתון פעיל: פלט יומי מאומת (${verified.rows.length} רשומות)`);
      return;
    }

    const files = await walkRepo(settings.owner, settings.repo, settings.branch);
    state.files = files;
    const dataFiles = files.filter(f => isDataFile(f.path));
    setStatus(`לא נמצא פלט יומי מאומת. מבצע חישוב חי מתוך ${dataFiles.length} קבצי נתונים.`);

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
    renderAll();
    setRefresh();

    if (!state.daily.length) setStatus('לא נמצאו נתוני תרגול אמיתיים לפי הסינון המשודרג.');
  } catch (e) {
    setStatus('שגיאה בטעינת הריפו: ' + (e.message || e));
    const dailyList = $('dailyList');
    if (dailyList) dailyList.innerHTML = `<div class="card">הטעינה נכשלה: ${htmlEscape(e.message || String(e))}</div>`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  ['searchInput', 'classFilter', 'studentFilter', 'dateFrom', 'dateTo', 'classScreenFilter'].forEach(id => {
    const el = $(id);
    if (el) { el.addEventListener('input', renderAll); el.addEventListener('change', renderAll); }
  });

  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadData);

  const resetBtn = $('resetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      ['searchInput', 'classFilter', 'studentFilter', 'dateFrom', 'dateTo', 'classScreenFilter'].forEach(id => {
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

  renderClassScreen();
  loadData();
});
