#!/usr/bin/env python3
"""Condition-driven same-thread resume. Monitoring never freezes or activates a service."""
import argparse
from contextlib import contextmanager
import copy
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import sqlite3
import socket
import ssl
import tarfile
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mac_mini_migration import private_json, digest

TERMINAL = {'turn.completed', 'turn.failed'}
QUEUED = {'queued', 'sending', 'delivering'}
QUIET = {'idle', 'offline', 'asleep'}
RECEIPTS = ['CUTOVER_READY.json', 'SOURCE_EXPORT_STATUS.json', 'DOMAIN-PREFERENCE.json',
            'DNS_READY.json', 'ACCESS_READY.json', 'TARGET_PRECUTOVER_VALIDATED.json',
            'SOURCE_FROZEN.json', 'SESSION_QUEUE_FIX_AVAILABLE.json']
REQUIRED_TARGET = ['server', 'data_restore', 'cli_auth', 'domain', 'baseline_services',
                   'source_compatibility', 'required_regression']


def now_iso(): return datetime.now(timezone.utc).isoformat()
def key(value): return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
def read_json(path): return json.loads(Path(path).read_text())


def private_config(path):
    p = Path(path); st = p.lstat()
    if not p.is_file() or p.is_symlink() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise ValueError('Configuration must be an owned 0600 regular file')
    cfg = read_json(p)
    if not re.fullmatch(r'[a-fA-F0-9-]{36}', cfg['thread_id']): raise ValueError('Explicit session UUID required')
    for name in ['root', 'state_dir', 'cwd']:
        if not Path(cfg[name]).is_absolute(): raise ValueError('Absolute private paths required')
    if cfg.get('test_mode') and (not cfg.get('resume_command') or not cfg.get('observation_file') or Path(cfg['resume_command'][0]).name == 'codex'):
        raise ValueError('A fake executable and fixture observation are required in test mode')
    if not cfg.get('test_mode'):
        job = cfg['initial_job']
        if job.get('thread_id') != cfg['thread_id']: raise ValueError('Owner session mismatch')
        with Path(job['events']).open('rb') as events:
            first = events.readline(8192)
        if json.loads(first).get('thread_id') != cfg['thread_id']: raise ValueError('Session event identity mismatch')
    return cfg


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise ValueError('Redirect refused')


class API:
    def __init__(self, url, credential_file):
        if urllib.parse.urlsplit(url).scheme != 'https': raise ValueError('Source HTTPS required')
        self.url = url.rstrip('/'); self.credential_file = credential_file
        self.opener = urllib.request.build_opener(NoRedirect())
    def request(self, method, path, body=None):
        if method not in {'GET', 'PATCH'} or not path.startswith('/api/'): raise ValueError('Unsupported source operation')
        if method == 'PATCH' and (not re.fullmatch(r'/api/projects/[^/?#]+', path) or not isinstance(body, dict) or set(body) != {'runnerEnabled'} or type(body['runnerEnabled']) is not bool):
            raise ValueError('Only runner flag PATCH is supported')
        code = read_json(self.credential_file)['accessCode']
        req = urllib.request.Request(self.url + path, method=method,
            headers={'Authorization': 'Bearer ' + code, 'Content-Type': 'application/json'},
            data=None if body is None else json.dumps(body).encode())
        try:
            with self.opener.open(req, timeout=20) as response:
                data = response.read(64 * 1024 * 1024 + 1)
                if len(data) > 64 * 1024 * 1024: raise ValueError('API response limit exceeded')
                return json.loads(data)
        except urllib.error.HTTPError as error:
            status = error.code; error.close()
            raise RuntimeError('Source API HTTP ' + str(status)) from None


