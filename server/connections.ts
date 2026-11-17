import { userInfo } from "node:os";
import { z } from "zod";
import type { ConnectionInfo } from "../shared/types.ts";
import { readConnectionConfig, validSshHost, validSshUser, type Config } from "./config.ts";

export const ConnectionPatchSchema = z.object({
  sshHost: z.string().refine(validSshHost).nullable().optional(),
  sshUser: z.string().refine(validSshUser).nullable().optional(),
  sshPort: z.number().int().min(1).max(65535).nullable().optional(),
}).strict().refine(patch => Object.keys(patch).length > 0);

/** The accepted incoming Host survives loopback reverse proxies and follows renamed Tailnet hosts. */
export function connectionInfo(config: Config, authority: string, cli: string, port: number): ConnectionInfo {
  const overrides = readConnectionConfig(config);
  const host = new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, "");
  if (!validSshHost(host)) throw new Error("터미널 접속 주소를 확인할 수 없습니다");
  return { home: config.home, port, cli, ssh: {
    host: overrides.sshHost ?? host,
    user: overrides.sshUser ?? userInfo().username,
    port: overrides.sshPort ?? 22,
  } };
}
