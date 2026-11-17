"""Retire one explicitly authorized helper after verified review and handoff.

Run once per scheduler tick. Configuration and ledger live in a private runtime
directory. This program never completes tasks, answers approvals, resends input,
or uses the generic force-close route.
"""
import argparse
from collections import Counter
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.request


def standalone_marker(body, expected):
    fenced = False
    for line in body.splitlines():
        line = line.strip()
        if line.startswith(('```', '~~~')):
            fenced = not fenced
        elif not fenced and line == expected:
            return True
    return False


def retirement_blockers(config, ledger, state, reports):
    blocked = []
    for key in ('projectId', 'memberId', 'taskId'):
        if ledger.get(key) != config.get(key):
            blocked.append('ledger_identity')
    if state.get('project', {}).get('id') != config['projectId']:
        blocked.append('project_identity')
    expected = config.get('backlogTaskIds', [])
    reviews = ledger.get('reviews', [])
    if (not expected or len(expected) != len(set(expected)) or
            Counter(r.get('backlogTaskId') for r in reviews) != Counter(expected) or
            len({r.get('reviewTaskId') for r in reviews}) != len(reviews)):
        blocked.append('backlog_coverage')
    tasks = {t['id']: t for t in state.get('tasks', [])}
    # The fixed initial list cannot hide later fixes/retests created beneath it.
    for tid, task in tasks.items():
        seen = set()
        parent = task.get('parentTaskId')
        while parent and parent != config['taskId'] and parent not in seen:
            seen.add(parent)
            parent = tasks.get(parent, {}).get('parentTaskId')
        if parent == config['taskId'] and task.get('progress', {}).get('stage') != 'done':
            blocked.append('scope_task_not_done:' + tid)
    for review in reviews:
        tid = review.get('reviewTaskId')
        task = tasks.get(tid, {})
        if task.get('progress', {}).get('stage') != 'done':
            blocked.append('review_not_done:' + str(tid))
        seen = set()
        parent = task.get('parentTaskId')
        while parent and parent != config['taskId'] and parent not in seen:
            seen.add(parent)
            parent = tasks.get(parent, {}).get('parentTaskId')
        if parent != config['taskId']:
            blocked.append('review_outside_scope:' + str(tid))
    members = {m['id']: m for m in state.get('members', [])}
    helper = members.get(config['memberId'], {})
    primary = members.get(config['primaryMemberId'], {})
    if (not primary or primary.get('kind') != 'conductor' or
            config['memberId'] == config['primaryMemberId']):
        blocked.append('primary_identity')
    if helper.get('kind') != 'conductor':
        blocked.append('helper_identity')
    if helper.get('status') not in ('idle', 'waiting'):
        blocked.append('helper_not_idle')
    if helper.get('queuedCount', 0):
        blocked.append('pending_input')
    run = helper.get('executionState') or {}
    if run.get('phase') not in (None, 'ended', 'interrupted'):
        blocked.append('active_execution')
    if any(d.get('memberId') == config['memberId'] and d.get('status') == 'open'
           for d in state.get('decisions', [])):
        blocked.append('open_decision')
    for notice in state.get('deliveryNotices', {}).get('members', []):
        if notice.get('memberId') == config['memberId'] and any(
                notice.get(k, 0) for k in ('undeliveredCount', 'unknownCount',
                                         'deliveringCount', 'checkingCount', 'needsOwnerCount')):
            blocked.append('unsettled_delivery')
    for report_key, author, marker, error in (
            ('finalReportId', config['memberId'], 'TEMP_REVIEW_DRAINED:', 'final_report_missing'),
            ('primaryAckReportId', config['primaryMemberId'],
             'TEMP_REVIEW_HANDOFF_ACCEPTED:', 'primary_ack_missing')):
        report = reports.get(ledger.get(report_key), {})
        if (report.get('projectId') != config['projectId'] or
                report.get('memberId') != author or report.get('taskId') != config['taskId'] or
                report.get('mine') is not False or
                not standalone_marker(report.get('body', ''), marker + config['taskId'])):
            blocked.append(error)
    final = reports.get(ledger.get('finalReportId'), {})
    ack = reports.get(ledger.get('primaryAckReportId'), {})
    try:
        bound = (ack.get('aboutMessageId') == ledger.get('finalReportId') and
                 datetime.fromisoformat(ack['at']) >= datetime.fromisoformat(final['at']))
    except (KeyError, TypeError, ValueError):
        bound = False
    if not bound:
        blocked.append('handoff_ack_unbound')
    return list(dict.fromkeys(blocked))