def observe_source(api, project_ids, policy_ids):
    bootstrap = api.request('GET', '/api/bootstrap')
    ids = sorted(p['id'] for p in bootstrap['projects'])
    blockers = []
    if ids != sorted(project_ids): blockers.append('registered_projects_changed')
    projects = []; queue = []; open_decisions = []; members = []
    flags = {}; policies = {}
    for project in project_ids:
        safe = urllib.parse.quote(project, safe='')
        state = api.request('GET', '/api/projects/' + safe + '/state')
        flags[project] = state['project']['runnerEnabled']
        if type(flags[project]) is not bool: raise ValueError('Unknown runner flag')
        current = [{'id': m['id'], 'status': m['status']} for m in state['members']]
        members.extend(current)
        if any(m['status'] not in QUIET for m in current): blockers.append('source_work_in_progress')
        open_decisions += [d['id'] for d in state['decisions'] if d['status'] in {'open', 'answered'}]
        cursor = None; seen = set(); page_count = 0
        while True:
            query = {'limit': 500}
            if cursor: query['cursor'] = cursor
            page = api.request('GET', '/api/projects/' + safe + '/messages/page?' + urllib.parse.urlencode(query))
            page_count += 1
            if page_count > 10000: raise ValueError('Message pagination did not finish')
            for m in page['items']:
                if m['delivery'] in QUEUED: queue.append({'id': m['id'], 'delivery': m['delivery']})
            if not page['hasOlder']: break
            cursor = page['nextCursor']
            if not cursor or cursor in seen: raise ValueError('Invalid message pagination')
            seen.add(cursor)
        projects.append({'id': project, 'member_states': {state: sum(m['status'] == state for m in current)
                         for state in sorted({m['status'] for m in current})}})
    if queue: blockers.append('queued_source_messages')
    if open_decisions: blockers.append('open_source_decisions')
    for message_id in policy_ids:
        message = api.request('GET', '/api/messages/' + urllib.parse.quote(message_id, safe=''))
        policies[message_id] = message['delivery']
    runtime = api.request('GET', '/api/readiness'); schema = runtime.get('schema', {})
    evidence = {'registered': ids, 'flags': flags, 'members': sorted(members, key=lambda x: x['id']),
                'queue': sorted(queue, key=lambda x: x['id']), 'decisions': sorted(open_decisions)}
    return {'reachable': True, 'quiescent': not blockers, 'blockers': sorted(set(blockers)),
            'stability_key': key(evidence), 'runner_flags': flags, 'projects': projects,
            'queued_messages': len(queue), 'open_decisions': len(open_decisions),
            'policy_delivery': policies, 'schema': schema, 'runtime_build_id': runtime.get('daemon', {}).get('buildId')}


def record_observation(state, observation, now, idle_interval):
    source = observation['source']; idle_key = source.get('stability_key')
    if not source.get('reachable') or not source.get('quiescent'):
        state.update(idle_count=0, idle_key=None, idle_qualified=False, idle_sample_at=None)
    elif state.get('idle_key') != idle_key:
        state.update(idle_count=1, idle_key=idle_key, idle_qualified=False, idle_sample_at=now)
    elif now - (state.get('idle_sample_at') or now) >= idle_interval:
        state['idle_count'] = min(2, state.get('idle_count', 1) + 1)
        state['idle_sample_at'] = now; state['idle_qualified'] = state['idle_count'] >= 2
    meaningful = {'source_idle_qualified': state.get('idle_qualified', False),
                  'source_reachable': source.get('reachable', False),
                  'source_blockers': source.get('blockers', []),
                  'policy_delivery': source.get('policy_delivery', {}),
                  'source_runtime_build_id': source.get('runtime_build_id'),
                  'conditions': observation['conditions'], 'receipts': observation['receipts']}
    previous = state.get('meaningful'); initialized = previous is None
    state.setdefault('pending', [])
    if not initialized and previous != meaningful:
        state['pending'].append({'id': uuid.uuid4().hex, 'at': now_iso(),
            'changed': sorted(k for k in meaningful if meaningful[k] != previous.get(k)),
            'fingerprint': key(meaningful)})
        # Coalesce without dropping evidence that work is waiting.
        if len(state['pending']) > 100: state['pending'] = state['pending'][-100:]
    state['meaningful'] = meaningful; state['observation'] = observation; state['observed_at'] = now
    return initialized


def process_identity(pid):
    r = subprocess.run(['ps', '-p', str(pid), '-o', 'state=,lstart=,comm='], capture_output=True, text=True)
    if r.returncode or not r.stdout.strip(): return None
    state, identity = r.stdout.strip().split(None, 1)
    return None if state.startswith('Z') else identity


def terminal_event(path):
    try:
        with Path(path).open('rb') as stream:
            stream.seek(max(0, Path(path).stat().st_size - 512 * 1024)); raw = stream.read()
        last = None
        for line in raw.splitlines():
            try: event = json.loads(line)
            except (ValueError, UnicodeDecodeError): continue
            if event.get('type') in TERMINAL | {'turn.started'}: last = event['type']
        return last
    except FileNotFoundError: return None


def job_finished(job):
    if not job: return False
    identity = process_identity(job['pid'])
    if identity is not None and identity == job.get('identity'): return False
    return terminal_event(job['events']) in TERMINAL


