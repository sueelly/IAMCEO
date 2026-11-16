"""Migration safety checks: never run against an installed data home."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('migration', Path(__file__).parents[1] / 'scripts/mac_mini_migration.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)

class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_export_is_preparation_only_and_detects_tampering(self):
        incoming = self.root / 'incoming/initial'
        incoming.mkdir(parents=True)
        (incoming / 'test.bundle').write_bytes(b'original')
        receipt = {'kind':'initial-preparation-only', 'cutover_allowed':False, 'files':{'test.bundle':{'bytes':8,'sha256':hashlib.sha256(b'original').hexdigest()}}}
        (self.root / 'SOURCE_EXPORT_READY.json').write_text(json.dumps(receipt))
        self.assertEqual(migration.verify_initial(self.root)['verified_files'], 1)
        (incoming / 'test.bundle').write_bytes(b'tampered')
        with self.assertRaises(ValueError): migration.verify_initial(self.root)
        receipt['cutover_allowed'] = True
        (self.root / 'SOURCE_EXPORT_READY.json').write_text(json.dumps(receipt))
        with self.assertRaises(ValueError): migration.verify_initial(self.root)

    def test_archive_rejects_escape_and_links_before_extracting(self):
        for name, link in [('../outside', False), ('/absolute', False), ('link', True)]:
            archive = self.root / 'bad.tar.gz'
            with tarfile.open(archive, 'w:gz') as tf:
                good = tarfile.TarInfo('config.json'); good.size=2; tf.addfile(good, io.BytesIO(b'{}'))
                item = tarfile.TarInfo(name)
                if link: item.type=tarfile.SYMTYPE; item.linkname='/etc'
                tf.addfile(item)
            dest = self.root / 'dest'
            with self.assertRaises(ValueError): migration.extract_private(archive, dest)
            self.assertFalse(dest.exists())

    def test_archive_preserves_bytes_and_refuses_existing_destination(self):
        archive = self.root/'good.tar.gz'
        with tarfile.open(archive,'w:gz') as tf:
            item=tarfile.TarInfo('uploads/file');item.size=3;tf.addfile(item,io.BytesIO(b'abc'))
        dest=self.root/'copy'
        migration.extract_private(archive,dest)
        self.assertEqual((dest/'uploads/file').read_bytes(),b'abc')
        self.assertEqual((dest/'uploads/file').stat().st_mode & 0o777,0o600)
        self.assertEqual(dest.stat().st_mode & 0o777,0o700)
        with self.assertRaises(FileExistsError): migration.extract_private(archive,dest)

    def test_catalog_preserves_auth_and_existing_services_and_refuses_conflict(self):
        original={'port':43130,'tokenFile':'/private/token','definitions':[{'id':'existing','target':'keep'}]}
        result=migration.with_iamceo(original,47878,Path('/Users/test/Library/LaunchAgents/com.iamceo.server.plist'))
        self.assertEqual(original['definitions'],[{'id':'existing','target':'keep'}])
        self.assertEqual(result['tokenFile'],original['tokenFile'])
        self.assertEqual(result['definitions'][0],original['definitions'][0])
        self.assertTrue(result['definitions'][-1]['readOnly'])
        self.assertEqual(migration.with_iamceo(result,47878,Path('/Users/test/Library/LaunchAgents/com.iamceo.server.plist')),result)
        with self.assertRaises(ValueError): migration.with_iamceo(result,47879,Path('/other'))
        original['definitions'].append({'id':'other','port':47878})
        with self.assertRaises(ValueError): migration.with_iamceo(original,47878,Path('/plist'))

    def test_watcher_only_records_changed_receipts_and_never_activates(self):
        self.assertEqual(migration.observe_receipts(self.root),[])
        (self.root/'CUTOVER_READY.json').write_text('{"cutover_allowed":true}')
        self.assertEqual(migration.observe_receipts(self.root),['CUTOVER_READY.json'])
        self.assertEqual(migration.observe_receipts(self.root),[])
        marker=json.loads((self.root/'TARGET_RESUME_NEEDED.json').read_text())
        self.assertFalse(marker['automatic_cutover'])
        (self.root/'CUTOVER_READY.json').write_text('{"cutover_allowed":false}')
        self.assertEqual(migration.observe_receipts(self.root),['CUTOVER_READY.json'])
        self.assertFalse((self.root/'CUTOVER_APPLIED.json').exists())

if __name__ == '__main__': unittest.main()
