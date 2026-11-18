"""Verify exported evidence against immutable Git objects; do not execute old fixtures."""
from pathlib import Path
import hashlib
import json
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
m = json.loads((HERE / "manifest.json").read_text())
snapshot = (HERE / "snapshot.md").read_bytes()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def exported(marker):
    prefix = ("<!-- " + marker + " -->\n").encode()
    assert snapshot.count(prefix) == 1
    rest = snapshot.split(prefix, 1)[1]
    first, rest = rest.split(b"\n", 1)
    delimiter = first[:len(first) - len(first.lstrip(b"~"))]
    assert len(delimiter) >= 6
    payload = rest.split(b"\n" + delimiter + b"\n", 1)[0]
    return payload


assert m["taskId"] == "tk_34o1KVuzwy5Z" and m["contractRev"] == 1
assert m["repository"] == "https://github.com/sueelly/IAMCEO.git"
assert m["remoteObservation"].split() == [m["reviewTarget"], "refs/heads/" + m["branch"]]
assert git("cat-file", "-t", m["reviewTarget"]).strip() == b"commit"
assert git("rev-parse", m["reviewTarget"] + "^").decode().strip() == m["initialEvidenceCommit"]
assert not git("diff", "--name-only", m["sourceBase"], m["reviewTarget"], "--", "server", "shared", "tests", "bin", "scripts", "package.json")
assert len(m["originalFiles"]) == 9
for item in m["originalFiles"]:
    original = git("show", m["reviewTarget"] + ":" + item["path"])
    got = exported("original:" + item["path"])
    if item["endsWithNewline"]:
        got += b"\n"
    assert got == original and len(original) == item["bytes"]
    assert digest(got) == item["sha256"]
    assert git("rev-parse", m["reviewTarget"] + ":" + item["path"]).decode().strip() == item["gitBlob"]
for item in m["sourceExcerpts"]:
    whole = git("show", m["sourceBase"] + ":" + item["path"])
    original = b"".join(whole.splitlines(keepends=True)[item["startLine"] - 1:item["endLine"]])
    marker = f"{item['path']}:{item['startLine']}-{item['endLine']}"
    got = exported("excerpt:" + marker) + b"\n"
    assert got == original and digest(got) == item["sha256"]
patch = (HERE / "original.patch").read_bytes()
expected = git("diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", m["sourceBase"], m["reviewTarget"], "--", "docs/diagnostics/review-tool-policy/")
assert patch == expected and digest(patch) == m["patch"]["sha256"] and len(patch) == m["patch"]["bytes"]
wrapper = (HERE / "changes.md").read_bytes().split(b"~~~~~~diff\n", 1)[1].rsplit(b"~~~~~~\n", 1)[0]
assert wrapper == patch
report_raw = (HERE / "external-report.json").read_bytes()
report = json.loads(report_raw)
assert digest(report_raw) == m["externalReport"]["sha256"] and report_raw in snapshot
assert report["sourceMessageId"] == "msg_joLOlvnUy3GJ"
assert report["source"]["who"] == "Novel of the world 총괄"
assert report["source"]["taskId"] == m["taskId"]
assert "MCP tool call requires approval, but approval policy is never" in report["source"]["body"]
assert "06:55:53과 06:57:04" in report["source"]["body"]
for artifact in ("snapshot.md", "changes.md"):
    assert (HERE / artifact).stat().st_size < 2_000_000
for artifact in ("manifest.json", "build-handoff.py", "verify-handoff.py"):
    assert exported("supplement:" + artifact) + b"\n" == (HERE / artifact).read_bytes()
print("PASS: original IAMCEO commit/parent, remote observation, 9 exact file snapshots and 8 fixed source excerpts")
print("PASS: unabridged patch bytes/hash, original saved execution records and attributed external report")
print("PASS: product sources unchanged; no old fixture, live policy or reviewer verdict executed")