def session_processes(thread_id):
    result = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True, check=True)
    matching = []
    for line in result.stdout.splitlines():
        try:
            pid, command = line.strip().split(None, 1); args = shlex.split(command)
            if args and Path(args[0]).name == 'codex' and 'resume' in args and thread_id in args:
                matching.append(int(pid))
        except ValueError: continue
    return matching


class Supervisor:
    def __init__(self, cfg):
        self.cfg = cfg; self.directory = Path(cfg['state_dir']); self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700); self.state_path = self.directory / 'state.json'; self.child = None
    def load(self): return read_json(self.state_path) if self.state_path.exists() else {}
    def reap(self):
        if self.child and self.child.poll() is not None: self.child.wait(); self.child = None
    def acknowledge(self, fingerprint, owner_pid):
        """A live resumed owner may mark reviewed observations handled, never unseen changes."""
        with (self.directory / '.dispatch.lock').open('a') as lock:
            os.chmod(lock.name, 0o600); fcntl.flock(lock, fcntl.LOCK_EX)
            state = self.load(); job = state.get('active_job', {})
            identity = process_identity(owner_pid)
            if identity is None or job.get('pid') != owner_pid or identity != job.get('identity'):
                raise ValueError('Only the existing live session owner may acknowledge observations')
            if not state.get('meaningful') or key(state['meaningful']) != fingerprint:
                raise ValueError('Conditions changed since review; inspect the latest observation')
            state['last_handled'] = {'at': now_iso(), 'fingerprint': fingerprint, 'owner_pid': owner_pid,
                                     'event_ids': [p['id'] for p in state.get('pending', [])]}
            state['pending'] = []
            private_json(self.state_path, state)
            return state['last_handled']
    def tick(self, observation, now=None, dispatch=False):
        now = time.time() if now is None else now
        with (self.directory / '.dispatch.lock').open('a') as lock:
            os.chmod(lock.name, 0o600); fcntl.flock(lock, fcntl.LOCK_EX)
            state = self.load(); initialized = record_observation(state, observation, now, self.cfg['idle_interval_seconds'])
            private_json(self.state_path, state)
            if initialized: return 'initialized'
            if state.get('dispatch', {}).get('status') == 'claimed': return 'uncertain_launch'
            if not dispatch or not state['pending']: return 'unchanged'
            job = state.get('active_job') or self.cfg.get('initial_job')
            if not job_finished(job):
                return 'owner_exit_unconfirmed' if job and process_identity(job['pid']) is None else 'waiting_owner'
            if session_processes(self.cfg['thread_id']): return 'waiting_owner'
            run_id = uuid.uuid4().hex; runs = self.directory / 'runs'; runs.mkdir(exist_ok=True, mode=0o700)
            events = runs / (run_id + '.events.jsonl'); error = runs / (run_id + '.stderr.log')
            pending = state['pending']; state['pending'] = []
            state['dispatch'] = {'id': run_id, 'status': 'claimed', 'event_ids': [p['id'] for p in pending], 'claimed_at': now_iso()}
            private_json(self.state_path, state)
            thread = self.cfg['thread_id']
            command = self.cfg.get('resume_command') if self.cfg.get('test_mode') else None
            if not command:
                command = [self.cfg['codex_bin'], 'exec', '-s', 'danger-full-access', '-c', 'approval_policy="never"',
                    'resume', '--skip-git-repo-check', '--json', '-o', str(runs / (run_id + '.last-message.md')), '{thread_id}', '-']
            command = [arg.replace('{thread_id}', thread) for arg in command]
            prompt = ('같은 IAMCEO 이전 세션의 조건이 바뀌었습니다. 새 작업이나 하위 에이전트를 만들지 마세요. '
                '이전 루트의 PROMPT.md, FOLLOWUP.md, status.json과 감독 state.json의 새 관측을 읽고 남은 승인 범위만 이어가세요. '
                '원본 작업/승인/미전달 큐가 남거나 대상 로그인·접속·복원 검증이 없으면 동결·EXPORT_REQUEST를 쓰지 마세요. '
                '완료한 준비를 반복하지 말고 변경 조건을 확인한 뒤 필요한 일만 수행하세요. '
                '운영 상태와 실패/대기를 정확히 기록하고 조건이 없으면 턴을 종료하세요.\n'
                + json.dumps({'root': self.cfg['root'], 'supervisor_state': str(self.state_path), 'changed': sorted({k for p in pending for k in p['changed']})}, ensure_ascii=False))
            try:
                with events.open('xb') as out, error.open('xb') as err:
                    os.chmod(events, 0o600); os.chmod(error, 0o600)
                    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out, stderr=err,
                        cwd=self.cfg.get('cwd', self.cfg['root']), env={**os.environ, 'PATH': self.cfg.get('path', os.environ.get('PATH', ''))},
                        start_new_session=True)
                self.child = child
                state['active_job'] = {'pid': child.pid, 'identity': process_identity(child.pid), 'events': str(events), 'thread_id': thread}
                state['dispatch'].update(status='running', started_at=now_iso())
                private_json(self.state_path, state)
                child.stdin.write(prompt.encode()); child.stdin.close()
                return 'started'
            except OSError:
                # If a process exists, preserve its claim; never silently repeat an uncertain turn.
                if self.child is not None:
                    state['dispatch']['status'] = 'running_input_unknown'
                    private_json(self.state_path, state); return 'input_unknown'
                state['dispatch']['status'] = 'spawn_failed'
                private_json(self.state_path, state); return 'spawn_failed'


