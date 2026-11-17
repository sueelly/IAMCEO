"""Run inventoried test files serially in fresh processes; failures always propagate.

This is test orchestration, not an execution-evidence parser. No live data, models,
employee sessions or operation queues are used. Raw test output stays in ignored files.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import signal
import subprocess
import time
from pathlib import Path

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def parse_counts(text):
    def last(word):
        values = re.findall(r"^\s*(\d+) " + word + r"\s*$", text, re.M)
        return int(values[-1]) if values else None
    passed, failed, skipped = last("pass"), last("fail"), last("skip")
    summary = re.findall(r"^Ran (\d+) tests? across (\d+) files?", text, re.M)
    names = []
    for line in text.splitlines():
        if line.startswith("(fail) "):
            name = re.sub(r" \[[0-9.]+ms\]$", "", line[7:])
            if name not in names:
                names.append(name)
    return {"pass": passed, "fail": failed, "skip": skipped or 0,
            "summaryComplete": passed is not None and failed is not None and bool(summary),
            "reportedTests": int(summary[-1][0]) if summary else None, "failureNames": names}

def run_unit(runtime, root, file, log, timeout, runtime_bin):
    argv = [runtime, "test", "./" + file]
    # Keep the actual user's browser cache, but inherit no operation/provider credentials.
    env = {k: os.environ[k] for k in ["HOME", "PATH", "LANG", "TMPDIR", "DEVELOPER_DIR", "PLAYWRIGHT_BROWSERS_PATH"] if k in os.environ}
    env["IAMCEO_TEST"] = "1"
    env["PATH"] = str(runtime_bin) + os.pathsep + env.get("PATH", "")
    started, clock = now(), time.monotonic()
    timed_out = False
    with log.open("wb") as output:
        process = subprocess.Popen(argv, cwd=root, env=env, stdout=output, stderr=output,
                                   start_new_session=True, umask=0o022)
        try:
            while True:
                try:
                    code = process.wait(timeout=min(20, max(0.1, timeout - (time.monotonic() - clock))))
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() - clock >= timeout:
                        timed_out = True
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            code = process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            code = process.wait()
                        break
                    print(json.dumps({"waiting": file, "seconds": round(time.monotonic() - clock)}), flush=True)
        finally:
            # Only this newly created test process group; never discover/stop live sessions.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    counts = parse_counts(log.read_text(errors="replace"))
    status = "timeout" if timed_out else "failed" if code != 0 or (counts["fail"] or 0) else "incomplete" if not counts["summaryComplete"] else "skipped" if counts["skip"] else "passed"
    return {"file": file, "argv": argv, "workdir": str(root), "startedAt": started, "endedAt": now(),
            "seconds": round(time.monotonic() - clock, 3), "exitCode": code, "timedOut": timed_out,
            "status": status, **counts}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--inventory", type=Path, required=True)
    p.add_argument("--baseline", type=Path, required=True)
    p.add_argument("--candidate", type=Path, required=True)
    p.add_argument("--runtime", required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--timeout", type=float, default=330)
    args = p.parse_args()
    inventory = json.loads(args.inventory.read_text())
    units = inventory["leafFiles"]
    if not units or len(units) != len(set(units)) or any(Path(f).is_absolute() or ".." in Path(f).parts for f in units):
        raise ValueError("Test inventory must contain unique relative paths")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "results.json").exists():
        raise ValueError("Use a new output directory; previous observations are immutable")
    roots = {"baseline": args.baseline.resolve(), "candidate": args.candidate.resolve()}
    runtime_bin = output / "runtime-bin"
    runtime_bin.mkdir()
    (runtime_bin / "bun").symlink_to(Path(args.runtime).resolve())
    for root in roots.values():
        (root / "evidence/latest-main-20261117").mkdir(parents=True, exist_ok=True)
    def source_snapshot(root):
        sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True)
        diff = subprocess.run(["git", "diff", "HEAD", "--binary", "--", "server", "shared", "bin", "web/src", "tests", "scripts"], cwd=root, capture_output=True)
        return {"head": sha.stdout.strip() if sha.returncode == 0 else None,
                "sourceDiffSha256": hashlib.sha256(diff.stdout).hexdigest() if diff.returncode == 0 else None}
    result = {"startedAt": now(), "runtime": args.runtime, "environment": {"IAMCEO_TEST": "1", "umask": "022", "credentialInheritance": False, "bunChildRuntimePinned": True},
              "sourceBefore": {phase: source_snapshot(root) for phase, root in roots.items()},
              "inventorySha256": hashlib.sha256(args.inventory.read_bytes()).hexdigest(),
              "duplicateWrappers": inventory.get("wrappers", []), "rows": [], "addedFiles": [], "totals": {}}
    def save():
        result["totals"] = {}
        for phase, root in roots.items():
            expected = list(units) if phase == "candidate" else [f for f in units if (root / f).is_file()]
            rows = [r for r in result["rows"] if r["phase"] == phase]
            result["totals"][phase] = {"expectedFiles": len(expected), "executedFiles": len(rows), "unexecutedFiles": len(expected) - len(rows),
                **{key + "Files": sum(r["status"] == key for r in rows) for key in ["passed", "failed", "incomplete", "skipped", "timeout"]},
                "passedTests": sum(r["pass"] or 0 for r in rows), "failedTests": sum(r["fail"] or 0 for r in rows), "skippedTests": sum(r["skip"] for r in rows)}
        (output / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    save()
    for i, file in enumerate(units):
        for phase, root in roots.items():
            if not (root / file).is_file():
                result["addedFiles"].append({"phase": phase, "file": file, "status": "missing_input" if phase == "candidate" else "absent_in_baseline_revision"})
                save()
                continue
            row = run_unit(args.runtime, root, file, output / f"{i:03}-{phase}.txt", args.timeout, runtime_bin)
            row["phase"] = phase
            result["rows"].append(row)
            save()
            print(json.dumps({k: row[k] for k in ["phase", "file", "exitCode", "status", "pass", "fail", "skip"]}, ensure_ascii=False), flush=True)
    result["endedAt"] = now()
    result["sourceAfter"] = {phase: source_snapshot(root) for phase, root in roots.items()}
    result["sourceUnchanged"] = result["sourceBefore"] == result["sourceAfter"]
    save()
    print(json.dumps({"totals": result["totals"], "duplicateWrapperFiles": len(result["duplicateWrappers"])}, ensure_ascii=False), flush=True)
    return 0 if result["sourceUnchanged"] and all(r["status"] == "passed" for r in result["rows"]) and all(t["unexecutedFiles"] == 0 for t in result["totals"].values()) else 1

if __name__ == "__main__":
    raise SystemExit(main())
