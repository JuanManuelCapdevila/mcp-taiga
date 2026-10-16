import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { taigaClient } from "../taigaClient.js";
import { errorResult, handleApiError, textResult, truncateText } from "../formatting.js";
import { ProjectRefSchema } from "../schemas/common.js";
import { registerListTool, registerGetTool, registerDeleteTool, RefLookupFields, requireIdOrRef, resolveRefId } from "./crudFactory.js";
import { resolveProjectId } from "./projects.js";

const RESOURCE_PATH = "/tasks";

interface TaskSummary {
  id: number;
  ref: number;
  subject: string;
  status_extra_info?: { name: string };
  assigned_to_extra_info?: { full_name_display: string } | null;
  user_story_extra_info?: { subject: string; ref: number } | null;
  is_blocked: boolean;
}

interface TaskDetail extends TaskSummary {
  description: string;
  project: number;
  version: number;
  blocked_note: string;
  milestone: number | null;
}

function renderListItem(item: TaskSummary): string {
  const status = item.status_extra_info?.name ?? "unknown";
  const assignee = item.assigned_to_extra_info?.full_name_display ?? "unassigned";
  const parent = item.user_story_extra_info ? `US #${item.user_story_extra_info.ref}` : "no parent story";
  return `## Task #${item.ref}: ${item.subject}\n- **ID**: ${item.id} | **Status**: ${status} | **Assigned to**: ${assignee} | **Parent**: ${parent}${item.is_blocked ? " | ⛔ BLOCKED" : ""}\n`;
}

function renderDetail(item: TaskDetail): string {
  return [
    `# Task #${item.ref}: ${item.subject}`,
    `ID: ${item.id} | Project: ${item.project} | Status: ${item.status_extra_info?.name ?? "unknown"}`,
    item.is_blocked ? `⛔ BLOCKED: ${item.blocked_note}` : "",
    `Assigned to: ${item.assigned_to_extra_info?.full_name_display ?? "unassigned"}`,
    `Parent story: ${item.user_story_extra_info ? `US #${item.user_story_extra_info.ref}: ${item.user_story_extra_info.subject}` : "none"}`,
    "",
    item.description || "_No description._",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function registerTaskTools(server: McpServer): void {
  registerListTool<TaskSummary>(server, {
    toolName: "taiga_list_tasks",
    title: "Taiga: List Tasks",
    resourcePath: RESOURCE_PATH,
    markdownTitle: "Tasks",
    renderItem: renderListItem,
    extraFilters: {
      status: z.number().int().optional().describe("Filter by status ID"),
      milestone: z.number().int().optional().describe("Filter by sprint/milestone ID"),
      user_story: z.number().int().optional().describe("Filter by parent user story ID"),
      assigned_to: z.number().int().optional().describe("Filter by assignee user ID"),
      tags: z.string().optional().describe("Filter by comma-separated tags"),
    },
    buildFilterParams: (f) => f,
    description:
      "Lists tasks in a Taiga project, optionally filtered by status, sprint, parent user story, assignee or tags.\n\n" +
      "Args:\n" +
      "  - project (number | string, required)\n" +
      "  - status, milestone, user_story, assigned_to, tags (optional filters)\n" +
      "  - page, page_size, response_format\n\n" +
      "Returns: paginated list of tasks with ref, subject, status, assignee, parent story, blocked flag.\n\n" +
      "Use when: \"what tasks are under US #42\" / \"what tasks does Maria have in sprint 3\".",
  });

  registerGetTool<TaskDetail>(server, {
    toolName: "taiga_get_task",
    title: "Taiga: Get Task",
    resourcePath: RESOURCE_PATH,
    renderDetail,
    description:
      "Fetches full details of a single task: description, status, assignee, parent story, blocked state.\n\n" +
      "Args: EITHER 'id' (internal numeric ID) OR BOTH 'project' and 'ref' (the number shown as 'Task #7' in the UI).\n\n" +
      "Returns: full task object.\n\n" +
      "Use when: you need the description or current status of a specific task.",
  });

  const CreateSchema = z
    .object({
      project: ProjectRefSchema,
      subject: z.string().min(1).max(500).describe("Title of the task"),
      description: z.string().optional(),
      status: z.number().int().optional().describe("Status ID; defaults to the project's initial task status"),
      user_story: z.number().int().optional().describe("Parent user story ID to attach this task to"),
      milestone: z.number().int().optional().describe("Sprint/milestone ID"),
      assigned_to: z.number().int().optional().describe("User ID to assign this task to"),
      tags: z.array(z.string()).optional(),
    })
    .strict();

  server.registerTool(
    "taiga_create_task",
    {
      title: "Taiga: Create Task",
      description:
        "Creates a new task in a Taiga project, optionally attached to a parent user story. Requires the 'add_task' permission.\n\n" +
        "Args:\n" +
        "  - project (number | string, required), subject (string, required)\n" +
        "  - description, status, user_story, milestone, assigned_to, tags (all optional)\n\n" +
        "Returns: the created task object with its new 'ref' and 'id'.\n\n" +
        "Use when: \"break US #42 into a task for X\" / \"add a task to project Y\".",
      inputSchema: CreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const projectId = await resolveProjectId(params.project);
        const { data } = await taigaClient.request<TaskDetail>("POST", RESOURCE_PATH, {
          data: { ...params, project: projectId },
        });
        const { text } = truncateText(`Created Task #${data.ref}: ${data.subject} (id: ${data.id})`);
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
      milestone: z.number().int().nullable().optional(),
      assigned_to: z.number().int().nullable().optional(),
      tags: z.array(z.string()).optional(),
      is_blocked: z.boolean().optional(),
      blocked_note: z.string().optional(),
      comment: z.string().optional().describe("Adds this text as a new comment on the task"),
    })
    .strict()
    .superRefine(requireIdOrRef);

  server.registerTool(
    "taiga_update_task",
    {
      title: "Taiga: Update Task",
      description:
        "Updates fields of an existing task and/or adds a comment. Automatically handles optimistic-concurrency " +
        "versioning. Requires the 'modify_task' permission.\n\n" +
        "Args: EITHER 'id' OR BOTH 'project' and 'ref', plus any fields to change.\n\n" +
        "Returns: the updated task object.\n\n" +
        "Use when: \"mark Task #7 as done\" / \"reassign Task #7 to Carlos\" / \"comment on Task #7\".",
      inputSchema: UpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const id = await resolveRefId(RESOURCE_PATH, params);
        const { id: _id, project: _project, ref: _ref, ...fields } = params;
        const { data } = await taigaClient.patchWithVersion<TaskDetail>(RESOURCE_PATH, id, fields);
        const { text } = truncateText(`Updated Task #${data.ref}: ${data.subject}`);
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  registerDeleteTool(server, {
    toolName: "taiga_delete_task",
    title: "Taiga: Delete Task",
    resourcePath: RESOURCE_PATH,
    singularName: "task",
    description:
      "Permanently deletes a task from Taiga. Cannot be undone. Requires the 'delete_task' permission.\n\n" +
      "Args: EITHER 'id' OR BOTH 'project' and 'ref'.\n\n" +
      "Returns: confirmation message.\n\n" +
      "Use when: explicitly asked to delete a task. Don't use for completing a task — update its status instead.",
  });
}
