import { openDb } from "./server/db.ts";
const [path, mode] = process.argv.slice(2);
try {
  const db = openDb(path);
  const v = (db.query("PRAGMA user_version").get() as any).user_version;
  const ic = (db.query("PRAGMA integrity_check").all() as any[]).map(r => r.integrity_check).join(",");
  const fk = db.query("PRAGMA foreign_key_check").all().length;
  const counts = Object.fromEntries(["messages","tasks","decisions","files","members","projects","attachments"].map(t => [t, (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n]));
  const last = (db.query("SELECT MAX(at) AS m FROM messages").get() as any).m;
  let extra: any = {};
  if (mode === "new") {
    const { Store } = await import("./server/store.ts");
    const { EventBus } = await import("./server/bus.ts").then(m => ({ EventBus: m.Bus }));
    try {
      const s = new Store(db, EventBus ? new EventBus() : ({ emit() {}, publish() {} } as any));
      const st = s.getSettings();
      extra = { harnessMode: st.harnessMode, harnessRequiredSince: st.harnessRequiredSince, backend: st.backend, permissionMode: st.permissionMode };
    } catch (e) { extra = { storeError: (e as Error).message }; }
  }
  db.close();
  console.log(JSON.stringify({ ok: true, user_version: v, integrity: ic, foreign_key_violations: fk, counts, last_message_at: last, ...extra }));
} catch (e) { console.log(JSON.stringify({ ok: false, error: (e as Error).message })); }
