"""Manage temporary IAMCEO test data on macOS. Invoked by Bun's test preload."""
import collections
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET

HEADER = "IAMCEO test diagnostics v1"
TTL = 72 * 3600
FAILURE = re.compile(r"failed-[a-z0-9_]{8}\Z")
SKIP = {".git", "node_modules", "uploads", "attachments", "backups", "bin", "sessions", "claude", "codex"}
SQLITE_EXT = {".db", ".sqlite", ".sqlite3"}


def storage():
    parent = Path(os.environ.get("IAMCEO_TEST_RUNS_PARENT", f"/private/tmp/iamceo-tests-{os.getuid()}")).absolute()
    parent.mkdir(mode=0o700, exist_ok=True)
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("test storage must be a private directory owned by this user")
    return parent.resolve()


def new_root(parent):
    root = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    (root / ".owner").write_text(secrets.token_hex(16))
    (root / "tmp").mkdir(mode=0o700)
    return root


def run_token(root):
    try:
        marker = root / ".owner"
        if root.is_symlink() or not re.fullmatch(r"run-[a-z0-9_]{8}", root.name) or not stat.S_ISREG(marker.lstat().st_mode):
            return None
        return marker.read_text()
    except FileNotFoundError:
        return None


def expired(parent):
    for entry in parent.iterdir():
        if not FAILURE.fullmatch(entry.name) or entry.is_symlink() or not entry.is_dir():
            continue
        receipt = entry / "failure.log"
        try:
            info = receipt.lstat()
            if stat.S_ISREG(info.st_mode) and time.time() - info.st_mtime >= TTL:
                with receipt.open("rb") as source:
                    if source.readline(64).rstrip() == HEADER.encode():
                        shutil.rmtree(entry)
        except FileNotFoundError:
            pass  # Another invocation may have expired the same archive.


def valid_xml_reference(match):
    value = match[1]
    number = int(value[1:], 16) if value.startswith("x") else int(value)
    allowed = number in (9, 10, 13) or 32 <= number <= 0xD7FF or 0xE000 <= number <= 0xFFFD or 0x10000 <= number <= 0x10FFFF
    return match[0] if allowed else "�"


def case_results(report):
    cases, errors = {}, []
    try:
        document = ET.parse(report)
    except OSError:
        return cases, errors
    except ET.ParseError:
        # Bun 1.3 emits literal control bytes in otherwise valid test names.
        # These are invalid XML 1.0 even when encoded as character references.
        data = report.read_text(errors="replace")
        data = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]", "�", data)
        data = re.sub(r"&#(x[0-9a-fA-F]+|[0-9]+);", valid_xml_reference, data)
        try:
            document = ET.fromstring(data)
        except ET.ParseError:
            return cases, errors
    for suite in document.iter("testsuite"):
        file = Path(suite.get("file") or suite.get("name") or ".").resolve()
        rows = cases.setdefault(str(file), [])
        for case in suite.iter("testcase"):
            if case.find("skipped") is not None:
                continue
            failure = case.find("failure")
            if failure is None:
                failure = case.find("error")
            line = case.get("line", "")
            rows.append((int(line) if line.isdecimal() else 0, failure is not None))
            if failure is not None:
                errors.append(f"{file.name}: {case.get('name')}\n{failure.get('message') or failure.text or ''}\n")
    return cases, errors


def needed(cases, file, ordinal, line):
    rows = cases.get(file)
    if rows is None:
        # A nested browser runner may have no report in this process, or an
        # import/setup error may have prevented discovery.
        return True
    if ordinal and ordinal <= len(rows):
        return rows[ordinal - 1][1]
    if not rows:
        return True
    prior = [start for start, _ in rows if start and start <= line]
    if not prior:
        return any(failed for _, failed in rows)
    nearest = max(prior)
    return any(failed for start, failed in rows if start == nearest)


def keep_diagnostics(source, destination):
    for path, dirs, files in os.walk(source, followlinks=False):
        directory = Path(path)
        dirs[:] = [d for d in dirs if d not in SKIP and not (directory / d).is_symlink()]
        keep = []
        for name in files:
            f = directory / name
            info = f.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                continue
            db = re.sub(r"-(wal|shm|journal)$", "", name)
            if Path(db).suffix in SQLITE_EXT:
                main = directory / db
                if main.is_symlink() or not main.is_file():
                    continue
                with main.open("rb") as handle:
                    if handle.read(16) != b"SQLite format 3\x00":
                        continue
            elif f.suffix != ".log":
                continue
            keep.append(f)
        # Select all SQLite companions before moving any of them.
        for f in keep:
            dest = destination / f.relative_to(source)
            dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.rename(f, dest)


