
const settingsKey = 'model2-mobile-settings-v1';
const state = { rows: [], daily: [], files: [] };
let deferredPrompt = null;

const defaultSettings = { owner: 'yanivmizrachiy', repo: 'model2', branch: 'main' };

const HEADERS = {
  student: ['שם תלמיד', 'תלמיד', 'שם', 'student', 'name', 'full name'],
  className: ['כיתה', 'שכבה', 'קבוצה', 'class', 'grade', 'group'],
  date: ['תאריך', 'יום', 'date', 'practice date'],
  task: ['משימה', 'שם משימה', 'תרגיל', 'מטלה', 'assignment', 'task', 'activity'],
  start: ['שעת התחלה', 'התחלה', 'start', 'start time', 'begin', 'from'],
  end: ['שעת סיום', 'סיום', 'end', 'end time', 'until', 'to'],
  breakMinutes: ['הפסקה', 'דקות הפסקה', 'break', 'break minutes', 'pause minutes'],
  breakStart: ['תחילת הפסקה', 'break start', 'pause start'],
  breakEnd: ['סיום הפסקה', 'break end', 'pause end']
};

const $ = (id) => document.getElementById(id);

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(settingsKey) || '{}') };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(s) {
  localStorage.setItem(settingsKey, JSON.stringify(s));
}

function setStatus(msg) {
  const el = $('repoStatus');
  if (el) el.textContent = msg;
}

