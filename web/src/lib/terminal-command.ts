import type { ConnectionInfo, Member } from "@shared/types";

const quote = (value: string) => /^[A-Za-z0-9_\-./:=@]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

export function isLocalTerminalHost(host: string): boolean {
  const plain = host.toLowerCase().replace(/^\[|\]$/g, "");
  return plain === "localhost" || plain === "::1" || /^127\.\d+\.\d+\.\d+$/.test(plain);
}

/** Pin the data home before attaching; remote callers run the entire command on the server. */
export function terminalCommand(member: Member, connection: ConnectionInfo, local: boolean): string {
  const env = `env IAMCEO_HOME=${quote(connection.home)} IAMCEO_PORT=${connection.port}`;
  let command: string;
  if (member.backend === "core" && member.paneId) command = `${env} ${connection.cli} attach ${quote(member.id)}`;
  else {
    if (!member.sessionId) throw new Error("열 수 있는 터미널이 없습니다");
    const provider = member.cli === "codex" ? "codex resume" : member.cli === "antigravity" ?
      `agy ${quote(`--gemini_dir=${connection.home}/antigravity/${member.id}`)} --conversation` : "claude --resume";
    command = `cd ${quote(member.cwd)} && ${env} ${provider} ${quote(member.sessionId)}`;
  }
  if (local) return command;
  return `ssh -t -p ${connection.ssh.port} -- ${quote(`${connection.ssh.user}@${connection.ssh.host}`)} ${quote(command)}`;
}
