import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { taigaClient } from "../taigaClient.js";
import { errorResult, handleApiError, textResult, buildListOutput, renderMarkdownList, truncateText } from "../formatting.js";
import { PaginationInputSchema, ProjectRefSchema, ResponseFormat, responseFormatField } from "../schemas/common.js";

/** Resolves a project reference (numeric ID or slug) to a numeric project ID. */
export async function resolveProjectId(ref: number | string): Promise<number> {
  if (typeof ref === "number") return ref;
  if (/^\d+$/.test(ref)) return Number.parseInt(ref, 10);
  const { data } = await taigaClient.request<{ id: number }>("GET", "/projects/by_slug", {
    params: { slug: ref },
  });
  return data.id;
}

interface ProjectSummary {
  id: number;
  name: string;
  slug: string;
  description?: string;
  is_private: boolean;
  total_milestones?: number;
}

interface ProjectDetail extends ProjectSummary {
  is_backlog_activated: boolean;
  is_kanban_activated: boolean;
  is_wiki_activated: boolean;
  is_issues_activated: boolean;
  points: Array<{ id: number; name: string; value: number | null }>;
  severities: Array<{ id: number; name: string }>;
  priorities: Array<{ id: number; name: string }>;
  issue_types: Array<{ id: number; name: string }>;
  issue_statuses: Array<{ id: number; name: string; is_closed: boolean }>;
  user_story_statuses: Array<{ id: number; name: string; is_closed: boolean }>;
  task_statuses: Array<{ id: number; name: string; is_closed: boolean }>;
  epic_statuses: Array<{ id: number; name: string; is_closed: boolean }>;
  members: Array<{ id: number; username: string; full_name_display: string; role_name: string }>;
}

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "taiga_whoami",
    {
      title: "Taiga: Who Am I",
      description:
        "Returns the Taiga user this MCP server is authenticated as, including id, username, email and full name. " +
        "Useful to confirm which account's permissions apply to every other tool call, since this server never acts " +
        "with more access than this user's project roles grant in Taiga.\n\nArgs: none.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const { data } = await taigaClient.request<Record<string, unknown>>("GET", "/users/me");
        return textResult(JSON.stringify(data, null, 2), data);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  const ListProjectsSchema = z
    .object({
      query: z.string().optional().describe("Free-text search over project name/description"),
      member: z.number().int().optional().describe("Filter to projects where this user ID is a member"),
      ...PaginationInputSchema,
      response_format: responseFormatField,
    })
    .strict();

  server.registerTool(
    "taiga_list_projects",
    {
      title: "Taiga: List Projects",
      description:
        "Lists Taiga projects visible to the authenticated user, optionally filtered by free-text search or member. " +
        "Only returns projects the authenticated user can actually see in Taiga (private projects you are not a " +
        "member of will not appear).\n\n" +
        "Args:\n" +
        "  - query (string, optional): free-text search over name/description\n" +
        "  - member (number, optional): filter to projects a given user ID belongs to\n" +
        "  - page (number, default 1), page_size (number, default 25, max 100)\n" +
        "  - response_format ('markdown' | 'json', default 'markdown')\n\n" +
        "Returns: paginated list with id, name, slug, description, is_private, total_milestones per project.\n\n" +
        "Use when: \"what projects do I have access to\" / \"find the project called X\".\n" +
        "Don't use when: you already know the project id/slug (use taiga_get_project directly).",
      inputSchema: ListProjectsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const { data, pagination } = await taigaClient.request<ProjectSummary[]>("GET", "/projects", {
          params: { q: params.query, member: params.member, page: params.page, page_size: params.page_size },
        });
        const output = buildListOutput(data, pagination, params.page, params.page_size);

        let text: string;
        if (params.response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          text = renderMarkdownList("Taiga Projects", output, (p) =>
            [`## ${p.name} (${p.slug})`, `- **ID**: ${p.id}`, p.description ? `- ${p.description}` : undefined, ""]
              .filter(Boolean)
              .join("\n")
          );
        }
        const { text: finalText } = truncateText(text);
        return textResult(finalText, output as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  const GetProjectSchema = z
    .object({
      project: ProjectRefSchema,
      response_format: responseFormatField,
    })
    .strict();

  server.registerTool(
    "taiga_get_project",
    {
      title: "Taiga: Get Project Details",
      description:
        "Fetches full details of a single Taiga project, including which modules are enabled (backlog, kanban, " +
        "wiki, issues), the configured workflow statuses for user stories/tasks/issues/epics, available points, " +
        "priorities, severities, issue types, and project members with their roles. Use this before creating items " +
        "to learn valid status/priority/severity/type IDs for the project.\n\n" +
        "Args:\n" +
        "  - project (number | string, required): numeric project ID or slug\n" +
        "  - response_format ('markdown' | 'json', default 'markdown')\n\n" +
        "Returns: project detail object (see description) or 'Error: Resource not found' if the project does not exist " +
        "or is not visible to the authenticated user.\n\n" +
        "Use when: \"what statuses does project X have\" / \"who is on project X\" / before creating a user story and " +
        "needing a valid status id.",
      inputSchema: GetProjectSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const id = await resolveProjectId(params.project);
        const { data } = await taigaClient.request<ProjectDetail>("GET", `/projects/${id}`);

        let text: string;
        if (params.response_format === ResponseFormat.JSON) {
          text = JSON.stringify(data, null, 2);
        } else {
          const lines = [
            `# ${data.name} (${data.slug})`,
            `ID: ${data.id} | Private: ${data.is_private}`,
            data.description ? `\n${data.description}\n` : "",
            `## Modules`,
            `Backlog: ${data.is_backlog_activated} | Kanban: ${data.is_kanban_activated} | Wiki: ${data.is_wiki_activated} | Issues: ${data.is_issues_activated}`,
            "",
            `## User Story Statuses`,
            ...data.user_story_statuses.map((s) => `- ${s.name} (id: ${s.id}${s.is_closed ? ", closed" : ""})`),
            "",
            `## Task Statuses`,
            ...data.task_statuses.map((s) => `- ${s.name} (id: ${s.id}${s.is_closed ? ", closed" : ""})`),
            "",
            `## Issue Statuses`,
            ...data.issue_statuses.map((s) => `- ${s.name} (id: ${s.id}${s.is_closed ? ", closed" : ""})`),
            "",
            `## Issue Types / Priorities / Severities`,
            `Types: ${data.issue_types.map((t) => `${t.name} (${t.id})`).join(", ") || "none"}`,
            `Priorities: ${data.priorities.map((t) => `${t.name} (${t.id})`).join(", ") || "none"}`,
            `Severities: ${data.severities.map((t) => `${t.name} (${t.id})`).join(", ") || "none"}`,
            "",
            `## Members`,
            ...data.members.map((m) => `- ${m.full_name_display} (@${m.username}, id: ${m.id}) — ${m.role_name}`),
          ];
          text = lines.join("\n");
        }
        const { text: finalText } = truncateText(text);
        return textResult(finalText, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );
}
