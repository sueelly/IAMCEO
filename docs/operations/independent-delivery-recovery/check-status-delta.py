"""Validate only the documentation delta; never open runtime data or call a service."""
import json
from html.parser import HTMLParser
from pathlib import Path

root = Path(__file__).resolve().parent
e = json.loads((root / "status-delta-20261118.json").read_text())
md = (root / "handoff.md").read_text()
html = (root / "handoff.html").read_text()

class OfflineDocument(HTMLParser):
    def __init__(self):
        super().__init__()
        self.headings = []
        self.fragments = []
        self.depth = 0
    def handle_starttag(self, tag, attrs):
        assert tag not in {"script", "iframe", "link", "object", "embed"}, tag
        for name, value in attrs:
            assert not name.startswith("on"), name
            if name in {"src", "href"}:
                assert value and (value.startswith("#") or value.startswith("data:")), value
        if tag == "h2":
            self.headings.append(tag)
        if tag != "style":
            self.depth += 1
    def handle_data(self, data):
        self.fragments.append(data)

doc = OfflineDocument()
doc.feed(html)
visible = " ".join(doc.fragments)
assert len(doc.headings) == 6
assert "@import" not in html and "url(" not in html
assert e["contractRev"] == 2
assert e["serverCheck"]["schema"] == {"version": 44, "supportedVersion": 44, "ok": True}
assert e["source"]["builtSchema"] == 40
assert e["scope"] == {
    "sourceEdits": 0, "operationalWrites": 0, "doneRetries": 0,
    "newSubagents": 0, "prior331TestsRepeated": False,
}
ds = e["ds"]
assert ds["currentCompletion"] == {"eligible": True, "sources": ["msg_7oHOhhO9n6Vm"]}
assert ds["coverage"]["unsettledTotal"] == 0 and not ds["coverage"]["truncated"]
assert ds["openDecisions"] == []
reports = {r["id"]: r for r in ds["reports"]}
author = reports["msg_7oHOhhO9n6Vm"]
assert author["evidence"] == "ok" and author["completionBasis"]["status"] == "passed"
assert all(c["result"] == "pass" for c in author["checks"])
assert reports["msg_c517w02aHbwl"]["completionBasis"]["status"] == "inherited"
assert len(reports) == 6
outcomes = [r for r in ds["reports"] if r["kind"] in {"완료", "막힘"}]
historical = [r for r in outcomes if r["at"] <= "2026-11-17T19:01:37.477Z"][-1]
latest = outcomes[-1]
assert historical["id"] == "msg_oIhaljZVWP3u" and historical["kind"] == "막힘"
assert latest["id"] == "msg_c517w02aHbwl" and latest["kind"] == "완료"
own = e["own"]
assert own["coverage"]["unsettledTotal"] == 0
assert len(own["originals"]) == 2
for d in own["originals"]:
    assert d["status"] == "delivered" and d["attempts"] == 2
    assert d["execution"]["sessionGeneration"] == 0
    assert d["execution"]["inputReceivedAt"] == "2026-11-17T19:42:07.749Z"
    assert d["execution"]["runId"] == "c8d215f5-7aee-471a-8df5-ee7fdaa5e960"
    assert d["execution"]["phase"] == "running" and d["execution"]["endedAt"] is None
required = [
    e["source"]["readCommit"], e["source"]["builtCodeCommit"], e["source"]["patchHead"],
    ds["coverage"]["observedAt"], own["coverage"]["observedAt"],
    "c8d215f5-7aee-471a-8df5-ee7fdaa5e960", "2026-11-17T19:42:07.749Z",
    *[d["id"] for d in own["originals"]], *reports,
    "doneRefusal", "inherited", "45건", "69건", "331개",
    "미확인", "taskSequenceBlocker", "계약 r2",
]
for token in required:
    assert token in md, ("markdown missing", token)
    assert token in visible, ("html missing", token)
assert "service install --restart" not in md and "service install --restart" not in html
assert "POST /api/projects/" not in md and "POST /api/projects/" not in html
print("PASS: contract r2 metadata, source/44/40 distinction, 6 headings, HTML/Markdown parity")
print("PASS: two original receipts, DS passed/inherited chronology, no active write commands")
print("Scope: document validation only; product tests and operational writes not run")