def finish(root, code, reports, detail=""):
    if code < 0:
        return  # Interrupted invocations have no confirmed completion.
    if code == 0:
        shutil.rmtree(root)
        return
    results, errors = {}, []
    for key, report in reports.items():
        cases, failed = case_results(report)
        results[key] = cases
        errors.extend(failed)
    # A missing/truncated XML report can still be attributed from the runner's
    # ordinary stderr. Completed files should not become failure diagnostics.
    for summary in root.glob(".outcomes-*.json"):
        key = summary.stem.removeprefix(".outcomes-")
        outcomes = json.loads(summary.read_text())
        known = results.setdefault(key, {})
        for file, failed in outcomes.items():
            known.setdefault(file, [(0, value) for value in failed])
    index = root / "fixtures.jsonl"
    archive = Path(tempfile.mkdtemp(prefix=".failed-", dir=root.parent))
    worker_failures = {}
    for capture in root.glob(".worker-*.log"):
        positions = capture.with_suffix(".jsonl")
        boundaries = [json.loads(row) for row in positions.read_text().splitlines()] if positions.exists() else []
        boundaries.insert(0, [0, "", None])
        boundaries.append([capture.stat().st_size, "", None])
        with capture.open("rb") as source:
            for (start, file, ordinal), (end, _, _) in zip(boundaries, boundaries[1:]):
                source.seek(start)
                data = source.read(end - start).decode(errors="replace")
                if re.search(r"^(?:error|[A-Za-z]*Error|panic):|^# Unhandled error", re.sub(r"\x1b\[[0-9;]*m", "", data), re.M):
                    worker_failures.setdefault(file, set()).add(ordinal)
                    errors.append(data[-8192:])
    if index.is_file():
        records = [json.loads(row) for row in index.read_text().splitlines()]
        overlaps = {(row[1], row[2]) for row in records if row[0] == "overlap"}
        for row in records:
            if row[0] != "fixture":
                continue
            _, key, name, file, ordinal, line = row
            if (key, file) in overlaps:
                ordinal, line = None, 0
            if key == "parallel" and worker_failures:
                failed = worker_failures.get(file, set())
                if not failed or (ordinal and 0 not in failed and ordinal not in failed):
                    continue
            if name in (".", "..", "") or Path(name).name != name or not needed(results.get(key, {}), file, ordinal, line):
                continue
            locations = [root / name]
            if not (root / ".closed").is_symlink():
                locations.append(root / ".closed" / name)
            for location in locations:
                if not location.is_symlink() and location.is_dir():
                    keep_diagnostics(location, archive / name)
    console_errors = [p.read_text(errors="replace") for p in root.glob(".errors-*.log") if not p.is_symlink()]
    cause = "\n".join(errors + console_errors) or detail
    (archive / "failure.log").write_text(f"{HEADER}\nBun test exited {code}\n{cause}")
    final = archive.with_name(archive.name[1:])
    archive.rename(final)
    shutil.rmtree(root)
    print(f"IAMCEO test diagnostics (72h): {final}", file=sys.stderr)


