import os, sqlite3, json, re, collections
from pathlib import Path

c = sqlite3.connect('file:' + os.path.join(os.environ['IAMCEO_HOME'], 'iamceo.db') + '?mode=ro', uri=True)
c.row_factory = sqlite3.Row
p = 'p_FNZgzhT5P7i3'
chief = 'm_Mc4lCnMulELf'
a = '2026-11-12T11:26:06.000Z'
b = '2026-11-13T11:26:06.000Z'
def q(sql, args=()):
    return [dict(r) for r in c.execute(sql, args)]

ms = q('select id,member_id,mine,kind,at,task_id from messages where project_id=? and at>=? and at<?', (p,a,b))
runs = q('select run_id,member_id,created_at,ended_at,report_requested_at,delivery_ids_json from execution_journal where project_id=? and created_at>=? and created_at<?', (p,a,b))
ds = q('select id,member_id,kind,wake,text,ref_type,ref_id,created_at,attempts from deliveries where project_id=? and created_at>=? and created_at<?', (p,a,b))
supplements = [d for d in ds if re.search(r'보고 보완: 실행 [0-9a-f-]+', d['text'])]
within = []
requested = []
for r in runs:
    posts = [m for m in ms if m['member_id']==r['member_id'] and r['created_at']<=m['at']<=(r['ended_at'] or b) and not m['mine']]
    ins = []
    for did in json.loads(r['delivery_ids_json']):
        d = c.execute('select id,kind,wake,text,ref_type,ref_id from deliveries where id=?',(did,)).fetchone()
        if d: ins.append(dict(d))
    if r['report_requested_at'] and r['report_requested_at'] < b:
        requested.append({'run':r['run_id'], 'member':r['member_id'], 'post_kinds':[m['kind'] for m in posts]})
    if any('보고 보완: 실행 ' in d['text'] for d in ins):
        waking = [d for d in ins if d['wake']]
        within.append({'run':r['run_id'], 'member':r['member_id'], 'posts':[m['id'] for m in posts],
            'post_kinds':[m['kind'] for m in posts], 'rerequest':bool(r['report_requested_at'] and r['report_requested_at']<b),
            'only_waking_is_supplement':all('보고 보완: 실행 ' in d['text'] for d in waking),
            'nonwake_extras':sum(not d['wake'] and '보고 보완: 실행 ' not in d['text'] for d in ins)})

counts = {}
counts['window'] = {'start_utc_inclusive':a, 'end_utc_exclusive':b, 'kst':'2026-11-12 20:26:06 ~ 2026-11-13 20:26:06 (24시간)'}
counts['timeline'] = {'total':len(ms), 'user':sum(x['mine'] for x in ms), 'by_kind':dict(collections.Counter(x['kind'] for x in ms)),
    'chief':sum(x['member_id']==chief and not x['mine'] for x in ms), 'worker':sum(x['member_id'] not in [None,chief] and not x['mine'] for x in ms)}
counts['runs'] = {'total_started':len(runs), 'ended':sum(bool(x['ended_at'] and x['ended_at']<b) for x in runs), 'with_report_request':len(requested)}
counts['internal_deliveries'] = {'total_created':len(ds), 'by_kind':dict(collections.Counter(x['kind'] for x in ds)), 'missing_report_created':len(supplements),
    'same_target_run_duplicates':len(supplements)-len({re.search(r'보고 보완: 실행 ([0-9a-f-]+)',x['text']).group(1) for x in supplements})}
counts['push_events_by_kind'] = q('select kind,count(*) n from push_events where project_id=? and occurred_at>=? and occurred_at<? group by kind',(p,a,b))
counts['push_delivery_states'] = q('select d.state,count(*) n from push_deliveries d join push_events e on d.event_id=e.id where e.project_id=? and e.occurred_at>=? and e.occurred_at<? group by d.state',(p,a,b))
counts['duplicate_delivery_reference_groups'] = q('select member_id,kind,ref_type,ref_id,count(*) n from deliveries where project_id=? and created_at>=? and created_at<? and ref_id is not null group by member_id,kind,ref_type,ref_id having count(*)>1',(p,a,b))
counts['mac_notify_current'] = tuple(c.execute("select value from settings where key='notifyMac'").fetchone() or ())
cs = [x for x in within if x['member']==chief and x['only_waking_is_supplement']]
counts['candidate_reductions'] = {'chief_supplement_only_wake_runs':len(cs), 'posts_from_those_runs':sum(len(x['posts']) for x in cs),
    'retrigger_runs':sum(x['rerequest'] for x in cs), 'with_nonwake_extra_and_rerequest':sum(x['rerequest'] and x['nonwake_extras']>0 for x in cs)}
counts['requested_runs_with_qualifying_post'] = sum(any(k in ['완료','답변','막힘','질문'] for k in x['post_kinds']) for x in requested)
counts['chief_requested_with_alert_only'] = sum(x['member']==chief and x['post_kinds']==['알림'] for x in requested)
counts['chief_requested_total'] = sum(x['member']==chief for x in requested)
Path('docs/research/notification-audit-2026-11-13/counts.json').write_text(json.dumps(counts,ensure_ascii=False,indent=2))
Path('docs/research/notification-audit-2026-11-13/supplement-analysis.json').write_text(json.dumps({'requested':requested,'followups':within},ensure_ascii=False,indent=2))
print(json.dumps(counts,ensure_ascii=False,indent=2))
