#!/usr/bin/env python3
"""Offline preparation only. This module cannot activate workers or stop a source."""
import argparse
import copy
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import tarfile
import tempfile
import time


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def private_json(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def verify_initial(root):
    root = Path(root)
    receipt = json.loads((root / 'SOURCE_EXPORT_READY.json').read_text())
    if receipt.get('kind') != 'initial-preparation-only' or receipt.get('cutover_allowed') is not False:
        raise ValueError('Expected a preparation-only receipt; operational activation is unsupported')
    incoming = root / 'incoming/initial'
    if not receipt.get('files'): raise ValueError('No file digests in receipt')
    for name, expected in receipt['files'].items():
        if PurePosixPath(name).name != name: raise ValueError('Invalid receipt filename')
        path = incoming / name
        if path.is_symlink() or not path.is_file(): raise ValueError('Input must be a regular file')
        if path.stat().st_size != expected['bytes'] or digest(path) != expected['sha256']:
            raise ValueError('Digest mismatch: ' + name)
    return {'verified_at': utc_now(), 'verified_files': len(receipt['files']),
            'source_receipt_sha256': digest(root / 'SOURCE_EXPORT_READY.json'), 'cutover_allowed': False}


def extract_private(archive, destination):
    destination = Path(destination)
    if destination.exists() or destination.is_symlink(): raise FileExistsError(destination)
    with tarfile.open(archive) as source:
        members = source.getmembers()
        seen = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe archive member')
            if str(path) in seen: raise ValueError('Duplicate archive member')
            seen.add(str(path))
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        stage = Path(tempfile.mkdtemp(prefix='.extract-', dir=destination.parent))
        try:
            for member in members:
                target = stage / member.name
                if member.isdir(): target.mkdir(parents=True, exist_ok=True, mode=0o700)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    with source.extractfile(member) as stream, target.open('xb') as output:
                        os.chmod(target, 0o600); shutil.copyfileobj(stream, output)
            # An existing destination is never merged or overwritten.
            if destination.exists(): raise FileExistsError(destination)
            stage.rename(destination)
        finally:
            if stage.exists(): shutil.rmtree(stage)
    return {'files': sum(m.isfile() for m in members), 'destination': str(destination)}


def with_iamceo(catalog, port, plist):
    definition = {'id': 'iamceo', 'name': 'IAMCEO', 'project': 'IAMCEO', 'kind': 'launchd',
                  'target': 'com.iamceo.server', 'port': port, 'plistPath': str(plist),
                  'activity': {'kind': 'unknown'}, 'healthUrl': f'http://127.0.0.1:{port}/api/health',
                  'readOnly': True}
    result = copy.deepcopy(catalog)
    definitions = result['definitions']
    existing = next((item for item in definitions if item['id'] == 'iamceo'), None)
    if existing is not None:
        if existing != definition: raise ValueError('Conflicting IAMCEO registration; inspect before changing')
        return result
    if any(item.get('port') == port or item.get('target') == definition['target'] for item in definitions):
        raise ValueError('Reserved port or launchd target')
    definitions.append(definition)
    return result


def register_catalog(config, backups, port, plist):
    config = Path(config); backups = Path(backups)
    if config.is_symlink() or not config.is_file(): raise ValueError('Catalog must be a regular file')
    lock = config.with_name('.iamceo-registration.lock')
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'w') as locked:
        fcntl.flock(locked, fcntl.LOCK_EX)
        original = config.read_bytes()
        updated = with_iamceo(json.loads(original), port, plist)
        if updated == json.loads(original): return {'changed': False, 'id': 'iamceo'}
        backups.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup = backups / ('service-' + hashlib.sha256(original).hexdigest() + '.json')
        if not backup.exists():
            with backup.open('xb') as output: os.chmod(backup, 0o600); output.write(original)
        if config.read_bytes() != original: raise ValueError('Catalog changed concurrently; retry after inspection')
        private_json(config, updated)
    return {'changed': True, 'id': 'iamceo', 'backup': str(backup), 'read_only': True}


def observe_receipts(root):
    root = Path(root)
    with (root / '.watch.lock').open('a') as lock:
        os.chmod(lock.name, 0o600); fcntl.flock(lock, fcntl.LOCK_EX)
        state_path = root / '.watch-state.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        changed = []
        for name in ['SOURCE_EXPORT_READY.json', 'CUTOVER_READY.json', 'DNS_READY.json']:
            path = root / name
            if not path.is_file() or path.is_symlink(): continue
            if path.stat().st_size > 16 * 1024 * 1024: raise ValueError('Receipt too large')
            data = path.read_bytes(); json.loads(data)
            identity = hashlib.sha256(data).hexdigest()
            if state.get(name) == identity: continue
            changed.append(name); state[name] = identity
            event = {'at': utc_now(), 'receipt': name, 'sha256': identity, 'automatic_cutover': False}
            fd = os.open(root / 'receipt-events.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, 'a') as stream:
                stream.write(json.dumps(event) + '\n'); stream.flush(); os.fsync(stream.fileno())
        if changed:
            private_json(root / 'TARGET_RESUME_NEEDED.json', {'at': utc_now(), 'changed_receipts': changed,
                'automatic_cutover': False, 'instruction': 'Verify the new receipts and resume the existing migration task; no model or worker was started.'})
            private_json(state_path, state)
        return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    verify = sub.add_parser('verify-initial'); verify.add_argument('root', type=Path)
    extract = sub.add_parser('extract-private'); extract.add_argument('archive', type=Path); extract.add_argument('destination', type=Path)
    catalog = sub.add_parser('register-catalog')
    catalog.add_argument('--config', type=Path, required=True); catalog.add_argument('--backups', type=Path, required=True)
    catalog.add_argument('--port', type=int, default=47878); catalog.add_argument('--plist', type=Path, required=True)
    watch = sub.add_parser('watch'); watch.add_argument('root', type=Path); watch.add_argument('--once', action='store_true')
    args = parser.parse_args()
    if args.command == 'verify-initial': print(json.dumps(verify_initial(args.root)))
    elif args.command == 'extract-private': print(json.dumps(extract_private(args.archive, args.destination)))
    elif args.command == 'register-catalog': print(json.dumps(register_catalog(args.config, args.backups, args.port, args.plist)))
    else:
        running = True
        def stop(_signal, _frame):
            nonlocal running
            running = False
        signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
        while running:
            changed = observe_receipts(args.root)
            if changed: print(json.dumps({'changed': changed, 'automatic_cutover': False}), flush=True)
            if args.once: break
            for _ in range(30):
                if not running: break
                time.sleep(1)

if __name__ == '__main__': main()
