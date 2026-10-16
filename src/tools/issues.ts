import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { taigaClient } from "../taigaClient.js";
import { errorResult, handleApiError, textResult, truncateText } from "../formatting.js";
import { ProjectRefSchema } from "../schemas/common.js";
import { registerListTool, registerGetTool, registerDeleteTool, RefLookupFields, requireIdOrRef, resolveRefId } from "./crudFactory.js";
import { resolveProjectId } from "./projects.js";

const RESOURCE_PATH = "/issues";

interface IssueSummary {
  id: number;
  ref: number;
  subject: string;
  status_extra_info?: { name: string };
  assigned_to_extra_info?: { full_name_display: string } | null;
  type_extra_info?: { name: string };
  priority_extra_info?: { name: string };
  severity_extra_info?: { name: string };
}

interface IssueDetail extends IssueSummary {
  description: string;
  project: number;
  version: number;
  milestone: number | null;
}

function renderListItem(item: IssueSummary): string {
  const status = item.status_extra_info?.name ?? "unknown";
  const assignee = item.assigned_to_extra_info?.full_name_display ?? "unassigned";
  const type = item.type_extra_info?.name ?? "n/a";
  const priority = item.priority_extra_info?.name ?? "n/a";
  const severity = item.severity_extra_info?.name ?? "n/a";
  return `## Issue #${item.ref}: ${item.subject}\n- **ID**: ${item.id} | **Status**: ${status} | **Type**: ${type} | **Priority**: ${priority} | **Severity**: ${severity} | **Assigned to**: ${assignee}\n`;
}

function renderDetail(item: IssueDetail): string {
  return [
    `# Issue #${item.ref}: ${item.subject}`,
    `ID: ${item.id} | Project: ${item.project} | Status: ${item.status_extra_info?.name ?? "unknown"}`,
    `Type: ${item.type_extra_info?.name ?? "n/a"} | Priority: ${item.priority_extra_info?.name ?? "n/a"} | Severity: ${item.severity_extra_info?.name ?? "n/a"}`,
    `Assigned to: ${item.assigned_to_extra_info?.full_name_display ?? "unassigned"}`,
    "",
    item.description || "_No description._",
  ].join("\n");
}

