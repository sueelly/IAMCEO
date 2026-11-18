"""Export only the immutable diagnostic source/evidence for cross-repository review."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASE = "27ec070c1c83acbe0229c53ddccf278ad15d7965"
INITIAL = "71bc06099d79d5bb834d355940b59d4e68ba969d"
TARGET = "679b10d99da712ff95eef7c6cdaa3437eb30be06"
BRANCH = "docs-diagnose-review-tools-tk_34o1KVuzwy5Z"
PREFIX = "docs/diagnostics/review-tool-policy/"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fence(data, language="text"):
    text = data.decode()
    delimiter = "~" * max(6, max((len(x) + 1 for x in re.findall(r"~+", text)), default=0))
    return delimiter + language + "\n" + text + ("" if text.endswith("\n") else "\n") + delimiter + "\n"


paths = git("ls-tree", "-r", "--name-only", TARGET, "--", PREFIX).decode().splitlines()
assert len(paths) == 9
patch = git("diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", BASE, TARGET, "--", PREFIX)
assert not git("diff", "--name-only", BASE, TARGET, "--", "server", "shared", "tests", "bin", "scripts", "package.json")
(HERE / "original.patch").write_bytes(patch)
manifest = {
    "taskId": "tk_34o1KVuzwy5Z", "contractRev": 1,
    "repository": "https://github.com/sueelly/IAMCEO.git",
    "branch": BRANCH, "sourceBase": BASE, "initialEvidenceCommit": INITIAL,
    "reviewTarget": TARGET,
    "remoteObservation": git("ls-remote", "--heads", "origin", BRANCH).decode().strip(),
    "patch": {"path": "original.patch", "sha256": sha(patch), "bytes": len(patch)},
    "originalFiles": [], "sourceExcerpts": [],
    "externalReport": {"path": "external-report.json", "sha256": sha((HERE / "external-report.json").read_bytes())},
    "executionScope": "Previously saved synthetic tool outputs/results only; no new synthetic, model, production or reviewer verdict execution",
}
parts = [
    "# Novel 검수 도구 진단의 원본 파일·실행 결과·관련 소스\n\n",
    f"업무 tk_34o1KVuzwy5Z / 계약 r1. 저장소 {manifest['repository']}의 검토 대상 {TARGET}에서 읽은 원문입니다.\n\n",
    f"기준 제품 소스 {BASE}, 최초 합성 근거 커밋 {INITIAL}, 후속 문서 커밋 {TARGET}를 구분합니다. 각 파일의 Git blob과 SHA-256을 함께 제공합니다.\n\n",
    "기존 실행 원자료는 아래 synthetic-codex-results.json의 toolOutputs·toolEvents·errors·호출 수·제한 설정과 synthetic-server-results.json의 역할/사람 결재 결과입니다. 당시 stdout/stderr 전체나 실서비스 원시 실행 기록을 수집한 자료가 아닙니다. CLI 공지 두 건도 생략하지 않았습니다. 이번에는 합성 시험·실제 모델·운영 호출·지정 검수 판정을 다시 실행하지 않았습니다.\n\n",
    "## 총괄의 실서비스 관측 보고 원문\n\n",
    "post(report_id=msg_joLOlvnUy3GJ)로 다시 조회해 필요한 필드만 보존했습니다. 총괄의 실제 터미널 관측 보고이며 이 직원의 직접 터미널 관측으로 바꾸지 않습니다.\n\n",
    fence((HERE / "external-report.json").read_bytes(), "json"),
    "\n## 검토 대상 커밋의 원본 9개 파일\n\n",
]
for path in paths:
    data = git("show", f"{TARGET}:{path}")
    blob = git("rev-parse", f"{TARGET}:{path}").decode().strip()
    entry = {"path": path, "gitBlob": blob, "sha256": sha(data), "bytes": len(data), "endsWithNewline": data.endswith(b"\n")}
    manifest["originalFiles"].append(entry)
    parts += [f"### {path}\n\nGit blob `{blob}` · SHA-256 `{sha(data)}` · {len(data)} bytes\n\n", f"<!-- original:{path} -->\n", fence(data)]

specs = [
    ("server/runner/role-policy.ts", 12, 37),
    ("server/runner/providers.ts", 74, 89),
    ("bin/mcp-bridge.ts", 88, 113),
    ("server/agent-tools.ts", 465, 482),
    ("server/agent-tools.ts", 932, 953),
    ("server/orchestrator.ts", 4900, 4918),
    ("server/orchestrator.ts", 6360, 6374),
    ("server/orchestrator.ts", 6631, 6649),
]
parts += ["\n## 고정 제품 소스의 관련 경계\n\n", "다음은 전체 운영 소스 덤프가 아니라 최초 진단이 지정한 관련 줄입니다. 각 범위와 전체 파일 Git blob을 고정했습니다. 운영 파일에 적용할 패치가 아닙니다.\n\n"]
for path, start, end in specs:
    full = git("show", f"{BASE}:{path}")
    excerpt = b"".join(full.splitlines(keepends=True)[start - 1:end])
    blob = git("rev-parse", f"{BASE}:{path}").decode().strip()
    entry = {"path": path, "startLine": start, "endLine": end, "gitBlob": blob, "sha256": sha(excerpt), "bytes": len(excerpt)}
    manifest["sourceExcerpts"].append(entry)
    marker = f"{path}:{start}-{end}"
    parts += [f"### {marker}\n\n기준 `{BASE}` · 전체 파일 Git blob `{blob}` · 범위 SHA-256 `{sha(excerpt)}`\n\n", f"<!-- excerpt:{marker} -->\n", fence(excerpt, "typescript")]
(HERE / "changes.md").write_text(
    "# Novel 검수 도구 진단의 전체 변경분\n\n"
    f"저장소 {manifest['repository']} · 기준 {BASE} → 검토 대상 {TARGET}\n\n"
    "아래는 해당 진단 디렉터리의 생략 없는 git diff --binary --full-index 결과입니다. 원본 파일 9개는 모두 문서·합성 fixture·저장된 결과이며 제품 소스 변경은0입니다. 운영에 적용하라는 지시가 아닙니다.\n\n"
    f"패치 SHA-256 `{sha(patch)}` · {len(patch)} bytes. 별도 original.patch와 바이트 단위로 일치합니다.\n\n"
    + fence(patch, "diff"))
(HERE / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
parts += ["\n## 후속 검토 묶음의 목록과 대조 도구\n\n", "아래 파일은 이번에 만든 문서 추출·정합성 확인 도구입니다. 위의 기존 합성 실행 원자료와 구분하며, 운영 소스를 수정하거나 옛 합성 시험을 다시 실행하지 않습니다.\n\n"]
for name in ("manifest.json", "build-handoff.py", "verify-handoff.py"):
    parts += [f"### {name}\n\n", f"<!-- supplement:{name} -->\n", fence((HERE / name).read_bytes())]
(HERE / "snapshot.md").write_text("".join(parts))
print(f"Exported {len(paths)} immutable diagnostic files, {len(specs)} source excerpts, exact patch and existing execution results")
print(f"snapshot_bytes={(HERE / 'snapshot.md').stat().st_size} patch_bytes={len(patch)}")
