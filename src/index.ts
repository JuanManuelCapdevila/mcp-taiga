#!/usr/bin/env node
/**
 * MCP server for the Taiga project management API.
 *
 * Authenticates as a single Taiga user (TAIGA_USERNAME/TAIGA_PASSWORD) and exposes
 * tools for projects, user stories, tasks, issues, epics, milestones, memberships,
 * comments and search. Permissions are NOT re-implemented here: every tool call is
 * forwarded to Taiga as-is, so the server can only do what that user's project role
 * already allows — Taiga itself returns a permission error for anything out of scope.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerUserStoryTools } from "./tools/userstories.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerEpicTools } from "./tools/epics.js";
import { registerMilestoneTools } from "./tools/milestones.js";
import { registerMembershipTools } from "./tools/memberships.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerSearchTools } from "./tools/search.js";

function assertEnv(name: string): void {
  if (!process.env[name]) {
    console.error(`ERROR: ${name} environment variable is required.`);
    process.exit(1);
  }
}

assertEnv("TAIGA_USERNAME");
assertEnv("TAIGA_PASSWORD");

const server = new McpServer({
  name: "taiga-mcp-server",
  version: "1.0.0",
});

registerProjectTools(server);
registerUserStoryTools(server);
registerTaskTools(server);
registerIssueTools(server);
registerEpicTools(server);
registerMilestoneTools(server);
registerMembershipTools(server);
registerCommentTools(server);
registerSearchTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Taiga MCP server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
