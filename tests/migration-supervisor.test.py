import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import hashlib
import io
import sqlite3
import tarfile
import sys
import tempfile
import time
import unittest
from urllib.parse import urlsplit,parse_qs

spec=importlib.util.spec_from_file_location('supervisor',Path(__file__).parents[1]/'scripts/migration_supervisor.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

class API:
    def __init__(self):
        self.ids=['hq','project'];self.flags=dict.fromkeys(self.ids,True);self.queued=False;self.open=False;self.busy=False;self.fail=None;self.calls=[]
    def request(self,method,path,body=None):
        self.calls.append((method,path,body))
        if path=='/api/bootstrap':return {'projects':[{'id':i} for i in self.ids]}
        if path=='/api/readiness':return {'schema':{'version':33,'supportedVersion':33},'ok':True}
        if '/state' in path:
            p=path.split('/')[3];return {'project':{'id':p,'runnerEnabled':self.flags[p]},'members':[{'id':'m-'+p,'status':'working' if self.busy else 'idle'}],'decisions':[{'id':'d','status':'open'}] if self.open else []}
        if '/messages/page' in path:
            older='cursor=' in path
            return {'items':[{'id':'q','delivery':'queued'}] if older and self.queued else [],'hasOlder':not older,'nextCursor':None if older else 'older'}
        if method=='PATCH':
            p=path.split('/')[3]
            if self.fail==p and body['runnerEnabled'] is False:raise RuntimeError('injected')
            self.flags[p]=body['runnerEnabled'];return {'id':p,'runnerEnabled':self.flags[p]}
        raise AssertionError((method,path))

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
    def config(self):return {'root':str(self.root),'state_dir':str(self.root/'private'),'thread_id':'11111111-1111-4111-8111-111111111111','project_ids':['hq','project'],'poll_seconds':120,'idle_interval_seconds':120,'test_mode':True}
    def snapshot(self,idle=False):return {'source':{'reachable':True,'quiescent':idle,'stability_key':'idle' if idle else 'busy','blockers':[] if idle else ['source_work_in_progress']},'conditions':{'claude_authenticated':False,'domain_ready':False},'receipts':{}}
    def test_canonical_tailnet_receipt_is_recognized_without_public_ingress(self):
        receipt={'access_scope':'tailnet_only','public_ingress_required':False,'public_dns_required':False,'canonical_tailnet_https_acceptable':True,'source_browser_exception':False}
        self.assertEqual(s.access_mode(receipt),'tailscale_only')
        self.assertEqual(s.access_mode({'mode':'tailscale_only'}),'tailscale_only')
        self.assertEqual(s.access_mode({'mode':'public'}),'public')
        self.assertEqual(s.access_mode({'mode':'public','assumed':True}),'public')
        with self.assertRaises(ValueError):s.access_mode({'access_scope':'tailnet_only','mode':'public'})
        with self.assertRaises(ValueError):s.access_mode({'access_scope':'unrecognized'})
    def test_tailnet_collection_does_not_probe_public_dns_tls_or_ingress(self):
        from unittest.mock import patch,Mock
        cfg=self.config();cfg.pop('test_mode');cfg.update(source_url='https://source.example.invalid',source_credential_file='/unused',public_origin='https://public.example.invalid',tailscale_origin='https://machine.example.ts.net:14443',claude_bin='/unused/claude',codex_bin='/unused/codex',target_health='http://127.0.0.1:47879/api/health',target_readiness='http://127.0.0.1:47879/api/readiness',release_manifest=str(self.root/'release.json'))
        s.private_json(self.root/'DOMAIN-PREFERENCE.json',{'access_scope':'tailnet_only','public_ingress_required':False,'public_dns_required':False});s.private_json(cfg['release_manifest'],{'build_id':'fixture'})
        with patch.object(s,'observe_source',return_value=self.snapshot()['source']),patch.object(s,'command_auth',return_value=True),patch.object(s,'http_probe',return_value=False),patch.object(s,'application_ready',return_value=True),patch.object(s,'dns_resolves',side_effect=AssertionError('public DNS must not be probed')),patch.object(s,'tls_valid',side_effect=AssertionError('public TLS must not be probed')),patch.object(s.subprocess,'run',return_value=Mock(returncode=1)):
            result=s.collect(cfg)
            self.assertIsNone(result['conditions']['target_handoff'])
            cfg['viewing_release_manifest']=str(self.root/'view-release.json')
            s.private_json(cfg['viewing_release_manifest'],{'kind':'read-only-snapshot-view','operational_cutover':False,'build_id':'view-fixture'})
            with patch.object(s,'command_auth',return_value=False),patch.object(s,'application_ready',side_effect=lambda url,credential,build,require_read_only=False: build=='view-fixture' and require_read_only):
                view=s.collect(cfg)
            self.assertTrue(view['conditions']['initial_viewing_ready']);self.assertFalse(view['conditions']['domain_ready']);self.assertFalse(view['conditions']['target_prepared']);self.assertFalse(view['conditions']['claude_authenticated'])
        self.assertEqual(result['conditions']['domain_mode'],'tailscale_only');self.assertEqual(result['conditions']['access_origin'],cfg['tailscale_origin']);self.assertTrue(result['conditions']['domain_ready']);self.assertIsNone(result['conditions']['public_dns_resolves']);self.assertIsNone(result['conditions']['public_tls_valid']);self.assertIsNone(result['conditions']['ingress_credentials_available']);self.assertFalse(result['conditions']['target_prepared'])
    def test_api_cannot_answer_approvals_or_write_other_source_fields(self):
        api=s.API('https://source.example.invalid',str(self.root/'missing-credentials'))
        for method,path,body in [('POST','/api/decisions/d/answer',{}),('PATCH','/api/decisions/d',{}),('PATCH','/api/projects/p',{'runnerEnabled':False,'cwd':'/other'})]:
            with self.assertRaises(ValueError):api.request(method,path,body)
    def test_target_handoff_watches_delivery_and_prompt_without_busy_idle_chatter(self):
        class Target:
            status='blocked';delivery='held';calls=[]
            def request(self,method,path,body=None):
                self.calls.append((method,path,body))
                if path.startswith('/api/members/'):
                    return {'id':'m-one','projectId':'project','status':self.status,'statusObservation':{'observedAt':str(time.time()),'error':{'code':'folder_trust'}}}
                return {'id':'resume-one','projectId':'project','delivery':self.delivery,'body':'private text must not enter state'}
        api=Target();members=[{'member_id':'m-one','project_id':'project','message_id':'resume-one'}]
        pending=s.observe_target_handoff(api,members);state={};obs=self.snapshot();obs['conditions']['target_handoff']=pending;s.record_observation(state,obs,100,120)
        self.assertEqual(pending['members']['m-one']['blocked_reason'],'folder_trust')
        self.assertNotIn('private text',json.dumps(pending));self.assertTrue(all(c[0]=='GET' for c in api.calls))
        api.status='working';api.delivery='delivered';obs=copy.deepcopy(obs);obs['conditions']['target_handoff']=s.observe_target_handoff(api,members);s.record_observation(state,obs,200,120)
        self.assertEqual(len(state['pending']),1);state['pending']=[]
        api.status='idle';obs=copy.deepcopy(obs);obs['conditions']['target_handoff']=s.observe_target_handoff(api,members);s.record_observation(state,obs,300,120)
        self.assertFalse(state['pending'])
    def test_target_handoff_rejects_wrong_project_identity_and_unavailable_reads(self):
        class Target:
            def request(self,method,path,body=None):return {'id':'m-one','projectId':'other-project'}
        members=[{'member_id':'m-one','project_id':'project','message_id':'resume-one'}]
        with self.assertRaises(ValueError):s.observe_target_handoff(Target(),members)
        self.assertEqual(s.target_handoff_probe({}),None)
        from unittest.mock import patch
        cfg={'target_handoff':{'origin':'https://target.example.invalid','credential_file':'/unused','members':members}}
        with patch.object(s.API,'request',side_effect=RuntimeError('sensitive response body')):
            result=s.target_handoff_probe(cfg)
        self.assertEqual(result,{'reachable':False,'error_type':'RuntimeError'})
    def test_reads_older_messages_and_never_writes_during_observation(self):
        api=API();api.queued=True;obs=s.observe_source(api,api.ids,[])
        self.assertFalse(obs['quiescent']);self.assertIn('queued_source_messages',obs['blockers'])
        self.assertTrue(all(c[0]=='GET' for c in api.calls))
        api.queued=False;api.open=True;self.assertIn('open_source_decisions',s.observe_source(api,api.ids,[])['blockers'])
        api.open=False;api.busy=True;self.assertIn('source_work_in_progress',s.observe_source(api,api.ids,[])['blockers'])
        api.busy=False;api.ids.append('new');self.assertIn('registered_projects_changed',s.observe_source(api,['hq','project'],[])['blockers'])
    def test_two_spaced_identical_idle_observations_and_reset_on_unknown(self):
        state={};s.record_observation(state,self.snapshot(True),100,120)
        self.assertFalse(state['idle_qualified']);s.record_observation(state,self.snapshot(True),110,120);self.assertFalse(state['idle_qualified'])
        s.record_observation(state,self.snapshot(True),221,120);self.assertTrue(state['idle_qualified'])
        s.record_observation(state,self.snapshot(False),222,120);self.assertFalse(state['idle_qualified'])
        s.record_observation(state,self.snapshot(True),223,120);self.assertFalse(state['idle_qualified'])
    def test_timestamps_do_not_wake_but_real_edges_are_coalesced(self):
        state={};one=self.snapshot();s.record_observation(state,one,100,120)
        for t in [200,300,400]:s.record_observation(state,one,t,120)
        self.assertEqual(state['pending'],[])
        two=copy.deepcopy(one);two['conditions']['claude_authenticated']=True
        s.record_observation(state,two,500,120);self.assertEqual(len(state['pending']),1)
        s.record_observation(state,two,600,120);self.assertEqual(len(state['pending']),1)
    def test_owner_pid_and_terminal_event_both_required(self):
        event=self.root/'events';event.write_text('{"type":"turn.completed"}\n')
        job={'pid':os.getpid(),'identity':s.process_identity(os.getpid()),'events':str(event)}
        self.assertFalse(s.job_finished(job))
        job['pid']=99999999;job['identity']='gone';self.assertTrue(s.job_finished(job))
        event.write_text('{"type":"turn.started"}\n');self.assertFalse(s.job_finished(job))
    def test_current_owner_can_acknowledge_only_the_reviewed_condition_fingerprint(self):
        cfg=self.config();runner=s.Supervisor(cfg);runner.tick(self.snapshot(),100,False)
        changed=self.snapshot();changed['conditions']['initial_viewing_ready']=True
        runner.tick(changed,200,False);state=runner.load()
        state['active_job']={'pid':os.getpid(),'identity':s.process_identity(os.getpid())}
        s.private_json(runner.state_path,state);fingerprint=s.key(state['meaningful'])
        self.assertTrue(state['pending'])
        with self.assertRaises(ValueError):runner.acknowledge(fingerprint,99999999)
        newer=copy.deepcopy(changed);newer['conditions']['claude_authenticated']=True
        runner.tick(newer,300,False)
        with self.assertRaises(ValueError):runner.acknowledge(fingerprint,os.getpid())
        current=runner.load();self.assertTrue(current['pending'])
        runner.acknowledge(s.key(current['meaningful']),os.getpid())
        done=runner.load();self.assertEqual(done['pending'],[]);self.assertEqual(done['active_job'],state['active_job']);self.assertTrue(done['last_handled']['event_ids'])
        runner.tick(newer,400,False);self.assertEqual(runner.load()['pending'],[])
        runner.tick(changed,500,False);self.assertTrue(runner.load()['pending'])
        dead=runner.load();dead['active_job']={'pid':99999999,'identity':None};s.private_json(runner.state_path,dead)
        with self.assertRaises(ValueError):runner.acknowledge(s.key(dead['meaningful']),99999999)
    def test_one_resume_and_restart_does_not_repeat_claim(self):
        cfg=self.config();script=self.root/'fake.py';script.write_text("import json,sys,time\nfrom pathlib import Path\nr=Path(sys.argv[1]);(r/'started').write_text('yes');sys.stdin.read();print(json.dumps({'type':'turn.started'}),flush=True);time.sleep(.2);print(json.dumps({'type':'turn.completed'}),flush=True)\n")
        cfg['resume_command']=[sys.executable,str(script),str(self.root),'{thread_id}']
        owner=self.root/'owner.events';owner.write_text('{"type":"turn.completed"}\n');cfg['initial_job']={'pid':99999999,'identity':'gone','events':str(owner)}
        runner=s.Supervisor(cfg);self.assertEqual(runner.tick(self.snapshot(),100,dispatch=True),'initialized')
        changed=self.snapshot();changed['conditions']['claude_authenticated']=True
        self.assertEqual(runner.tick(changed,200,dispatch=True),'started')
        self.assertEqual(s.Supervisor(cfg).tick(changed,201,dispatch=True),'unchanged')
        time.sleep(.4);runner.reap();self.assertEqual(s.Supervisor(cfg).tick(changed,202,dispatch=True),'unchanged')
        self.assertEqual(len(list((self.root/'private/runs').glob('*.events.jsonl'))),1)
    def test_pending_event_waits_for_a_live_owner(self):
        cfg=self.config();event=self.root/'owner.events';event.write_text('{"type":"turn.completed"}\n')
        cfg['initial_job']={'pid':os.getpid(),'identity':s.process_identity(os.getpid()),'events':str(event)}
        runner=s.Supervisor(cfg);runner.tick(self.snapshot(),100,dispatch=True)
        changed=self.snapshot();changed['conditions']['domain_ready']=True
        self.assertEqual(runner.tick(changed,200,dispatch=True),'waiting_owner')
        self.assertEqual(len(runner.load()['pending']),1)
    def test_spawn_failure_is_not_replayed_on_every_poll(self):
        cfg=self.config();cfg['resume_command']=['/missing/fake','{thread_id}'];owner=self.root/'owner';owner.write_text('{"type":"turn.completed"}\n');cfg['initial_job']={'pid':99999999,'identity':'gone','events':str(owner)}
        runner=s.Supervisor(cfg);runner.tick(self.snapshot(),100,dispatch=True);changed=self.snapshot();changed['conditions']['domain_ready']=True
        self.assertEqual(runner.tick(changed,200,dispatch=True),'spawn_failed');self.assertEqual(runner.tick(changed,201,dispatch=True),'unchanged')
    def test_persisted_uncertain_claim_never_replays_after_supervisor_restart(self):
        cfg=self.config();runner=s.Supervisor(cfg);runner.tick(self.snapshot(),100,dispatch=False)
        state=runner.load();state['dispatch']={'status':'claimed','event_ids':['unknown']};s.private_json(runner.state_path,state)
        self.assertEqual(s.Supervisor(cfg).tick(self.snapshot(),200,dispatch=True),'uncertain_launch')
    def test_source_busy_or_changed_never_gets_patched(self):
        cfg=self.config();api=API();obs=s.observe_source(api,api.ids,[]);state={'idle_qualified':True,'idle_key':obs['stability_key'],'idle_sample_at':time.time()}
        api.busy=True
        with self.assertRaises(ValueError):s.freeze_source(cfg,api,state,target_ready=True)
        self.assertFalse(any(c[0]=='PATCH' for c in api.calls))
    def test_blocked_member_is_not_idle(self):
        api=API();original=api.request
        def blocked(method,path,body=None):
            data=original(method,path,body)
            if path.endswith('/state'):data['members'][0]['status']='blocked'
            return data
        api.request=blocked;self.assertFalse(s.observe_source(api,api.ids,[])['quiescent'])
    def test_incomplete_target_cannot_freeze_or_request_export(self):
        api=API();cfg=self.config()
        with self.assertRaises(ValueError):s.freeze_source(cfg,api,{'idle_qualified':True},target_ready=False)
        self.assertTrue(all(c[0]=='GET' for c in api.calls));self.assertFalse((self.root/'EXPORT_REQUEST.json').exists())
    def test_freeze_failure_restores_changed_flags_without_export(self):
        api=API();api.fail='project';cfg=self.config();obs=s.observe_source(api,api.ids,[]);state={'idle_qualified':True,'idle_key':obs['stability_key'],'idle_sample_at':time.time()}
        with self.assertRaises(RuntimeError):s.freeze_source(cfg,api,state,target_ready=True)
        self.assertTrue(all(api.flags.values()));self.assertFalse((self.root/'EXPORT_REQUEST.json').exists());receipt=json.loads((self.root/'SOURCE_FROZEN.json').read_text());self.assertEqual(receipt['phase'],'rolled_back')
    def test_freeze_success_writes_real_flags_and_is_not_replayed(self):
        api=API();cfg=self.config();api.flags['hq']=False;obs=s.observe_source(api,api.ids,[]);state={'idle_qualified':True,'idle_key':obs['stability_key'],'idle_sample_at':time.time()}
        req=s.freeze_source(cfg,api,state,target_ready=True);self.assertFalse(any(api.flags.values()));self.assertFalse(req['original_runner_enabled']['hq']);self.assertTrue(req['target_prepared']);self.assertRegex(req['request_id'],r'^[A-Za-z0-9_-]{1,80}$')
        count=len([c for c in api.calls if c[0]=='PATCH']);self.assertEqual(s.freeze_source(cfg,api,state,target_ready=True)['request_id'],req['request_id']);self.assertEqual(len([c for c in api.calls if c[0]=='PATCH']),count)
    def final_fixture(self):
        cfg=self.config();cfg['source_data_root']='/source/data';cfg['release_manifest']=str(self.root/'release.json')
        s.private_json(cfg['release_manifest'],{'supported_schema':33,'source_sha':'a'*40})
        req={'request_id':'final-test','source_frozen':True,'target_prepared':True,'original_runner_enabled':{'hq':True,'project':True},'source_freeze_receipt':'SOURCE_FROZEN.json'}
        s.private_json(self.root/'EXPORT_REQUEST.json',req);s.private_json(self.root/'SOURCE_FROZEN.json',{'phase':'frozen','request_id':'final-test','before':{'schema':{'version':33}}})
        incoming=self.root/'incoming/final-final-test';incoming.mkdir(parents=True)
        db=sqlite3.connect(incoming/'iamceo.db');db.execute('PRAGMA user_version=33');db.execute('CREATE TABLE projects(id,runner_enabled,archived)');db.executemany('INSERT INTO projects VALUES (?,0,0)',[('hq',),('project',)])
        db.execute('CREATE TABLE messages(delivery)');db.execute('CREATE TABLE attachments(path,size)');db.execute("INSERT INTO attachments VALUES ('/source/data/uploads/a',3)")
        for t in ['members','tasks','decisions','files']:db.execute('CREATE TABLE '+t+'(id)')
        db.commit();counts={t:db.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ['projects','members','messages','tasks','decisions','files','attachments']};db.close()
        for n in ['IAMCEO.bundle','god.bundle','god-files.tar.gz','worktree-wip.tar.gz','worktree-wip.json']:(incoming/n).write_bytes(b'fixture')
        with tarfile.open(incoming/'iamceo-runtime.tar.gz','w:gz') as tar:
            info=tarfile.TarInfo('uploads/a');info.size=3;tar.addfile(info,io.BytesIO(b'abc'))
        ready={'kind':'final','request_id':'final-test','cutover_allowed':True,'freeze_receipt':req,'incoming_directory':str(incoming),'files':{p.name:{'bytes':p.stat().st_size,'sha256':s.digest(p)} for p in incoming.iterdir()},'db_user_version':33,'db_counts':counts,'upload_inventory':[{'path':'uploads/a','bytes':3,'sha256':hashlib.sha256(b'abc').hexdigest()}]}
        s.private_json(self.root/'CUTOVER_READY.json',ready);return cfg,ready
    def test_final_verifier_requires_matching_snapshot_schema_and_upload_hash(self):
        cfg,ready=self.final_fixture();result=s.verify_final(cfg);self.assertEqual(result['schema'],33);self.assertEqual(result['verified_upload_files'],1);self.assertFalse(result['operational_activation'])
        ready['upload_inventory'][0]['sha256']='0'*64;s.private_json(self.root/'CUTOVER_READY.json',ready)
        with self.assertRaises(ValueError):s.verify_final(cfg)
    def test_final_verifier_refuses_initial_or_incompatible_schema(self):
        cfg,ready=self.final_fixture();ready['kind']='initial-preparation-only';s.private_json(self.root/'CUTOVER_READY.json',ready)
        with self.assertRaises(ValueError):s.verify_final(cfg)
        ready['kind']='final';s.private_json(self.root/'CUTOVER_READY.json',ready);s.private_json(cfg['release_manifest'],{'supported_schema':32,'source_sha':'b'*40})
        with self.assertRaises(ValueError):s.verify_final(cfg)
    def test_final_verifier_refuses_schema_different_from_freeze_observation(self):
        cfg,ready=self.final_fixture();frozen=s.read_json(self.root/'SOURCE_FROZEN.json');frozen['before']['schema']['version']=32;s.private_json(self.root/'SOURCE_FROZEN.json',frozen)
        with self.assertRaises(ValueError):s.verify_final(cfg)
    def test_target_proof_must_match_binary_schema_build_and_unchanged_evidence(self):
        cfg=self.config();release_dir=self.root/'release';release_dir.mkdir();binary=release_dir/'iamceo';binary.write_bytes(b'fixture binary');cfg['release_manifest']=str(release_dir/'release.json')
        release={'production_eligible':True,'source_sha':'a'*40,'binary_sha256':s.digest(binary),'supported_schema':33};s.private_json(cfg['release_manifest'],release)
        proof=self.root/'proof';proof.write_text('validated fixture');checks={name:{'passed':True,'evidence_file':str(proof),'evidence_sha256':s.digest(proof)} for name in s.REQUIRED_TARGET}
        receipt={'kind':'target-precutover-validation','verified':True,'source_sha':release['source_sha'],'supported_schema':33,'source_runtime_build_id':'build-fixture','checks':checks};s.private_json(self.root/'TARGET_PRECUTOVER_VALIDATED.json',receipt)
        obs={'conditions':dict.fromkeys(['claude_authenticated','codex_authenticated','domain_ready','target_server','target_authenticated_readiness'],True),'source':{'schema':{'version':33},'runtime_build_id':'build-fixture'}};obs['conditions']['baseline_services']={'fixture':True}
        self.assertTrue(s.target_prepared(cfg,obs));release['production_eligible']=False;s.private_json(cfg['release_manifest'],release);self.assertFalse(s.target_prepared(cfg,obs));release['production_eligible']=True;s.private_json(cfg['release_manifest'],release)
        obs['source']['schema']['version']=34;self.assertFalse(s.target_prepared(cfg,obs));obs['source']['schema']['version']=33;obs['source']['runtime_build_id']='different-build';self.assertFalse(s.target_prepared(cfg,obs));obs['source']['runtime_build_id']='build-fixture';proof.write_text('changed after verification');self.assertFalse(s.target_prepared(cfg,obs))
    def test_private_bridge_probe_authenticates_but_never_follows_redirects(self):
        import http.server,threading
        seen=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path,self.headers.get('Authorization')))
                if self.path=='/redirect':self.send_response(302);self.send_header('Location','/forwarded');self.end_headers();return
                self.send_response(200 if self.headers.get('Authorization')=='Bearer fixture-only-token' else 401);self.end_headers()
            def log_message(self,*args):pass
        server=http.server.HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            token=self.root/'token';token.write_text('fixture-only-token');url='http://127.0.0.1:'+str(server.server_port)
            self.assertTrue(s.baseline_probe({'url':url+'/services','token_file':str(token)}));self.assertFalse(s.baseline_probe({'url':url+'/redirect','token_file':str(token)}));self.assertFalse(any(path=='/forwarded' for path,auth in seen))
        finally:server.shutdown();server.server_close();thread.join()
    def test_active_target_blocks_rollback(self):
        api=API();cfg=self.config();(self.root/'TARGET_ACTIVATED.json').write_text('{"activated":true}')
        with self.assertRaises(ValueError):s.rollback_source(cfg,api,{'original_runner_enabled':{'hq':True},'changed':['hq']})
        self.assertFalse(api.calls)

if __name__=='__main__':unittest.main()