export function registerIssueTools(server: McpServer): void {
  registerListTool<IssueSummary>(server, {
    toolName: "taiga_list_issues",
    title: "Taiga: List Issues",
    resourcePath: RESOURCE_PATH,
    markdownTitle: "Issues",
    renderItem: renderListItem,
    extraFilters: {
      status: z.number().int().optional().describe("Filter by status ID"),
      type: z.number().int().optional().describe("Filter by issue type ID"),
      priority: z.number().int().optional().describe("Filter by priority ID"),
      severity: z.number().int().optional().describe("Filter by severity ID"),
      assigned_to: z.number().int().optional().describe("Filter by assignee user ID"),
      milestone: z.number().int().optional().describe("Filter by sprint/milestone ID"),
      tags: z.string().optional().describe("Filter by comma-separated tags"),
    },
    buildFilterParams: (f) => f,
    description:
      "Lists issues (bugs/questions/enhancements) in a Taiga project, optionally filtered by status, type, " +
      "priority, severity, assignee, sprint or tags.\n\n" +
      "Args:\n" +
      "  - project (number | string, required)\n" +
      "  - status, type, priority, severity, assigned_to, milestone, tags (optional filters)\n" +
      "  - page, page_size, response_format\n\n" +
      "Returns: paginated list of issues with ref, subject, status, type, priority, severity, assignee.\n\n" +
      "Use when: \"what critical bugs are open in project X\" / \"list issues assigned to me\".",
  });

  registerGetTool<IssueDetail>(server, {
    toolName: "taiga_get_issue",
    title: "Taiga: Get Issue",
    resourcePath: RESOURCE_PATH,
    renderDetail,
    description:
      "Fetches full details of a single issue: description, status, type, priority, severity, assignee.\n\n" +
      "Args: EITHER 'id' (internal numeric ID) OR BOTH 'project' and 'ref' (the number shown as 'Issue #15' in the UI).\n\n" +
      "Returns: full issue object.\n\n" +
      "Use when: you need the full description or current triage of a specific issue.",
  });

  const CreateSchema = z
    .object({
      project: ProjectRefSchema,
      subject: z.string().min(1).max(500).describe("Title of the issue"),
      description: z.string().optional(),
      status: z.number().int().optional().describe("Status ID; defaults to the project's initial issue status"),
      type: z.number().int().optional().describe("Issue type ID (see taiga_get_project)"),
      priority: z.number().int().optional().describe("Priority ID (see taiga_get_project)"),
      severity: z.number().int().optional().describe("Severity ID (see taiga_get_project)"),
      assigned_to: z.number().int().optional().describe("User ID to assign this issue to"),
      milestone: z.number().int().optional().describe("Sprint/milestone ID"),
      tags: z.array(z.string()).optional(),
    })
    .strict();

  server.registerTool(
    "taiga_create_issue",
    {
      title: "Taiga: Create Issue",
      description:
        "Creates a new issue (bug/question/enhancement) in a Taiga project. Requires the 'add_issue' permission.\n\n" +
        "Args:\n" +
        "  - project (number | string, required), subject (string, required)\n" +
        "  - description, status, type, priority, severity, assigned_to, milestone, tags (all optional)\n\n" +
        "Returns: the created issue object with its new 'ref' and 'id'.\n\n" +
        "Use when: \"file a bug about X in project Y\" / \"report an issue\".",
      inputSchema: CreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const projectId = await resolveProjectId(params.project);
        const { data } = await taigaClient.request<IssueDetail>("POST", RESOURCE_PATH, {
          data: { ...params, project: projectId },
        });
        const { text } = truncateText(`Created Issue #${data.ref}: ${data.subject} (id: ${data.id})`);
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  const UpdateSchema = z
    .object({
      ...RefLookupFields,
      subject: z.string().min(1).max(500).optional(),
      description: z.string().optional(),
      status: z.number().int().optional(),
      type: z.number().int().optional(),
      priority: z.number().int().optional(),
      severity: z.number().int().optional(),
      assigned_to: z.number().int().nullable().optional(),
      milestone: z.number().int().nullable().optional(),
      tags: z.array(z.string()).optional(),
      comment: z.string().optional().describe("Adds this text as a new comment on the issue"),
    })
    .strict()
    .superRefine(requireIdOrRef);

  server.registerTool(
    "taiga_update_issue",
    {
      title: "Taiga: Update Issue",
      description:
        "Updates fields of an existing issue (status, triage, assignee) and/or adds a comment. Automatically " +
        "handles optimistic-concurrency versioning. Requires the 'modify_issue' permission.\n\n" +
        "Args: EITHER 'id' OR BOTH 'project' and 'ref', plus any fields to change.\n\n" +
        "Returns: the updated issue object.\n\n" +
        "Use when: \"close Issue #15\" / \"bump the priority of Issue #15\" / \"comment on Issue #15\".",
      inputSchema: UpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const id = await resolveRefId(RESOURCE_PATH, params);
        const { id: _id, project: _project, ref: _ref, ...fields } = params;
        const { data } = await taigaClient.patchWithVersion<IssueDetail>(RESOURCE_PATH, id, fields);
        const { text } = truncateText(`Updated Issue #${data.ref}: ${data.subject}`);
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  registerDeleteTool(server, {
    toolName: "taiga_delete_issue",
    title: "Taiga: Delete Issue",
    resourcePath: RESOURCE_PATH,
    singularName: "issue",
    description:
      "Permanently deletes an issue from Taiga. Cannot be undone. Requires the 'delete_issue' permission.\n\n" +
      "Args: EITHER 'id' OR BOTH 'project' and 'ref'.\n\n" +
      "Returns: confirmation message.\n\n" +
      "Use when: explicitly asked to delete an issue. Don't use for closing an issue — update its status instead.",
  });
}
