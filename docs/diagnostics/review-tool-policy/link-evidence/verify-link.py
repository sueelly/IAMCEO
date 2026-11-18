"""Check this task's document links and preserved evidence; no old fixture execution."""
from pathlib import Path
from html.parser import HTMLParser
import hashlib
import json
import re
import subprocess

p = Path(__file__).resolve().parent
root = p.parents[3]
evidence = json.loads((p / "evidence.json").read_text())
bindings = json.loads((p / "bindings.json").read_text())
receipt = json.loads((p / "read-receipt.json").read_text())
task = "tk_qx9Byiz7koZZ"
assert evidence["taskId"] == receipt["taskId"] == task
assert evidence["contractRev"] == 1 and evidence["newSyntheticExecution"] is False
assert evidence["operationalChanges"] == 0
commit = evidence["evidenceBundleCommit"]
for row, key in zip(evidence["sourceFiles"], ("cliRaw", "serverRaw", "externalObservationRaw")):
    data = subprocess.check_output(["git", "show", commit + ":" + row["path"]], cwd=root)
    assert len(data) == row["bytes"] and hashlib.sha256(data).hexdigest() == row["sha256"]
    assert json.loads(data) == evidence[key]
text = (p / "evidence.md").read_text()
assert json.loads(text.split("~~~~~~json\n", 1)[1].split("\n~~~~~~", 1)[0]) == evidence
assert {x["key"] for x in bindings} == {"source", "diff", "execution"}
assert {x["newFileId"] for x in bindings} == {x["id"] for x in receipt["files"]}
assert all(x["bodyPresent"] and x["bodyCharacters"] > 0 for x in receipt["files"])
assert receipt["readVia"] == "post(report_id)" and receipt["executionPayloadEqualsCanonicalInputs"]
assert receipt["checks"] == {
    "baselineCallCount": 0, "candidateCallCount": 2,
    "baselineErrors": ["MCP tool call requires approval, but approval policy is never"] * 2,
    "restrictionsPreserved": True, "humanDecisionStillOpen": True,
}
cli, server = evidence["cliRaw"], evidence["serverRaw"]
assert cli["verification"] == {"restrictionsPreserved": True, "baselineDeniedBeforeMcp": True, "candidateAllowedMcp": True}
assert server["humanApproval"]["reviewDenied"] and server["humanApproval"]["decisionStillOpen"]
assert cli["operationalCalls"] == cli["realModelRequests"] == server["liveCalls"] == 0
class Static(HTMLParser):
    def __init__(self):
        super().__init__(); self.text = []; self.headings = 0
    def handle_starttag(self, tag, attrs):
        assert tag not in {"script", "iframe", "link", "object", "embed"}
        self.headings += tag == "h2"
        assert not any(k.startswith("on") or k == "src" for k, v in attrs)
    def handle_data(self, text):
        self.text.append(text)
html = (p / "index.html").read_text()
md = (p / "index.md").read_text()
parser = Static(); parser.feed(html)
visible = " ".join(parser.text)
for token in [task, evidence["originalReviewTarget"], commit, "[가림]", "missing_commit", receipt["reportId"],
              *[x["newFileId"] for x in bindings], "verify-link.py", "/agent/tool", "pending"]:
    assert token in md and token in visible, token
assert parser.headings == 3 and "@import" not in html and "url(" not in html
assert subprocess.check_output(["git", "branch", "--show-current"], cwd=root).decode().strip() == "docs-link-review-evidence-tk_qx9Byiz7koZZ"
print("PASS: current task links, supported API read receipt and complete execution JSON preserved")
print("PASS: fixed Git input hashes, call0/2, restrictions and open human decision preserved")
print("PASS: standalone HTML/Markdown parity, API masking and unverified reviewer/live boundaries explicit")
