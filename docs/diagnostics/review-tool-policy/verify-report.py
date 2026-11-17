"""Validate diagnostic evidence and standalone documents, without network or runtime data."""
from pathlib import Path
from html.parser import HTMLParser
import json
root=Path(__file__).resolve().parent
meta=json.loads((root/"observations.json").read_text())
cli=json.loads((root/"synthetic-codex-results.json").read_text())
server=json.loads((root/"synthetic-server-results.json").read_text())
md=(root/"report.md").read_text().replace("\\|","|")
html=(root/"report.html").read_text()
error="MCP tool call requires approval, but approval policy is never"
assert cli["sourceSha"]==meta["source"]["sha"]==meta["source"]["registeredReleasePathSha"]
assert cli["binaryVersion"]=="0.167.0"
assert cli["verification"]=={"restrictionsPreserved":True,"baselineDeniedBeforeMcp":True,"candidateAllowedMcp":True}
assert cli["operationalCalls"]==0 and cli["realModelRequests"]==0 and cli["fixtureRootsPreserved"]
a,b=cli["conditions"]
assert a["callCount"]==0 and a["errors"]==[error,error]
assert b["callCount"]==2 and b["errors"]==[]
assert {c["name"] for c in b["calls"]}=={"post","task_review_evidence"}
for row in (a,b):
 assert row["policy"]=={"askForApproval":"never","sandbox":"read-only","shellDisabled":True,"externalDisabled":True}
 assert row["forbiddenTools"]==[] and row["externalStarted"] is False
assert server["syntheticOnly"] and server["liveCalls"]==0 and server["annotationsPresent"] is False
assert server["designatedPostRead"]["ok"] and server["ordinaryPostRead"]["ok"]
assert server["designatedEvidence"]=={"ok":True,"evidenceReaderUpdated":True}
assert server["designatedDecision"]["ok"] and server["forbiddenPost"]["noNewPosts"]
assert server["humanApproval"]["reviewDenied"] and server["humanApproval"]["decisionStillOpen"]
assert set(server["tools"])=={"status","task_trace","post","task_review","task_review_evidence"}
assert len(meta["targets"])==4 and all(t["finalReview"]=="pending" and t["completionEligible"] for t in meta["targets"])
assert meta["liveObservation"]["literalErrorIndependentlyRead"] is False
assert meta["liveObservation"]["bridgeCallArrivalIndependentlyRead"] is False
external=meta["externalReviewReport"]
assert external["reportId"]=="msg_joLOlvnUy3GJ"
assert external["literalError"]==error and external["literalErrorReadFromReport"]
assert external["authoredAt"]=="2026-11-17T22:03:06.311Z" and external["sequence"]==1209
assert not external["newSyntheticExecution"] and not external["liveRecoveryApplied"]
assert external["bridgeArrival"].startswith("unverified:")
assert len(external["quotes"])==3
assert len(meta["remainingUnverified"])==4
class Offline(HTMLParser):
 def __init__(self):
  super().__init__(); self.parts=[]; self.h2=0
 def handle_starttag(self,tag,attrs):
  assert tag not in {"script","link","iframe","object","embed"}
  self.h2+=tag=="h2"
  for name,value in attrs:
   assert not name.startswith("on")
   if name in {"src","href"}: assert value==meta["officialDoc"]["url"]
 def handle_data(self,s): self.parts.append(s)
p=Offline(); p.feed(html); visible=" ".join(p.parts)
assert p.h2==7 and "@import" not in html and "url(" not in html
tokens=[error,meta["source"]["sha"],meta["source"]["registeredBinaryBuildId"],
        meta["officialDoc"]["url"],"06:39","미확인","20 expectations","msg_joLOlvnUy3GJ","msg_MIZPFwVIlBux","f_WFX4ivF2m0mP",
        "06:55:53","06:57:04","tools/call","/agent/tool",
        *[t["reportId"] for t in meta["targets"]],*[c["command"] for c in meta["commands"]]]
for token in tokens:
 assert token in md,("markdown",token)
 assert token in visible or token==meta["officialDoc"]["url"] and token in html,("html",token)
for quote in external["quotes"]:
 assert quote in md and quote in visible,quote
for tool in server["tools"]:
 flag='mcp_servers.iamceo.tools.'+tool+'.approval_mode="approve"'
 assert flag in md and flag in visible
print("PASS: Codex call0/2, exact errors, never/read-only and shell/MCP restrictions preserved")
print("PASS: synthetic server roles and open human decision protected; external live error matched; per-call server arrival remains unverified")
print("PASS: seven sections, standalone HTML/Markdown parity, four fixed reports and registered release")
