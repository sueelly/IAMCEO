import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).parents[1] / 'scripts' / 'temporary_conductor_watch.py'
spec = importlib.util.spec_from_file_location('temporary_watch', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RetirementGateTests(unittest.TestCase):
    def fixture(self):
        config = {'projectId': 'p', 'memberId': 'helper', 'primaryMemberId': 'primary',
                  'taskId': 'scope', 'backlogTaskIds': ['old-a', 'old-b']}
        ledger = {'projectId': 'p', 'memberId': 'helper', 'taskId': 'scope',
                  'reviews': [{'backlogTaskId': 'old-a', 'reviewTaskId': 'review-a'},
                              {'backlogTaskId': 'old-b', 'reviewTaskId': 'review-b'}],
                  'finalReportId': 'final', 'primaryAckReportId': 'ack'}
        state = {'project': {'id': 'p'}, 'members': [
            {'id': 'primary', 'kind': 'conductor'},
            {'id': 'helper', 'kind': 'conductor', 'status': 'idle', 'queuedCount': 0,
             'executionState': {'phase': 'ended'}}],
            'tasks': [{'id': 'review-a', 'parentTaskId': 'scope', 'progress': {'stage': 'done'}},
                      {'id': 'review-b', 'parentTaskId': 'scope', 'progress': {'stage': 'done'}}],
            'decisions': [], 'deliveryNotices': {'members': []}}
        reports = {'final': {'projectId': 'p', 'memberId': 'helper', 'taskId': 'scope',
                            'mine': False, 'at': '2026-11-18T00:01:00Z',
                            'body': 'TEMP_REVIEW_DRAINED:scope'},
                   'ack': {'projectId': 'p', 'memberId': 'primary', 'taskId': 'scope',
                           'mine': False, 'at': '2026-11-18T00:02:00Z', 'aboutMessageId': 'final',
                           'body': 'TEMP_REVIEW_HANDOFF_ACCEPTED:scope'}}
        return config, ledger, state, reports

    def test_drained_scope_with_genuine_primary_ack_is_ready(self):
        self.assertEqual(module.retirement_blockers(*self.fixture()), [])

    def test_incomplete_or_duplicated_coverage_cannot_retire(self):
        c, ledger, state, reports = self.fixture()
        ledger['reviews'][1]['backlogTaskId'] = 'old-a'
        self.assertIn('backlog_coverage', module.retirement_blockers(c, ledger, state, reports))

    def test_waiting_retest_cannot_be_called_done_by_ledger(self):
        c, ledger, state, reports = self.fixture()
        state['tasks'][0]['progress']['stage'] = 'review'
        self.assertIn('review_not_done:review-a', module.retirement_blockers(c, ledger, state, reports))

    def test_unrelated_completed_task_cannot_stand_in_for_review(self):
        c, ledger, state, reports = self.fixture()
        state['tasks'][0]['parentTaskId'] = 'unrelated'
        self.assertIn('review_outside_scope:review-a', module.retirement_blockers(c, ledger, state, reports))

    def test_helper_cannot_acknowledge_its_own_handoff(self):
        c, ledger, state, reports = self.fixture()
        reports['ack']['memberId'] = 'helper'
        self.assertIn('primary_ack_missing', module.retirement_blockers(c, ledger, state, reports))

    def test_similar_scope_marker_is_not_acceptance(self):
        c, ledger, state, reports = self.fixture()
        reports['ack']['body'] = 'TEMP_REVIEW_HANDOFF_ACCEPTED:scope-other'
        self.assertIn('primary_ack_missing', module.retirement_blockers(c, ledger, state, reports))

    def test_quoted_marker_is_not_acceptance(self):
        c, ledger, state, reports = self.fixture()
        reports['ack']['body'] = 'Example:\n```\nTEMP_REVIEW_HANDOFF_ACCEPTED:scope\n```'
        self.assertIn('primary_ack_missing', module.retirement_blockers(c, ledger, state, reports))

    def test_ack_must_reference_this_final_report_and_follow_it(self):
        c, ledger, state, reports = self.fixture()
        reports['ack'].update(aboutMessageId='old-final', at='2026-11-18T00:00:00Z')
        self.assertIn('handoff_ack_unbound', module.retirement_blockers(c, ledger, state, reports))

    def test_representative_quote_cannot_impersonate_primary_ack(self):
        c, ledger, state, reports = self.fixture()
        reports['ack']['mine'] = True
        self.assertIn('primary_ack_missing', module.retirement_blockers(c, ledger, state, reports))

    def test_busy_queue_or_open_approval_blocks_retirement(self):
        c, ledger, state, reports = self.fixture()
        state['members'][1].update(status='working', queuedCount=1,
                                   executionState={'phase': 'running'})
        state['decisions'] = [{'memberId': 'helper', 'status': 'open'}]
        found = module.retirement_blockers(c, ledger, state, reports)
        self.assertIn('helper_not_idle', found)
        self.assertIn('pending_input', found)
        self.assertIn('active_execution', found)
        self.assertIn('open_decision', found)

    def test_unknown_delivery_cannot_be_discarded(self):
        c, ledger, state, reports = self.fixture()
        state['deliveryNotices']['members'] = [{'memberId': 'helper', 'unknownCount': 1}]
        self.assertIn('unsettled_delivery', module.retirement_blockers(c, ledger, state, reports))

    def test_unlisted_followup_under_review_scope_blocks_retirement(self):
        c, ledger, state, reports = self.fixture()
        state['tasks'].append({'id': 'fix-followup', 'parentTaskId': 'review-a',
                               'progress': {'stage': 'review'}})
        self.assertIn('scope_task_not_done:fix-followup', module.retirement_blockers(c, ledger, state, reports))

    def setup_runtime(self, directory):
        config, ledger, state, reports = self.fixture()
        directory = Path(directory)
        config.update(home=str(directory), ledgerPath=str(directory / 'ledger.json'),
                      sourceMessageId='authorization')
        (directory / 'config.json').write_text(json.dumps({'port': 12345, 'accessCode': 'fixture-only'}))
        (directory / 'watch.json').write_text(json.dumps(config))
        (directory / 'ledger.json').write_text(json.dumps(ledger))
        return directory / 'watch.json', config, state, reports

    def test_successful_drain_retires_once_and_preserves_primary(self):
        with tempfile.TemporaryDirectory() as directory:
            path, config, state, reports = self.setup_runtime(directory)
            mutations = []

            def server(request, timeout):
                if request.get_method() == 'POST':
                    mutations.append(request.full_url)
                    self.assertTrue(request.full_url.endswith('/temporary-conductor/helper/retire'))
                    state['members'] = [m for m in state['members'] if m['id'] != 'helper']
                    payload = {'retired': True}
                elif '/api/messages/' in request.full_url:
                    payload = reports[request.full_url.rsplit('/', 1)[1]]
                else:
                    payload = state
                return io.BytesIO(json.dumps(payload).encode())

            with patch.object(module.urllib.request, 'urlopen', side_effect=server):
                self.assertEqual(module.run_once(path)['phase'], 'retired')
                self.assertEqual(module.run_once(path)['phase'], 'retired')
            self.assertEqual(len(mutations), 1)
            self.assertEqual([m['id'] for m in state['members']], ['primary'])

    def test_ambiguous_retirement_is_never_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            path, config, state, reports = self.setup_runtime(directory)
            mutations = []

            def server(request, timeout):
                if request.get_method() == 'POST':
                    mutations.append(request.full_url)
                    raise TimeoutError('fixture transport uncertainty')
                if '/api/messages/' in request.full_url:
                    payload = reports[request.full_url.rsplit('/', 1)[1]]
                else:
                    payload = state
                return io.BytesIO(json.dumps(payload).encode())

            with patch.object(module.urllib.request, 'urlopen', side_effect=server):
                with self.assertRaises(TimeoutError):
                    module.run_once(path)
                self.assertEqual(module.run_once(path)['phase'], 'retire_requested')
            self.assertEqual(len(mutations), 1)

    def test_missing_primary_ack_performs_no_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            path, config, state, reports = self.setup_runtime(directory)
            reports['ack']['memberId'] = 'helper'
            mutations = []

            def server(request, timeout):
                if request.get_method() == 'POST':
                    mutations.append(request.full_url)
                payload = reports[request.full_url.rsplit('/', 1)[1]] if '/api/messages/' in request.full_url else state
                return io.BytesIO(json.dumps(payload).encode())

            with patch.object(module.urllib.request, 'urlopen', side_effect=server):
                self.assertEqual(module.run_once(path)['phase'], 'waiting')
            self.assertEqual(mutations, [])


if __name__ == '__main__':
    unittest.main()
