from pathlib import Path
import re, sys, subprocess
p = Path("mobile-pwa/app.js")
t = p.read_text(encoding="utf-8")
if "function shortDateText(value)" not in t:
    anchor = "function minsToText(mins) {\n"
    insert = "function shortDateText(value) {\n  const s = String(value || \"\").trim();\n  const m = s.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);\n  if (!m) return s || \"לא ידוע\";\n  const [, yyyy, mm, dd] = m;\n  return `${dd}.${mm}.${yyyy.slice(-2)}`;\n}\n\n"
    if anchor not in t:
        print("ERROR: anchor not found")
        sys.exit(1)
    t = t.replace(anchor, insert + anchor, 1)
t = re.sub(r"function durationText\(mins\) \{.*?\n\}", "function durationText(mins) {\n  if (mins == null || Number.isNaN(mins)) return 'לא ידוע';\n  const total = Math.max(Number(mins) || 0, 0);\n  const h = Math.floor(total / 60);\n  const m = total % 60;\n  return `${h}:${String(m).padStart(2, '0')}`;\n}", t, count=1, flags=re.S)
t = t.replace("${htmlEscape(r.date || 'לא ידוע')}", "${htmlEscape(shortDateText(r.date))}")
t = t.replace("${htmlEscape(summary.lastDate || 'לא ידוע')}", "${htmlEscape(shortDateText(summary.lastDate))}")
t = t.replace("${htmlEscape(r.date || 'ללא תאריך')}", "${htmlEscape(shortDateText(r.date))}")
t = t.replace("`n    <div class=""muted"">פער של 15 דקות ומעלה נחשב הפסקה. הסיכום מחושב לפי תלמיד ויממה בלבד.</div>", "")
t = t.replace("`n      <div class=""muted"">לחיצה על ""פתח תלמיד"" מסננת אוטומטית למסך לפי תלמיד.</div>", "")
t = t.replace("${totalMinutes}", "${durationText(totalMinutes)}")
t = t.replace("${summary.totalMinutes}", "${durationText(summary.totalMinutes)}")
p.write_text(t, encoding="utf-8")
checks = {
    "shortDateText": "function shortDateText(value)" in t,
    "duration H:MM": "return `${h}:${String(m).padStart(2, '0')}`;" in t,
    "no explanation": "פער של 15 דקות ומעלה נחשב הפסקה" not in t,
    "short date use": "shortDateText(r.date)" in t and "shortDateText(summary.lastDate)" in t,
}
for k,v in checks.items():
    print(("PASS" if v else "FAIL") + " | " + k)
if not all(checks.values()):
    print("VERIFY FAILED")
    sys.exit(1)
print("VERIFY OK")