def save_private(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as out:
        os.fchmod(out.fileno(), 0o600)
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.flush()
        os.fsync(out.fileno())
        temp = out.name
    os.replace(temp, path)


def run_once(config_path):
    config_path = Path(config_path).resolve()
    config = json.loads(config_path.read_text())
    status_path = config_path.with_name('retirement-status.json')
    status = json.loads(status_path.read_text()) if status_path.exists() else {}
    if status.get('phase') == 'retired':
        return status
    home = Path(config['home'])
    server = json.loads((home / 'config.json').read_text())
    base = 'http://127.0.0.1:' + str(server['port'])

    def api(path, body=None):
        req = urllib.request.Request(base + path,
            headers={'Authorization': 'Bearer ' + server['accessCode'],
                     'Content-Type': 'application/json'},
            data=json.dumps(body).encode() if body is not None else None,
            method='POST' if body is not None else 'GET')
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)

    state = api('/api/projects/' + config['projectId'] + '/state')
    member_ids = {m['id'] for m in state.get('members', [])}
    if status.get('phase') == 'retire_requested':
        # Never replay an ambiguous close. Observe its outcome without mutation.
        if config['memberId'] not in member_ids and config['primaryMemberId'] in member_ids:
            status = {'phase': 'retired', 'memberId': config['memberId']}
            save_private(status_path, status)
        return status
    ledger_path = Path(config['ledgerPath'])
    if not ledger_path.exists():
        status = {'phase': 'waiting', 'blockers': ['review_ledger_missing']}
        save_private(status_path, status)
        return status
    ledger = json.loads(ledger_path.read_text())
    reports = {}
    for key in ('finalReportId', 'primaryAckReportId'):
        mid = ledger.get(key)
        if isinstance(mid, str) and mid and '/' not in mid:
            try:
                reports[mid] = api('/api/messages/' + mid)
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
    blockers = retirement_blockers(config, ledger, state, reports)
    if blockers:
        status = {'phase': 'waiting', 'blockers': blockers}
        save_private(status_path, status)
        return status
    status = {'phase': 'retire_requested', 'memberId': config['memberId']}
    save_private(status_path, status)  # Durable intent before the sole mutation.
    try:
        api('/api/projects/' + config['projectId'] + '/temporary-conductor/' +
            config['memberId'] + '/retire',
            {'sourceMessageId': config['sourceMessageId'], 'taskId': config['taskId']})
    except urllib.error.HTTPError as error:
        if error.code == 409:
            status = {'phase': 'waiting', 'blockers': ['retirement_race_refused']}
            save_private(status_path, status)
            return status
        raise
    after = api('/api/projects/' + config['projectId'] + '/state')
    ids = {m['id'] for m in after.get('members', [])}
    if config['memberId'] not in ids and config['primaryMemberId'] in ids:
        status = {'phase': 'retired', 'memberId': config['memberId']}
        save_private(status_path, status)
    return status


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    lock_path = Path(args.config).resolve().with_name('retirement.lock')
    with lock_path.open('a') as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            result = run_once(args.config)
            print(json.dumps({'phase': result.get('phase'), 'blockers': result.get('blockers', [])}))
        except Exception as error:
            # Exception text may contain server response data; keep logs minimal.
            print(json.dumps({'phase': 'observe_failed', 'errorType': type(error).__name__}))
            raise SystemExit(1)
