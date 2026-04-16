from pathlib import Path
import json, zipfile, xml.etree.ElementTree as ET
from datetime import datetime
from collections import defaultdict

NS = {'a': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'STATE' / 'verify_engine_contract.json'
GAP_MINUTES = 15


def parse_dt(value: str):
    s = str(value or '').strip()
    try:
        return datetime.strptime(s, '%d/%m/%Y, %H:%M:%S')
    except Exception:
        return None


def detect_class(name: str):
    if 'ח1' in name:
        return 'ח׳'
    if 'ט1' in name:
        return 'ט׳'
    return 'לא ידוע'


def read_xlsx_rows(path: Path):
    with zipfile.ZipFile(path) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            root = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in root.findall('a:si', NS):
                shared.append(''.join(t.text or '' for t in si.findall('.//a:t', NS)))

        wb = ET.fromstring(z.read('xl/workbook.xml'))
        sheets = wb.find('a:sheets', NS)
        first = sheets.findall('a:sheet', NS)[0]
        rid = first.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']

        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        target = None
        for rel in rels:
            if rel.attrib.get('Id') == rid:
                target = 'xl/' + rel.attrib['Target'].lstrip('/')
                break
        ws = ET.fromstring(z.read(target))

        rows = []
        for row in ws.findall('.//a:sheetData/a:row', NS):
            vals = []
            for c in row.findall('a:c', NS):
                t = c.attrib.get('t')
                v = c.find('a:v', NS)
                raw = '' if v is None else (v.text or '')
                if t == 's' and raw.isdigit() and int(raw) < len(shared):
                    vals.append(shared[int(raw)])
                else:
                    vals.append(raw)
            rows.append(vals)
        return rows


def load_events():
    files = sorted(ROOT.glob('*.xlsx'))
    events = []
    for f in files:
        rows = read_xlsx_rows(f)
        if not rows:
            continue
        header = rows[0]
        idx = {name: i for i, name in enumerate(header)}
        def get(r, key):
            i = idx.get(key)
            return r[i] if i is not None and i < len(r) else ''
        for r in rows[1:]:
            raw_task = str(get(r, 'הארוע מתייחס ל:')).strip()
            if not raw_task.startswith('בוחן:'):
                continue
            event_name = str(get(r, 'שם האירוע')).strip()
            description = str(get(r, 'תיאור')).strip()
            if not (('attempt' in event_name.lower()) or ('quiz' in description.lower()) or ('נסיון' in event_name)):
                # keep only likely real quiz actions similar to app logic
                pass
            dt = parse_dt(get(r, 'זמן'))
            student = str(get(r, 'שם מלא') or get(r, 'משתמש מושפע')).strip()
            if not dt or not student:
                continue
            events.append({
                'student': student,
                'className': detect_class(f.name),
                'date': dt.strftime('%Y-%m-%d'),
                'task': raw_task.replace('בוחן:', '', 1).strip(),
                'minute': dt.hour * 60 + dt.minute,
                'ts': dt.timestamp(),
                'source': f.name,
            })
    return events


def aggregate(events):
    by_day = defaultdict(list)
    for e in events:
        by_day[(e['student'], e['className'], e['date'])].append(e)

    rows = []
    for (student, className, date), arr in by_day.items():
        arr.sort(key=lambda x: x['ts'])
        sessions = []
        start = arr[0]
        prev = arr[0]
        for cur in arr[1:]:
            gap = round((cur['ts'] - prev['ts']) / 60)
            if gap >= GAP_MINUTES:
                sessions.append((start['minute'], prev['minute']))
                start = cur
            prev = cur
        sessions.append((start['minute'], prev['minute']))
        norm = [{'start': s, 'end': e, 'duration': max(e - s, 0)} for s, e in sessions]
        rows.append({
            'student': student,
            'className': className,
            'date': date,
            'start': norm[0]['start'],
            'end': norm[-1]['end'],
            'totalNet': sum(x['duration'] for x in norm),
            'sessions': norm,
            'tasks': sorted({x['task'] for x in arr}),
            'eventCount': len(arr),
        })
    rows.sort(key=lambda x: (x['date'], x['student']), reverse=True)
    return rows


def validate(rows):
    fails = []
    for row in rows:
        sessions = row['sessions']
        if not sessions:
            fails.append({'row': row, 'reason': 'no_sessions'})
            continue
        total = sum(s['duration'] for s in sessions)
        if total != row['totalNet']:
            fails.append({'row': row, 'reason': 'bad_total'})
        if sessions[0]['start'] != row['start']:
            fails.append({'row': row, 'reason': 'bad_start'})
        if sessions[-1]['end'] != row['end']:
            fails.append({'row': row, 'reason': 'bad_end'})
        for i, s in enumerate(sessions):
            if s['start'] > s['end']:
                fails.append({'row': row, 'reason': 'reversed_session'})
            if i > 0 and sessions[i-1]['end'] > s['start']:
                fails.append({'row': row, 'reason': 'overlap'})
    return fails


def main():
    events = load_events()
    rows = aggregate(events)
    fails = validate(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        'events': len(events),
        'days': len(rows),
        'fails': len(fails),
        'sample_rows': rows[:25],
        'sample_fails': fails[:25],
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'VERIFY events={len(events)} days={len(rows)} fails={len(fails)}')
    print(str(OUT))

if __name__ == '__main__':
    main()
