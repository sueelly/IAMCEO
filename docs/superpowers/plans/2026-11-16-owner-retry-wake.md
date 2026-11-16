# Explicit owner retry of passive notifications

Goal: An owner recheck of a proven pre-write rejection must attempt the same delivery even when its original notification did not wake a worker. Keep ordinary passive notifications passive and preserve all admission and uncertain-write guards.

Evidence: All four live projects use Core, global turn limit is seven, and the God conductor processes new reports. One conductor notification and one foundation instruction remained held after five pre-write refusals. The existing version-checked owner recheck resumed the foundation instruction, with an exact input receipt, while the conductor notification became queued without waking its idle session. The pump requires a wake delivery.

Plan:
- Reproduce the explicit non-wake retry in the isolated Core lifecycle fixture in both the original and another project; ordinary non-wake traffic must stay passive.
- Promote only the qualified explicit owner recheck to a wake delivery in its existing transaction. Preserve ID, text, marker, version checks, retry allowance and normal admission.
- Run relevant recovery/lifecycle/HTTP and queue safety checks, typecheck and compile on the Mini. Verify the existing source runtime separately without restarting source providers or source web service.
- Commit, normally push the task branch and compare remote SHA. Hand off the patch to the existing migration workflow, keeping runtime receipts and credentials outside Git.

## Verification and operational recovery

- Both project fixtures reproduced the passive owner-retry stall without the wake promotion (0 pass, 2 fail); with the patch, both pass and repeated operation IDs produce no second input. The second project explicitly uses the fixture's Claude provider so its fake composer is representative.
- Related lifecycle, delivery recovery, delivery HTTP, Core runner and operations HTTP suites: 214 pass, 0 fail across five files. Typecheck and native compile pass. The initial typecheck caught a possibly undefined test marker variable; its explicit array type was corrected, then typecheck and the two focused cases passed again.
- Independent read-only review found no Critical/Important blockers. The wake promotion only occurs after the existing owner-retry eligibility and recovery version checks; ordinary state changes preserve wake, and the update shares the recovery transaction.
- Live source recovery used the existing version-checked recheck API once per held delivery, without a source restart, provider interruption, approval answer, input clearing or duplicate-risk override. Foundation received its exact existing delivery at 09:39:34 UTC and ended successfully at 09:42:04 UTC. Its report woke the conductor; the conductor received both the report and its original passive delivery at 09:41:55 UTC. Both queues were zero, with no outstanding God delivery notices, in the 09:45:34 UTC observation.
- This is not a claim that every project is healthy: the all-project audit found other old exhausted retries, offline sessions and one unknown-status session. No unrelated pending work was silently retried or discarded.
- The source still runs the previous 430a88a web build. This preventive code change is validated on the Mini and handed off for integration; it has not restarted the source service or activated staff from the read-only Mini snapshot. The explicit user instruction to keep source work intact remains in force.