def command_auth(command, kind):
    try:
        r = subprocess.run(command, capture_output=True, text=True, timeout=20)
        if kind == 'claude': return r.returncode == 0 and json.loads(r.stdout).get('loggedIn') is True
        return r.returncode == 0 and 'Logged in' in (r.stdout + r.stderr)
    except (OSError, ValueError, subprocess.TimeoutExpired): return False


def http_probe(url, credential_file=None):
    try:
        headers = {}
        if credential_file: headers['Authorization'] = 'Bearer ' + read_json(credential_file)['accessCode']
        opener = urllib.request.build_opener(NoRedirect())
        with opener.open(urllib.request.Request(url, headers=headers), timeout=5) as response:
            if response.status != 200: return False
            if urllib.parse.urlsplit(url).path in {'/api/health', '/api/readiness'}:
                value = json.loads(response.read(1024 * 1024))
                return isinstance(value, dict) and value.get('ok') is True
            return True
    except (OSError, ValueError) as error:
        if isinstance(error, urllib.error.HTTPError): error.close()
        return False


def baseline_probe(spec):
    if isinstance(spec, str): return http_probe(spec)
    try:
        token = Path(spec['token_file']).read_text().strip()
        req = urllib.request.Request(spec['url'], headers={'Authorization': 'Bearer ' + token})
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=5) as response:
            return response.status == 200
    except (OSError, ValueError, KeyError) as error:
        if isinstance(error, urllib.error.HTTPError): error.close()
        return False


def dns_resolves(origin):
    try: return bool(socket.getaddrinfo(urllib.parse.urlsplit(origin).hostname, 443, type=socket.SOCK_STREAM))
    except OSError: return False


def tls_valid(origin):
    try:
        url = urllib.parse.urlsplit(origin)
        with socket.create_connection((url.hostname, url.port or 443), timeout=4) as stream:
            with ssl.create_default_context().wrap_socket(stream, server_hostname=url.hostname): return True
    except (OSError, ValueError) as error:
        if isinstance(error, urllib.error.HTTPError): error.close()
        return False


def application_ready(url, credential_file, expected_build, require_read_only=False):
    if not expected_build: return False
    try:
        req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + read_json(credential_file)['accessCode']})
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=5) as response:
            value = json.loads(response.read(1024 * 1024))
            return response.status == 200 and value.get('ok') is True and value.get('daemon', {}).get('ready') is True and value['daemon']['buildId'] == expected_build and (not require_read_only or value['daemon'].get('readOnly') is True)
    except (OSError, ValueError, KeyError) as error:
        if isinstance(error, urllib.error.HTTPError): error.close()
        return False


def receipt_keys(root):
    result = {}
    for name in RECEIPTS:
        path = root / name
        if not path.exists(): result[name] = None; continue
        try:
            value = read_json(path)
            if name == 'SOURCE_EXPORT_STATUS.json':
                value = {k: value.get(k) for k in ['phase', 'request_id', 'cutover_ready', 'blockers', 'error_type']}
            result[name] = key(value)
        except (OSError, ValueError): result[name] = 'invalid_json'
    return result


