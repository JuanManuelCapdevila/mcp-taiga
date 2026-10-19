import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { taigaClient } from "../taigaClient.js";
import { errorResult, handleApiError, textResult, truncateText } from "../formatting.js";
import { ProjectRefSchema } from "../schemas/common.js";
import { registerListTool, registerGetTool, registerDeleteTool, RefLookupFields, requireIdOrRef, resolveRefId } from "./crudFactory.js";
import { resolveProjectId } from "./projects.js";

const RESOURCE_PATH = "/userstories";

interface UserStorySummary {
  id: number;
  ref: number;
  subject: string;
  status_extra_info?: { name: string };
  assigned_to_extra_info?: { full_name_display: string } | null;
  milestone_extra_info?: { name: string } | null;
  swimlane?: number | null;
  tags: [string, string | null][] | string[];
  is_blocked: boolean;
}

interface UserStoryDetail extends UserStorySummary {
  description: string;
  project: number;
  version: number;
  points: Record<string, number | null>;
  due_date: string | null;
  blocked_note: string;
  created_date: string;
  modified_date: string;
}

function renderListItem(item: UserStorySummary): string {
  const status = item.status_extra_info?.name ?? "unknown";
  const assignee = item.assigned_to_extra_info?.full_name_display ?? "unassigned";
  const milestone = item.milestone_extra_info?.name ?? "no sprint";
  return `## US #${item.ref}: ${item.subject}\n- **ID**: ${item.id} | **Status**: ${status} | **Assigned to**: ${assignee} | **Sprint**: ${milestone}${item.is_blocked ? " | ⛔ BLOCKED" : ""}\n`;
}

