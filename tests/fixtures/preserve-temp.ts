// Keep fixture roots for this recovery task; tests may still remove individual inputs.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const remove = fs.rmSync;
fs.rmSync = ((path, options) => {
  if (options?.recursive && /^\/(?:private\/)?(?:tmp|var\/folders\/[^/]+\/[^/]+\/T)\/(?:iq-|iamceo-)[^/]+$/.test(String(path))) return;
  return remove(path, options);
}) as typeof fs.rmSync;
syncBuiltinESMExports();