def access_mode(preference):
    modes = {'public', 'tailscale_only'}
    explicit = preference.get('mode')
    if 'access_scope' in preference:
        canonical = {'tailnet_only': 'tailscale_only', 'public_internet': 'public'}.get(preference['access_scope'])
        if canonical is None or (explicit is not None and explicit != canonical):
            raise ValueError('Unrecognized or conflicting access preference')
        return canonical
    if explicit not in modes: raise ValueError('Unrecognized access preference')
    return explicit


def collect(cfg):
    if cfg.get('test_mode') and cfg.get('observation_file'): return read_json(cfg['observation_file'])
    root = Path(cfg['root']); api = API(cfg['source_url'], cfg['source_credential_file'])
    try: source = observe_source(api, cfg['project_ids'], cfg.get('policy_message_ids', []))
    except Exception as error: source = {'reachable': False, 'quiescent': False, 'blockers': ['source_unavailable'], 'error_type': type(error).__name__}
    try: preference = read_json(root / 'DOMAIN-PREFERENCE.json') if (root / 'DOMAIN-PREFERENCE.json').exists() else {'mode': 'public', 'assumed': True}
    except (OSError, ValueError): preference = {'mode': 'unrecognized', 'invalid': True}
    try: mode = access_mode(preference)
    except ValueError: mode = 'unrecognized'
    public = cfg.get('public_origin')
    try: release = read_json(cfg['release_manifest'])
    except (OSError, ValueError): release = {}
    domain = http_probe(public + '/api/health') if mode == 'public' and public else False
    if domain: domain = application_ready(public + '/api/readiness', cfg['source_credential_file'], release.get('build_id'))
    if mode == 'tailscale_only' and cfg.get('tailscale_origin'):
        domain = application_ready(cfg['tailscale_origin'] + '/api/readiness', cfg['source_credential_file'], release.get('build_id'))
    viewing_ready = False
    if mode == 'tailscale_only' and cfg.get('tailscale_origin') and cfg.get('viewing_release_manifest'):
        try:
            viewing = read_json(cfg['viewing_release_manifest'])
            if viewing.get('kind') == 'read-only-snapshot-view' and viewing.get('operational_cutover') is False:
                viewing_ready = application_ready(cfg['tailscale_origin'] + '/api/readiness', cfg['source_credential_file'], viewing.get('build_id'), require_read_only=True)
        except (OSError, ValueError): pass
    conditions = {'claude_authenticated': command_auth([cfg['claude_bin'], 'auth', 'status', '--json'], 'claude'),
                  'codex_authenticated': command_auth([cfg['codex_bin'], 'login', 'status'], 'codex'),
                  'domain_mode': mode, 'domain_ready': domain,
                  'initial_viewing_ready': viewing_ready,
                  'access_origin': cfg.get('tailscale_origin') if mode == 'tailscale_only' else public if mode == 'public' else None,
                  'baseline_services': {name: baseline_probe(spec) for name, spec in cfg.get('baseline_health', {}).items()},
                  'public_dns_resolves': dns_resolves(public) if mode == 'public' and public else None,
                  'public_tls_valid': tls_valid(public) if mode == 'public' and public else None,
                  'ingress_credentials_available': (Path(cfg['ingress_credential_file']).is_file() if cfg.get('ingress_credential_file') else False) if mode == 'public' else None,
                  'gui_session_available': subprocess.run(['launchctl', 'print', 'gui/' + str(os.getuid())], capture_output=True, timeout=5).returncode == 0,
                  'docker_socket_available': Path(cfg['docker_socket']).is_socket() if cfg.get('docker_socket') else False,
                  'target_server': http_probe(cfg['target_health']),
                  'target_authenticated_readiness': application_ready(cfg['target_readiness'], cfg['source_credential_file'], release.get('build_id'))}
    result = {'at': now_iso(), 'source': source, 'conditions': conditions, 'receipts': receipt_keys(root)}
    result['conditions']['target_prepared'] = target_prepared(cfg, result)
    return result