function setRefresh() {
  const el = $('lastRefresh');
  if (el) el.textContent = 'עודכן: ' + new Date().toLocaleString('he-IL');
}

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
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function norm(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findField(headers, candidates) {
  const normalized = headers.map(norm);
  for (const candidate of candidates.map(norm)) {
    const idx = normalized.findIndex(h => h === candidate || h.includes(candidate) || candidate.includes(h));
    if (idx >= 0) return headers[idx];
  }
  return null;
}

function toMinutes(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const dayMinutes = Math.round(value * 24 * 60);
    if (dayMinutes >= 0 && dayMinutes <= 24 * 60) return dayMinutes;
    return value;
  }
  const s = String(value).trim();
  const m = s.match(/(\d{1,2})[:.](\d{1,2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

function toDateISO(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') {
    const d = XLSX.SSF.parse_date_code(value);
    if (d && d.y) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(value).trim();
  const m1 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m2) {
    const y = m2[3].length === 2 ? '20' + m2[3] : m2[3];
    return `${y}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

function minsToText(mins) {
  if (mins == null || Number.isNaN(mins)) return 'לא ידוע';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function durationText(mins) {
  if (mins == null || Number.isNaN(mins)) return 'לא ידוע';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} שעות ו-${m} דקות`;
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
    if (item.type === 'dir') {
      results = results.concat(await walkRepo(owner, repo, branch, item.path));
    } else {
      results.push(item);
    }
  }
  return results;
}

function isDataFile(path) {
  return /\.(xlsx|xls|csv)$/i.test(path) && !/node_modules|dist|build|\.git/i.test(path);
}

function isRulesFile(path) {
  return /(^|\/)(RULES\.md|rules\.md|README\.md|AGENTS\.md|RULES_APPEND\.md)$/i.test(path);
}

function parseCsv(text, filePath) {
  const wb = XLSX.read(text, { type: 'string' });
  return parseWorkbook(wb, filePath);
}

function parseWorkbook(wb, filePath) {
  const rows = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    json.forEach((row, idx) => rows.push(...normalizeRow(row, filePath, sheetName, idx + 2)));
  }
  return rows;
}

function normalizeRow(row, sourceFile, sourceSheet, sourceRow) {
  const headers = Object.keys(row);
  const studentKey = findField(headers, HEADERS.student);
  const classKey = findField(headers, HEADERS.className);
  const dateKey = findField(headers, HEADERS.date);
  const taskKey = findField(headers, HEADERS.task);
  const startKey = findField(headers, HEADERS.start);
  const endKey = findField(headers, HEADERS.end);
  const breakKey = findField(headers, HEADERS.breakMinutes);
  const breakStartKey = findField(headers, HEADERS.breakStart);
  const breakEndKey = findField(headers, HEADERS.breakEnd);

  const student = studentKey ? String(row[studentKey]).trim() : '';
  if (!student) return [];

  const date = dateKey ? toDateISO(row[dateKey]) : '';
  const start = startKey ? toMinutes(row[startKey]) : null;
  const end = endKey ? toMinutes(row[endKey]) : null;

  let breakMinutes = breakKey ? toMinutes(row[breakKey]) : null;
  if ((breakMinutes == null || Number.isNaN(breakMinutes)) && breakStartKey && breakEndKey) {
    const bs = toMinutes(row[breakStartKey]);
    const be = toMinutes(row[breakEndKey]);
    if (bs != null && be != null && be >= bs) breakMinutes = be - bs;
  }
  if (breakMinutes == null || Number.isNaN(breakMinutes)) breakMinutes = 0;

  let gross = null;
  if (start != null && end != null && end >= start) gross = end - start;
  const netMinutes = gross != null ? Math.max(gross - breakMinutes, 0) : null;

  return [{
    student,
    className: classKey ? String(row[classKey]).trim() : '',
    date,
    task: taskKey ? String(row[taskKey]).trim() : '',
    start,
    end,
    breakMinutes,
    netMinutes,
    warning: (!date || start == null || end == null) ? 'יש שדות שלא זוהו במדויק' : '',
    sourceFile,
    sourceSheet,
    sourceRow
  }];
}

function aggregateDaily(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.student, row.className, row.date].join('||');
    if (!groups.has(key)) {
      groups.set(key, {
        student: row.student,
        className: row.className,
        date: row.date,
        start: row.start,
        end: row.end,
        totalNet: 0,
        tasks: new Set(),
        warnings: new Set(),
        sources: []
      });
    }
    const g = groups.get(key);
    if (row.start != null) g.start = g.start == null ? row.start : Math.min(g.start, row.start);
    if (row.end != null) g.end = g.end == null ? row.end : Math.max(g.end, row.end);
    if (row.netMinutes != null) g.totalNet += row.netMinutes;
    if (row.task) g.tasks.add(row.task);
    if (row.warning) g.warnings.add(row.warning);
    g.sources.push(`${row.sourceFile} • ${row.sourceSheet} • שורה ${row.sourceRow}`);
  }
  return [...groups.values()]
    .map(g => ({ ...g, tasks: [...g.tasks], warnings: [...g.warnings] }))
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
  return `<article class="card"><h3>${htmlEscape(r.student)}</h3><div class="meta"><div><strong>כיתה:</strong> ${htmlEscape(r.className || 'לא ידוע')}</div><div><strong>תאריך:</strong> ${htmlEscape(r.date || 'לא ידוע')}</div><div><strong>משעה:</strong> ${minsToText(r.start)}</div><div><strong>עד שעה:</strong> ${minsToText(r.end)}</div><div><strong>זמן נטו:</strong> ${durationText(r.totalNet)}</div><div><strong>כמות משימות:</strong> ${r.tasks.length}</div></div>${r.warnings.length ? `<div class="muted">אזהרה: ${htmlEscape(r.warnings.join(' | '))}</div>` : ''}<details class="source"><summary>משימות שתרגל ביממה הזאת</summary><div class="tag-list">${r.tasks.length ? r.tasks.map(t => `<span class="tag">${htmlEscape(t)}</span>`).join('') : '<span class="muted">לא זוהתה משימה</span>'}</div></details><details class="source"><summary>מקור הנתון</summary><ul>${r.sources.map(s => `<li>${htmlEscape(s)}</li>`).join('')}</ul></details></article>`;
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
  if ($('ownerInput')) $('ownerInput').value = settings.owner;
  if ($('repoInput')) $('repoInput').value = settings.repo;
  if ($('branchInput')) $('branchInput').value = settings.branch;

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
      } catch {}
    }

    state.rows = rows.filter(r => r.student);
    state.daily = aggregateDaily(state.rows);
    await loadRules(files);
    renderAll();
    setRefresh();

    if (!state.daily.length) {
      setStatus('לא זוהו עדיין שורות נתונים תקינות לקיבוץ יומי. ייתכן ששמות העמודות שונים וצריך כיוון נוסף.');
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
    if (el) {
      el.addEventListener('input', renderAll);
      el.addEventListener('change', renderAll);
    }
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

  const saveSettingsBtn = $('saveSettingsBtn');
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', () => {
      saveSettings({
        owner: $('ownerInput')?.value.trim() || defaultSettings.owner,
        repo: $('repoInput')?.value.trim() || defaultSettings.repo,
        branch: $('branchInput')?.value.trim() || defaultSettings.branch
      });
      loadData();
    });
  }

  loadData();
});