def supervise(command):
    nested = os.environ.get("IAMCEO_TEST_RUN_ROOT")
    if nested and os.environ.get("IAMCEO_TEST_RUN_TOKEN") and run_token(Path(nested)) == os.environ["IAMCEO_TEST_RUN_TOKEN"]:
        root = Path(nested)
    else:
        nested = None
        parent = storage()
        expired(parent)
        root = new_root(parent)
    scratch = root / "tmp"
    key = str(os.getpid())
    report = root / f".junit-{key}.xml"
    internal = report
    # Honor externally requested JUnit output while using the same result data.
    for i, arg in enumerate(command):
        if arg == "--reporter-outfile" and i + 1 < len(command):
            report = Path(command[i + 1]).resolve()
            break
        if arg.startswith("--reporter-outfile="):
            report = Path(arg.split("=", 1)[1]).resolve()
            break
    else:
        chosen = [arg.split("=", 1)[1] for arg in command if arg.startswith("--reporter=")]
        chosen += [command[i + 1] for i, arg in enumerate(command[:-1]) if arg == "--reporter"]
        if not chosen or chosen == ["dots"]:
            if chosen:
                command.append("--dots")  # Bun's explicit dots flag coexists with JUnit.
            command.extend(["--reporter=junit", f"--reporter-outfile={report}"])
        # Other explicitly requested reporters keep their own validation/errors.
    # Match Bun's existing server scopes: arm the native parent-death watcher,
    # then strip its exported flag in the preload before providers can inherit it.
    command.insert(command.index("test") + 1, "--no-orphans")
    proc = subprocess.Popen(command, stderr=subprocess.PIPE, env={**os.environ, "TMPDIR": str(scratch), "IAMCEO_TEST_RUN_ROOT": str(root), "IAMCEO_TEST_PARENT_PID": str(os.getpid()), "IAMCEO_TEST_RUN_TOKEN": run_token(root), "IAMCEO_REPORT_ID": key})
    # Some collection/early errors have no JUnit case. Keep a bounded stderr
    # tail for that case while forwarding ordinary output without buffering.
    tail = bytearray()
    console_outcomes = {}
    unknown_case = set()
    def forward():
        current = None
        recent = collections.deque(maxlen=20)
        partial = b""
        with (root / f".errors-{key}.log").open("wb") as errors:
            while True:
                chunk = os.read(proc.stderr.fileno(), 65536)
                if not chunk:
                    break
                sys.stderr.buffer.write(chunk)
                sys.stderr.buffer.flush()
                tail.extend(chunk)
                del tail[:-32768]
                lines = (partial + chunk).split(b"\n")
                partial = lines.pop()[-4096:]
                for line in lines:
                    plain = re.sub(rb"\x1b\[[0-9;]*m", b"", line).decode(errors="replace")
                    if re.fullmatch(r"[^\r\n]+\.[cm]?[jt]sx?:", plain):
                        current = str(Path(plain[:-1]).resolve())
                        console_outcomes.setdefault(current, [])
                    elif re.match(r"^\d+ tests? failed:|^\s*\d+ (?:pass|fail)$", plain):
                        current = None
                    elif current and (plain.startswith("(pass) ") or plain.startswith("(fail) ")):
                        console_outcomes[current].append(plain.startswith("(fail) "))
                    elif current and plain.startswith("# Unhandled error"):
                        unknown_case.add(current)
                    recent.append(line[-2048:])
                    if b"(fail) " in line:
                        errors.write(b"\n".join(recent) + b"\n")
                        recent.clear()
                    elif b"(pass) " in line:
                        recent.clear()
    pump = threading.Thread(target=forward)
    pump.start()
    interrupted = False
    def relay(sig, _frame):
        nonlocal interrupted
        interrupted = True
        proc.send_signal(sig)
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, relay)
    code = proc.wait()
    pump.join()
    if interrupted:
        return 128 + abs(code) if code < 0 else code
    if any(arg in ("--only-failures", "--dots", "--reporter=dots") for arg in command):
        # Suppressed passes leave ordinals ambiguous. Retain the affected file.
        console_outcomes = {file: [any(values)] if values else [] for file, values in console_outcomes.items()}
    for file in unknown_case:
        console_outcomes[file] = [True]
    (root / f".outcomes-{key}.json").write_text(json.dumps(console_outcomes))
    if report != internal and report.is_file():
        shutil.copyfile(report, internal)
    if not nested:
        reports = {p.stem.removeprefix(".junit-"): p for p in root.glob(".junit-*.xml")}
        try:
            finish(root, code, reports, tail.decode(errors="replace"))
        except (OSError, ValueError) as error:
            print(f"Could not finalize IAMCEO test storage at {root}: {error}", file=sys.stderr)
            return code if code > 0 else 1
    return 128 + abs(code) if code < 0 else code


def parallel_root(pid):
    parent = storage()
    # The lock is per coordinator, across simultaneous preload calls. A new
    # random directory per run keeps PID reuse separate from retained data.
    started = subprocess.check_output(["/bin/ps", "-p", str(pid), "-o", "lstart="], text=True).strip()
    generation = int(time.mktime(time.strptime(started, "%a %b %d %H:%M:%S %Y")))
    lockfile = parent / f".worker-{pid}-{generation}"
    with os.fdopen(os.open(lockfile, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "r+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        existing = handle.read()
        if existing:
            root = Path(existing)
            token = run_token(root)
            if root.parent != parent or not token:
                raise ValueError("parallel root ownership changed")
            print(json.dumps([existing, token]))
            return
        expired(parent)
        root = new_root(parent)
        ready, notify = os.pipe()
        if os.fork():
            os.close(notify)
            if os.read(ready, 1) != b"1":
                raise RuntimeError("could not monitor parallel test coordinator")
            os.close(ready)
            handle.write(str(root))
            handle.flush()
            print(json.dumps([str(root), run_token(root)]))
            return
        os.close(ready)
        # A Darwin kqueue is not inherited across fork. Arm the child queue
        # and acknowledge it before workers may load their first fixture.
        q = select.kqueue()
        event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                              fflags=select.KQ_NOTE_EXIT | 0x04000000)
        q.control([event], 0)
        os.write(notify, b"1")
        os.close(notify)
        os.close(0)
        os.close(1)
        os.close(2)
    status = q.control(None, 1)[0].data
    lockfile.unlink(missing_ok=True)
    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
    sys.stderr = open(os.devnull, "w")
    finish(root, code, {}, "Bun parallel coordinator finished.\n")


if __name__ == "__main__":
    if sys.argv[1] == "--worker-root":
        parallel_root(int(sys.argv[2]))
    else:
        sys.exit(supervise(sys.argv[1:]))
