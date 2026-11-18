// Local stand-in for the three IAMCEO calls requested by the native Codex policy test.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "node:fs";

const server = new Server({ name: "iamceo", version: "fixture" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["post", "team_assign", "team_stop"].map(name => ({ name, inputSchema: { type: "object" } })),
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  appendFileSync(process.argv[2]!, request.params.name + "\n");
  return { content: [{ type: "text", text: request.params.name }] };
});
await server.connect(new StdioServerTransport());