def target_prepared(cfg, observation):
    path = Path(cfg['root']) / 'TARGET_PRECUTOVER_VALIDATED.json'
    if not path.exists(): return False
    try:
        receipt = read_json(path); checks = receipt['checks']; conditions = observation['conditions']
        if receipt.get('kind') != 'target-precutover-validation' or receipt.get('verified') is not True: return False
        if not all(checks.get(k, {}).get('passed') is True for k in REQUIRED_TARGET): return False
        if not all(conditions.get(k) is True for k in ['claude_authenticated', 'codex_authenticated', 'domain_ready', 'target_server', 'target_authenticated_readiness']): return False
        if not conditions.get('baseline_services') or not all(conditions['baseline_services'].values()): return False
        release = read_json(cfg['release_manifest'])
        if not release.get('production_eligible') or release['source_sha'] != receipt['source_sha']: return False
        if digest(Path(cfg['release_manifest']).parent / 'iamceo') != release['binary_sha256']: return False
        if receipt['supported_schema'] != release['supported_schema'] or receipt['supported_schema'] < observation['source']['schema']['version']: return False
        if not observation['source'].get('runtime_build_id') or receipt.get('source_runtime_build_id') != observation['source']['runtime_build_id']: return False
        # Every named proof is an existing receipt, not an unchecked boolean.
        for check in checks.values():
            if digest(check['evidence_file']) != check['evidence_sha256']: return False
        return True
    except (OSError, ValueError, KeyError, TypeError): return False


def _rollback_source(cfg, api, receipt):
    root = Path(cfg['root']); activated = root / 'TARGET_ACTIVATED.json'
    if activated.exists() and read_json(activated).get('activated') is True: raise ValueError('Active target prohibits source rollback')
    if (root / 'CUTOVER_APPLIED.json').exists(): raise ValueError('Cutover applied; inspect execution ownership first')
    if not cfg.get('test_mode') and http_probe(cfg.get('production_readiness', cfg['target_readiness']), cfg['source_credential_file']):
        raise ValueError('A running target must be proved inactive before rollback')
    if (root / 'EXPORT_REQUEST.json').exists():
        (root / 'EXPORT_REQUEST.json').rename(root / ('EXPORT_REQUEST.cancelled-' + uuid.uuid4().hex + '.json'))
    receipt['phase'] = 'rolling_back'; private_json(root / 'SOURCE_FROZEN.json', receipt)
    failures = []
    for project in reversed(receipt['changed']):
        try:
            api.request('PATCH', '/api/projects/' + urllib.parse.quote(project, safe=''),
                        {'runnerEnabled': receipt['original_runner_enabled'][project]})
            state = api.request('GET', '/api/projects/' + urllib.parse.quote(project, safe='') + '/state')
            if state['project']['runnerEnabled'] != receipt['original_runner_enabled'][project]: raise ValueError('Rollback flag mismatch')
        except Exception: failures.append(project)
    receipt.update(phase='rollback_failed' if failures else 'rolled_back', rollback_at=now_iso(), rollback_failed_projects=failures)
    private_json(root / 'SOURCE_FROZEN.json', receipt)
    if failures: raise RuntimeError('Source rollback requires inspection')