function renderDetail(item: UserStoryDetail): string {
  return [
    `# US #${item.ref}: ${item.subject}`,
    `ID: ${item.id} | Project: ${item.project} | Status: ${item.status_extra_info?.name ?? "unknown"}`,
    item.is_blocked ? `⛔ BLOCKED: ${item.blocked_note}` : "",
    `Assigned to: ${item.assigned_to_extra_info?.full_name_display ?? "unassigned"}`,
    `Sprint: ${item.milestone_extra_info?.name ?? "none"}`,
    `Swimlane ID: ${item.swimlane ?? "none"}`,
    `Due date: ${item.due_date ?? "none"}`,
    "",
    item.description || "_No description._",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function registerUserStoryTools(server: McpServer): void {
  registerListTool<UserStorySummary>(server, {
    toolName: "taiga_list_user_stories",
    title: "Taiga: List User Stories",
    resourcePath: RESOURCE_PATH,
    markdownTitle: "User Stories",
    renderItem: renderListItem,
    extraFilters: {
      status: z.number().int().optional().describe("Filter by status ID (see taiga_get_project for valid IDs)"),
      milestone: z.number().int().optional().describe("Filter by sprint/milestone ID"),
      assigned_to: z.number().int().optional().describe("Filter by assignee user ID"),
      tags: z.string().optional().describe("Filter by a comma-separated list of tags"),
      epic: z.number().int().optional().describe("Filter by associated epic ID"),
      swimlane: z.number().int().optional().describe("Filter by swimlane ID (see taiga_get_project for valid IDs)"),
    },
    buildFilterParams: (f) => f,
    description:
      "Lists user stories (backlog/sprint items) in a Taiga project, with optional filters. " +
      "Permissions follow the authenticated Taiga user's project role: stories in projects/private boards you " +
      "cannot view will not be returned.\n\n" +
      "Args:\n" +
      "  - project (number | string, required): project ID or slug\n" +
      "  - status, milestone, assigned_to, tags, epic, swimlane (all optional filters)\n" +
      "  - page, page_size, response_format\n\n" +
      "Returns: paginated list of stories with ref, subject, status, assignee, sprint, blocked flag.\n\n" +
      "Use when: \"show me the backlog for project X\" / \"what's in sprint Y\" / \"what is John working on\".",
  });

  registerGetTool<UserStoryDetail>(server, {
    toolName: "taiga_get_user_story",
    title: "Taiga: Get User Story",
    resourcePath: RESOURCE_PATH,
    renderDetail,
    description:
      "Fetches full details of a single user story: description, status, assignee, sprint, points, due date, blocked state.\n\n" +
      "Args: EITHER 'id' (internal numeric ID) OR BOTH 'project' and 'ref' (the project-scoped number shown as 'US #42' in the UI).\n\n" +
      "Returns: full user story object, or 'Error: Resource not found' if it doesn't exist or isn't visible to you.\n\n" +
      "Use when: \"what's the status of US #42 in project X\" / you already know a story's internal id from a previous list call.",
  });

  const CreateSchema = z
    .object({
      project: ProjectRefSchema,
      subject: z.string().min(1).max(500).describe("Title of the user story"),
      description: z.string().optional().describe("Detailed description (Markdown supported)"),
      status: z.number().int().optional().describe("Status ID (see taiga_get_project for valid IDs); defaults to the project's initial status"),
      milestone: z.number().int().optional().describe("Sprint/milestone ID to assign this story to"),
      swimlane: z.number().int().optional().describe("Kanban swimlane ID (see taiga_get_project for valid IDs); defaults to the project's default swimlane"),
      assigned_to: z.number().int().optional().describe("User ID to assign this story to"),
      tags: z.array(z.string()).optional().describe("Tags to attach to the story"),
      due_date: z.string().optional().describe("Due date in YYYY-MM-DD format"),
    })
    .strict();

  server.registerTool(
    "taiga_create_user_story",
    {
      title: "Taiga: Create User Story",
      description:
        "Creates a new user story in a Taiga project's backlog. Requires the authenticated user to have the " +
        "'add_us' permission in that project's role; Taiga returns a permission error otherwise.\n\n" +
        "Args:\n" +
        "  - project (number | string, required), subject (string, required)\n" +
        "  - description, status, milestone, swimlane, assigned_to, tags, due_date (all optional)\n\n" +
        "Returns: the created user story object including its new 'ref' and 'id'.\n\n" +
        "Use when: \"add a new story to the backlog of project X\" / \"create a story for Y and assign it to Z\".",
      inputSchema: CreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const projectId = await resolveProjectId(params.project);
        const { data } = await taigaClient.request<UserStoryDetail>("POST", RESOURCE_PATH, {
          data: { ...params, project: projectId },
        });
        const { text } = truncateText(`Created US #${data.ref}: ${data.subject} (id: ${data.id})`);
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
      milestone: z.number().int().nullable().optional().describe("Sprint ID, or null to remove from current sprint"),
      swimlane: z.number().int().nullable().optional().describe("Kanban swimlane ID, or null to remove from its swimlane"),
      assigned_to: z.number().int().nullable().optional().describe("User ID, or null to unassign"),
      tags: z.array(z.string()).optional(),
      due_date: z.string().nullable().optional(),
      is_blocked: z.boolean().optional(),
      blocked_note: z.string().optional().describe("Reason shown when is_blocked is true"),
      comment: z.string().optional().describe("Adds this text as a new comment on the story"),
    })
    .strict()
    .superRefine(requireIdOrRef);

  server.registerTool(
    "taiga_update_user_story",
    {
      title: "Taiga: Update User Story",
      description:
        "Updates fields of an existing user story (status, assignee, sprint, swimlane, tags, blocked state) and/or adds a comment. " +
        "Automatically fetches the current 'version' and resolves optimistic-concurrency conflicts by re-reading " +
        "before patching, so you never need to pass 'version' yourself. Requires the 'modify_us' permission.\n\n" +
        "Args: EITHER 'id' OR BOTH 'project' and 'ref', plus any fields to change. Only the fields you provide are updated.\n\n" +
        "Returns: the updated user story object.\n\n" +
        "Use when: \"move US #42 to sprint 3\" / \"assign US #42 to Maria\" / \"mark US #42 as blocked because X\" / " +
        "\"add a comment to US #42 saying Y\".",
      inputSchema: UpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const id = await resolveRefId(RESOURCE_PATH, params);
        const { id: _id, project: _project, ref: _ref, ...fields } = params;
        const { data } = await taigaClient.patchWithVersion<UserStoryDetail>(RESOURCE_PATH, id, fields);
        const { text } = truncateText(`Updated US #${data.ref}: ${data.subject}`);
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  registerDeleteTool(server, {
    toolName: "taiga_delete_user_story",
    title: "Taiga: Delete User Story",
    resourcePath: RESOURCE_PATH,
    singularName: "user story",
    description:
      "Permanently deletes a user story from Taiga. This cannot be undone and also removes its tasks and history. " +
      "Requires the 'delete_us' permission.\n\n" +
      "Args: EITHER 'id' OR BOTH 'project' and 'ref'.\n\n" +
      "Returns: confirmation message with the deleted item's id.\n\n" +
      "Use when: explicitly asked to delete/remove a user story. Don't use for closing/finishing a story — update its " +
      "status instead with taiga_update_user_story.",
  });

  const BulkCreateSchema = z
    .object({
      project: ProjectRefSchema,
      bulk_stories: z
        .string()
        .describe("Multiple story subjects, one per line. Each non-empty line becomes a separate user story."),
      status: z.number().int().optional().describe("Status ID to apply to all created stories"),
    })
    .strict();

  server.registerTool(
    "taiga_bulk_create_user_stories",
    {
      title: "Taiga: Bulk Create User Stories",
      description:
        "Creates multiple user stories at once from a newline-separated list of subjects, using Taiga's bulk_create " +
        "endpoint. Faster than calling taiga_create_user_story repeatedly when adding many backlog items.\n\n" +
        "Args:\n" +
        "  - project (number | string, required)\n" +
        "  - bulk_stories (string, required): one story subject per line\n" +
        "  - status (number, optional): status ID applied to all created stories\n\n" +
        "Returns: list of created user stories with their new refs and ids.\n\n" +
        "Use when: \"add these 5 items to the backlog: ...\" with a list of titles.",
      inputSchema: BulkCreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const projectId = await resolveProjectId(params.project);
        const { data } = await taigaClient.request<UserStoryDetail[]>("POST", `${RESOURCE_PATH}/bulk_create`, {
          data: { project_id: projectId, bulk_stories: params.bulk_stories, status_id: params.status },
        });
        const text = `Created ${data.length} user stories:\n${data.map((d) => `- US #${d.ref}: ${d.subject}`).join("\n")}`;
        const { text: finalText } = truncateText(text);
        return textResult(finalText, { items: data });
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );
}
