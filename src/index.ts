#!/usr/bin/env node
/**
 * MCP server for the Taiga project management API.
 *
 * Authenticates as a single Taiga user (TAIGA_API_URL/TAIGA_USERNAME/TAIGA_PASSWORD) and
 * exposes tools for projects, user stories, tasks, issues, epics, milestones, memberships,
 * comments and search. Permissions are NOT re-implemented here: every tool call is
 * forwarded to Taiga as-is, so the server can only do what that user's project role
 * already allows — Taiga itself returns a permission error for anything out of scope.
 *
 * Supports two transports, selected via TRANSPORT:
 *   - "stdio" (default): for local clients (Claude Desktop/Code) that spawn this as a subprocess.
 *   - "http": for remote clients (e.g. a ChatGPT custom connector) over Streamable HTTP.
 *     Requires MCP_BEARER_TOKEN; requests must send `Authorization: Bearer <token>`.
 */
import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerUserStoryTools } from "./tools/userstories.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerEpicTools } from "./tools/epics.js";
import { registerMilestoneTools } from "./tools/milestones.js";
import { registerMembershipTools } from "./tools/memberships.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerSearchTools } from "./tools/search.js";

function assertEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: ${name} environment variable is required.`);
    process.exit(1);
  }
  return value;
}

assertEnv("TAIGA_API_URL");
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

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Taiga MCP server running via stdio");
}

async function runHttp(): Promise<void> {
  const bearerToken = assertEnv("MCP_BEARER_TOKEN");
  const port = Number.parseInt(process.env.PORT || "3000", 10);

  const app = express();
  app.use(express.json());

  function requireBearerToken(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || token !== bearerToken) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  // Unauthenticated health check for the host platform's readiness probe.
  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

  app.post("/mcp", requireBearerToken, async (req, res) => {
    // Stateless transport: a fresh instance per request avoids cross-request id collisions.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => {
    console.error(`Taiga MCP server running via Streamable HTTP on port ${port} (POST /mcp)`);
  });
}

const transportMode = process.env.TRANSPORT || "stdio";
const main = transportMode === "http" ? runHttp : runStdio;

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