def _freeze_source(cfg, api, stable, target_ready):
    root = Path(cfg['root']); request_path = root / 'EXPORT_REQUEST.json'; freeze_path = root / 'SOURCE_FROZEN.json'
    if request_path.exists():
        request = read_json(request_path); receipt = read_json(freeze_path)
        if receipt.get('phase') == 'frozen' and request.get('request_id') == receipt.get('request_id'): return request
        raise ValueError('Existing export request must be inspected')
    if not target_ready: raise ValueError('Target is not prepared; no source write allowed')
    if not stable.get('idle_qualified') or time.time() - (stable.get('idle_sample_at') or 0) > max(300, cfg['poll_seconds'] * 2):
        raise ValueError('Two recent spaced idle observations required')
    before = observe_source(api, cfg['project_ids'], cfg.get('policy_message_ids', []))
    if not before['quiescent'] or before['stability_key'] != stable.get('idle_key'): raise ValueError('Source changed since idle qualification')
    request_id = 'final-' + datetime.now().strftime('%Y%m%d-') + uuid.uuid4().hex
    receipt = {'phase': 'freezing', 'request_id': request_id, 'at': now_iso(),
               'original_runner_enabled': before['runner_flags'], 'before': before, 'changed': [], 'responses': []}
    private_json(freeze_path, receipt)
    try:
        for project in cfg['project_ids']:
            current = observe_source(api, cfg['project_ids'], cfg.get('policy_message_ids', []))
            if not current['quiescent']: raise ValueError('Source became busy before PATCH')
            if not before['runner_flags'][project]: continue
            # Track attempts before the call so timeout with an unknown effect is rolled back too.
            receipt['changed'].append(project); private_json(freeze_path, receipt)
            response = api.request('PATCH', '/api/projects/' + urllib.parse.quote(project, safe=''), {'runnerEnabled': False})
            receipt['responses'].append({'project_id': project, 'at': now_iso(), 'response': response})
            private_json(freeze_path, receipt)
            after = observe_source(api, cfg['project_ids'], cfg.get('policy_message_ids', []))
            if not after['quiescent'] or after['runner_flags'][project] is not False: raise ValueError('Source changed after PATCH')
        final = observe_source(api, cfg['project_ids'], cfg.get('policy_message_ids', []))
        if not final['quiescent'] or any(final['runner_flags'].values()): raise ValueError('Source freeze not confirmed')
        receipt.update(phase='frozen', frozen_at=now_iso(), after=final); private_json(freeze_path, receipt)
        request = {'request_id': request_id, 'source_frozen': True, 'target_prepared': True,
                   'original_runner_enabled': before['runner_flags'], 'source_freeze_receipt': 'SOURCE_FROZEN.json'}
        # Refuse concurrent/old requests; export happens only after the complete freeze receipt.
        temporary = root / ('.EXPORT_REQUEST-' + uuid.uuid4().hex + '.json')
        private_json(temporary, request)
        try:
            os.link(temporary, request_path)
            directory = os.open(root, os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally: temporary.unlink()
        return request
    except Exception:
        _rollback_source(cfg, api, receipt)
        raise


@contextmanager
def freeze_lock(cfg):
    path = Path(cfg['root']) / '.freeze.lock'
    with path.open('a') as lock:
        os.chmod(path, 0o600)
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('Another freeze/rollback operation is active')
        yield


def rollback_source(cfg, api, receipt):
    with freeze_lock(cfg): return _rollback_source(cfg, api, receipt)


def freeze_source(cfg, api, stable, target_ready):
    with freeze_lock(cfg): return _freeze_source(cfg, api, stable, target_ready)


def verify_final(cfg):
    """Verify the final input set offline; do not import refs, restore, serve, or enable runners."""
    root = Path(cfg['root'])
    private_json(root / 'FINAL_INPUT_VERIFIED.json', {'kind': 'final-input-verification', 'at': now_iso(), 'verified': False, 'operational_activation': False})
    request = read_json(root / 'EXPORT_REQUEST.json')
    frozen = read_json(root / 'SOURCE_FROZEN.json'); ready = read_json(root / 'CUTOVER_READY.json')
    identity = request.get('request_id', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', identity): raise ValueError('Invalid final snapshot ID')
    if frozen.get('phase') != 'frozen' or frozen.get('request_id') != identity: raise ValueError('Source freeze is not current')
    if ready.get('kind') != 'final' or ready.get('cutover_allowed') is not True or ready.get('request_id') != identity:
        raise ValueError('Matching final export required; initial data cannot be activated')
    if ready.get('freeze_receipt') != request: raise ValueError('Final export belongs to another freeze')
    incoming = root / 'incoming' / ('final-' + identity)
    if str(incoming) != ready.get('incoming_directory') or incoming.is_symlink(): raise ValueError('Unexpected final input directory')
    required = {'IAMCEO.bundle', 'god.bundle', 'iamceo.db', 'iamceo-runtime.tar.gz', 'god-files.tar.gz', 'worktree-wip.tar.gz', 'worktree-wip.json'}
    if not required.issubset(ready['files']): raise ValueError('Final refs or private WIP missing')
    for name, expected in ready['files'].items():
        if PurePosixPath(name).name != name: raise ValueError('Invalid final filename')
        path = incoming / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != expected['bytes'] or digest(path) != expected['sha256']:
            raise ValueError('Final file digest mismatch')
    release = read_json(cfg['release_manifest']); supported = release['supported_schema']
    db = sqlite3.connect('file:' + urllib.parse.quote(str(incoming / 'iamceo.db')) + '?immutable=1', uri=True)
    try:
        version = db.execute('PRAGMA user_version').fetchone()[0]
        frozen_schema = frozen.get('before', {}).get('schema', {}).get('version')
        if version < 1 or version != ready['db_user_version'] or version != frozen_schema or version > supported:
            raise ValueError('Final schema differs from source freeze or selected release')
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or db.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('Final database integrity/FK failure')
        tables = ['projects', 'members', 'messages', 'tasks', 'decisions', 'files', 'attachments']
        counts = {table: db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in tables}
        if counts != ready['db_counts']: raise ValueError('Final database count mismatch')
        projects = db.execute('SELECT id,runner_enabled FROM projects WHERE archived=0').fetchall()
        if {p[0] for p in projects} != set(cfg['project_ids']) or any(p[1] for p in projects): raise ValueError('Final registered projects not frozen')
        if db.execute("SELECT 1 FROM messages WHERE delivery IN ('queued','sending','delivering') LIMIT 1").fetchone():
            raise ValueError('Final snapshot still has queued messages')
        attachments = db.execute('SELECT path,size FROM attachments').fetchall()
    finally: db.close()
    inventory = {}
    for item in ready['upload_inventory']:
        path = PurePosixPath(item['path'])
        if path.is_absolute() or '..' in path.parts or path.parts[0] != 'uploads' or str(path) in inventory: raise ValueError('Invalid upload inventory')
        inventory[str(path)] = item
    seen = set()
    with tarfile.open(incoming / 'iamceo-runtime.tar.gz') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()): raise ValueError('Unsafe final runtime member')
            if not member.isfile() or path.parts[0] != 'uploads': continue
            name = str(path); item = inventory.get(name)
            if not item or name in seen: raise ValueError('Final upload inventory differs from archive')
            h = hashlib.sha256()
            with archive.extractfile(member) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''): h.update(block)
            if member.size != item['bytes'] or h.hexdigest() != item['sha256']: raise ValueError('Final upload digest mismatch')
            seen.add(name)
    if seen != set(inventory): raise ValueError('Final upload file missing')
    source = Path(cfg['source_data_root'])
    for path, size in attachments:
        relative = Path(path).relative_to(source).as_posix()
        if relative not in inventory or inventory[relative]['bytes'] != size: raise ValueError('Final DB attachment not preserved')
    result = {'kind': 'final-input-verification', 'verified': True, 'at': now_iso(), 'snapshot_id': identity,
              'cutover_receipt_sha256': digest(root / 'CUTOVER_READY.json'), 'schema': version,
              'supported_schema': supported, 'source_sha': release['source_sha'], 'counts': counts,
              'verified_upload_files': len(inventory), 'git_bundle_history_verified': False,
              'private_wip_preserved': True, 'operational_activation': False}
    private_json(root / 'FINAL_INPUT_VERIFIED.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--config', required=True)
    parser.add_argument('command', choices=['observe', 'run', 'freeze', 'rollback', 'status', 'verify-final', 'acknowledge'])
    parser.add_argument('--fingerprint'); parser.add_argument('--owner-pid', type=int); args = parser.parse_args()
    cfg = private_config(args.config); runner = Supervisor(cfg)
    if args.command == 'acknowledge':
        if not args.fingerprint or not args.owner_pid: parser.error('acknowledge requires reviewed --fingerprint and live --owner-pid')
        print(json.dumps(runner.acknowledge(args.fingerprint, args.owner_pid))); return
    if args.command == 'verify-final': print(json.dumps(verify_final(cfg))); return
    if args.command == 'status': print(json.dumps(runner.load(), ensure_ascii=False)); return
    if args.command == 'freeze':
        observation = collect(cfg); api = API(cfg['source_url'], cfg['source_credential_file'])
        request = freeze_source(cfg, api, runner.load(), observation['conditions']['target_prepared'])
        print(json.dumps({'request_id': request['request_id'], 'source_frozen': True})); return
    if args.command == 'rollback':
        rollback_source(cfg, API(cfg['source_url'], cfg['source_credential_file']), read_json(Path(cfg['root']) / 'SOURCE_FROZEN.json'))
        print(json.dumps({'source_rollback': 'verified'})); return
    if args.command == 'observe':
        observation = collect(cfg); action = runner.tick(observation, dispatch=False)
        print(json.dumps({'action': action, 'observation': observation}, ensure_ascii=False)); return
    lock = (runner.directory / '.supervisor.lock').open('a'); os.chmod(lock.name, 0o600)
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: raise SystemExit('A migration supervisor already owns this session')
    running = True
    def stop(_signal, _frame):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    while running:
        try:
            observation = collect(cfg); action = runner.tick(observation, dispatch=True); runner.reap()
            private_json(runner.directory / 'heartbeat.json', {'at': now_iso(), 'pid': os.getpid(), 'action': action,
                         'same_thread_id': cfg['thread_id'], 'source_writes': False, 'automatic_cutover': False})
        except Exception as error:
            private_json(runner.directory / 'monitor-error.json', {'at': now_iso(), 'error_type': type(error).__name__})
        for _ in range(cfg['poll_seconds']):
            if not running: break
            time.sleep(1)
    # The same-thread child is never interrupted when its supervisor is stopped.

if __name__ == '__main__': main()
