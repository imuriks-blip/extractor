"""Только чтение (GET): все комменты карточки Plane целиком — внешний источник для пробы ПТ6.
  python probe/pt6-comments.py EXT-68  →  JSON [{id, created_at, text}] (text — plain, полностью), новые последними."""
import json
import sys

sys.path.insert(0, "C:/projects/_plane-rest")
import plane  # noqa: E402

ref = sys.argv[1]
project, it = plane.item_of(ref)
out, cursor = [], None
while True:
    page = plane.call("GET", f"projects/{project}/work-items/{it['id']}/comments/?per_page=100" + (f"&cursor={cursor}" if cursor else ""))
    out += page["results"]
    nc = page.get("next_cursor")
    if not page.get("next_page_results") or not nc or nc == cursor:
        break
    cursor = nc
out.sort(key=lambda c: plane.moment(c["created_at"]))
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps([{"id": c["id"], "created_at": c["created_at"], "text": plane.plain(c.get("comment_html"))} for c in out], ensure_ascii=False))
