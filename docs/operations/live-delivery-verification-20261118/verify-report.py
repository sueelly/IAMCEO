"""Check the report against minimal recorded evidence. No runtime data or network access."""
from pathlib import Path
from html.parser import HTMLParser
import json

root = Path(__file__).resolve().parent
e = json.loads((root / "evidence.json").read_text())
md = (root / "report.md").read_text().replace("\\|", "|")
html = (root / "report.html").read_text()
class Offline(HTMLParser):
    def __init__(self):
        super().__init__()
        self.headings = 0
        self.data = []
    def handle_starttag(self, tag, attrs):
        assert tag not in {"script", "iframe", "link", "object", "embed"}
        if tag == "h2":
            self.headings += 1
        for name, value in attrs:
            assert not name.startswith("on")
            if name in {"href", "src"}:
                assert value and (value.startswith("#") or value.startswith("data:"))
    def handle_data(self, data):
        self.data.append(data)
doc = Offline()
doc.feed(html)
visible = " ".join(doc.data)
assert doc.headings == 6 and "@import" not in html and "url(" not in html
assert e["contractRev"] == 2 and e["baseline"]["schema"] == 44
assert e["baseline"]["sha"] == "166c99529eaae584169983049d0058bad78f6e29"
assert all(c["exit"] == 0 for c in e["checks"])
assert sum(c["pass"] or 0 for c in e["checks"]) == 87
assert sum(c["expectations"] or 0 for c in e["checks"]) == 535
assert e["total"] == {"testsPassed": 87, "testsFailed": 0, "files": 7, "expectations": 535, "typecheckExit": 0}
assert all(c["sourceUnchanged"] for c in e["checks"])
assert e["preservation"]["productSourceEdits"] == 0
assert all(v is False or v == 0 for v in e["preservation"].values())
r = e["receipt"]
assert r["taskCoverage"] == {"total": 17, "returned": 17, "truncated": False, "unsettledTotal": 1, "pendingWake": 0}
assert len(r["originals"]) == 2
assert all(d["status"] == "delivered" and d["attempts"] == 2 for d in r["originals"])
assert r["sharedExecution"]["sessionGeneration"] == 0
assert r["sharedExecution"]["phase"] == "ended" and r["sharedExecution"]["result"] == "success"
assert r["sharedExecution"]["endedAt"] == "2026-11-17T19:49:41.608Z"
assert len(e["independentReview"]) == 3
required = [
    e["baseline"]["sha"], e["workspace"]["branch"], e["workspace"]["path"],
    r["observedAt"], r["sharedExecution"]["runId"], r["sharedExecution"]["inputReceivedAt"],
    *[d["id"] for d in r["originals"]],
    *[d["deliveryId"] for d in e["historicEvidence"]["firstDelayed"]],
    e["historicEvidence"]["normal"]["deliveryId"], e["historicEvidence"]["normal"]["runId"],
    *[c["command"] for c in e["checks"]],
    "87", "535", "17/17", "미결은 1건", "시도 1회", "구판", "새로 실패",
]
for token in required:
    assert token in md, ("md", token)
    assert token in visible, ("html", token)
for forbidden in ["service install --restart", "POST /api/projects/", "terminal_input("]:
    assert forbidden not in md and forbidden not in html
print("PASS: 87 tests / 535 assertions, four exit-0 commands, exact baseline and two ended receipts")
print("PASS: six sections, offline HTML/Markdown parity, historical/current scope and no operational write commands")
