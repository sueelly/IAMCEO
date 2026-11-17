"""Test-source inventory and old failure mapping only; never reads an operational database."""
import argparse
import json
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--old-log", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--baseline", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
files = sorted(p for p in subprocess.check_output(["rg", "--files", "tests"], cwd=root, text=True).splitlines()
               if p.endswith((".test.ts", ".spec.ts", ".browser.ts")))
candidate_files = list(files)
baseline_files = sorted(p for p in subprocess.check_output(["rg", "--files", "tests"], cwd=args.baseline, text=True).splitlines()
                        if p.endswith((".test.ts", ".spec.ts", ".browser.ts"))) if args.baseline else list(files)
files = sorted(set(files) | set(baseline_files))
wrapper = "tests/browser.test.ts"
wrapper_text = (root / wrapper).read_text()
wrapped = {"화면 시험 > " + name: "tests/" + file for name, file in re.findall(
    r'test\("([^\"]+)",\s*\(\)\s*=>\s*runFile\("([^\"]+)"\)', wrapper_text)}
names = []
for line in args.old_log.read_text().splitlines():
    if line.startswith("(fail) "):
        name = re.sub(r" \[[0-9.]+ms\]$", "", line[7:])
        if name not in names:
            names.append(name)

def source(name):
    if name in wrapped:
        return wrapper, wrapped[name]
    for prefix, file in [
        ("approved ", "queue-approval-integration.test.ts"),
        ("approval release ", "queue-approval-integration.test.ts"),
        ("latest snapshot ", "latest-main-integration.test.ts"),
        ("server staging root ", "clone-security.test.ts"),
        ("herdr RPC failure effects >", "herdr-contract.test.ts"),
        ("home ownership:", "home-owner.test.ts"),
        ("atomic config >", "config-atomic.test.ts"),
        ("전 과정(", "e2e-fake.browser.ts"),
        ("컴파일 실행 파일 >", "e2e-fake.browser.ts"),
        ("전체 통합 >", "integrated.browser.ts"),
        ("입력칸 >", "screens-regress.browser.ts"),
        ("팀 화면 >", "screens-regress.browser.ts"),
        ("core 실행 환경·설정 화면 >", "screens-regress.browser.ts"),
        ("서버 강제 종료 >", "screens-regress.browser.ts"),
        ("2차 검수 회귀 >", "screens-regress.browser.ts"),
        ("연결 게이트 >", "screens-regress.browser.ts"),
        ("아티팩트 격리:", "artifact.browser.ts"),
        ("스크립트 없는 칸:", "artifact.browser.ts"),
        ("웹 작업별 대화 >", "task-threads.browser.ts"),
        ("탭 >", "home.browser.ts"),
        ("칸 >", "home.browser.ts"),
        ("악성 아티팩트:", "files.browser.ts"),
    ]:
        if name.startswith(prefix):
            return "tests/" + file, None
    return None, None

mapped = [{"name": name, "file": source(name)[0], "duplicateWrapperFor": source(name)[1]} for name in names]
priority = {row["file"] for row in mapped if row["file"] != wrapper}
payload = {"files": files, "leafFiles": sorted((p for p in files if p != wrapper), key=lambda p: (p not in priority, p)),
           "candidateFiles": candidate_files, "baselineFiles": baseline_files,
           "wrappers": [{"file": wrapper, "leaves": sorted(set(wrapped.values()))}],
           "oldFailureNames": mapped, "oldFailureCount": len(mapped),
           "unmapped": [row for row in mapped if not row["file"] or row["file"] not in files]}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"files": len(files), "leafFiles": len(payload["leafFiles"]), "wrapperFiles": 1,
                  "oldFailureCount": len(mapped), "unmapped": payload["unmapped"]}, ensure_ascii=False))
raise SystemExit(1 if payload["unmapped"] else 0)
