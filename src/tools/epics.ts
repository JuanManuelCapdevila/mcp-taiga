import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { taigaClient } from "../taigaClient.js";
import { errorResult, handleApiError, textResult, truncateText } from "../formatting.js";
import { ProjectRefSchema } from "../schemas/common.js";
import { registerListTool, registerGetTool, registerDeleteTool, RefLookupFields, requireIdOrRef, resolveRefId } from "./crudFactory.js";
import { resolveProjectId } from "./projects.js";

const RESOURCE_PATH = "/epics";

interface EpicSummary {
  id: number;
  ref: number;
  subject: string;
  status_extra_info?: { name: string };
  assigned_to_extra_info?: { full_name_display: string } | null;
  color: string;
}

interface EpicDetail extends EpicSummary {
  description: string;
  project: number;
  version: number;
}

function renderListItem(item: EpicSummary): string {
  const status = item.status_extra_info?.name ?? "unknown";
  const assignee = item.assigned_to_extra_info?.full_name_display ?? "unassigned";
  return `## Epic #${item.ref}: ${item.subject}\n- **ID**: ${item.id} | **Status**: ${status} | **Assigned to**: ${assignee}\n`;
}

function renderDetail(item: EpicDetail): string {
  return [
    `# Epic #${item.ref}: ${item.subject}`,
    `ID: ${item.id} | Project: ${item.project} | Status: ${item.status_extra_info?.name ?? "unknown"}`,
    `Assigned to: ${item.assigned_to_extra_info?.full_name_display ?? "unassigned"}`,
    "",
    item.description || "_No description._",
  ].join("\n");
}

export function registerEpicTools(server: McpServer): void {
  registerListTool<EpicSummary>(server, {
    toolName: "taiga_list_epics",
    title: "Taiga: List Epics",
    resourcePath: RESOURCE_PATH,
    markdownTitle: "Epics",
    renderItem: renderListItem,
    extraFilters: {
      status: z.number().int().optional().describe("Filter by status ID"),
      assigned_to: z.number().int().optional().describe("Filter by assignee user ID"),
      tags: z.string().optional().describe("Filter by comma-separated tags"),
    },
    buildFilterParams: (f) => f,
    description:
      "Lists epics (large bodies of work spanning multiple sprints) in a Taiga project.\n\n" +
      "Args:\n" +
      "  - project (number | string, required)\n" +
      "  - status, assigned_to, tags (optional filters)\n" +
      "  - page, page_size, response_format\n\n" +
      "Returns: paginated list of epics with ref, subject, status, assignee.\n\n" +
      "Use when: \"what epics exist in project X\" / \"show me the roadmap-level items\".",
  });

  registerGetTool<EpicDetail>(server, {
    toolName: "taiga_get_epic",
    title: "Taiga: Get Epic",
    resourcePath: RESOURCE_PATH,
    renderDetail,
    description:
      "Fetches full details of a single epic: description, status, assignee.\n\n" +
      "Args: EITHER 'id' (internal numeric ID) OR BOTH 'project' and 'ref' (the number shown as 'Epic #3' in the UI).\n\n" +
      "Returns: full epic object.\n\n" +
      "Use when: you need the description or status of a specific epic.",
  });

  const CreateSchema = z
    .object({
      project: ProjectRefSchema,
      subject: z.string().min(1).max(500).describe("Title of the epic"),
      description: z.string().optional(),
      status: z.number().int().optional().describe("Status ID; defaults to the project's initial epic status"),
      assigned_to: z.number().int().optional().describe("User ID to assign this epic to"),
      color: z.string().optional().describe("Hex color for the epic's visual tag, e.g. '#45C7E3'"),
      tags: z.array(z.string()).optional(),
    })
    .strict();

  server.registerTool(
    "taiga_create_epic",
    {
      title: "Taiga: Create Epic",
      description:
        "Creates a new epic in a Taiga project. Requires the 'add_epic' permission.\n\n" +
        "Args:\n" +
        "  - project (number | string, required), subject (string, required)\n" +
        "  - description, status, assigned_to, color, tags (all optional)\n\n" +
        "Returns: the created epic object with its new 'ref' and 'id'.\n\n" +
        "Use when: \"create an epic for the X initiative in project Y\".",
      inputSchema: CreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const projectId = await resolveProjectId(params.project);
        const { data } = await taigaClient.request<EpicDetail>("POST", RESOURCE_PATH, {
          data: { ...params, project: projectId },
        });
        const { text } = truncateText(`Created Epic #${data.ref}: ${data.subject} (id: ${data.id})`);
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
      assigned_to: z.number().int().nullable().optional(),
      color: z.string().optional(),
      tags: z.array(z.string()).optional(),
      comment: z.string().optional().describe("Adds this text as a new comment on the epic"),
    })
    .strict()
    .superRefine(requireIdOrRef);

  server.registerTool(
    "taiga_update_epic",
    {
      title: "Taiga: Update Epic",
      description:
        "Updates fields of an existing epic and/or adds a comment. Automatically handles optimistic-concurrency " +
        "versioning. Requires the 'modify_epic' permission.\n\n" +
        "Args: EITHER 'id' OR BOTH 'project' and 'ref', plus any fields to change.\n\n" +
        "Returns: the updated epic object.\n\n" +
        "Use when: \"rename Epic #3\" / \"reassign Epic #3\" / \"comment on Epic #3\".",
      inputSchema: UpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const id = await resolveRefId(RESOURCE_PATH, params);
        const { id: _id, project: _project, ref: _ref, ...fields } = params;
        const { data } = await taigaClient.patchWithVersion<EpicDetail>(RESOURCE_PATH, id, fields);
        const { text } = truncateText(`Updated Epic #${data.ref}: ${data.subject}`);
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  registerDeleteTool(server, {
    toolName: "taiga_delete_epic",
    title: "Taiga: Delete Epic",
    resourcePath: RESOURCE_PATH,
    singularName: "epic",
    description:
      "Permanently deletes an epic from Taiga. Cannot be undone (its linked user stories are not deleted, only " +
      "unlinked). Requires the 'delete_epic' permission.\n\n" +
      "Args: EITHER 'id' OR BOTH 'project' and 'ref'.\n\n" +
      "Returns: confirmation message.",
  });

  const LinkStorySchema = z
    .object({
      epic_id: z.number().int().describe("Internal numeric ID of the epic (use taiga_get_epic to resolve a ref first)"),
      user_story_id: z.number().int().describe("Internal numeric ID of the user story to link (use taiga_get_user_story to resolve a ref first)"),
    })
    .strict();

  server.registerTool(
    "taiga_link_user_story_to_epic",
    {
      title: "Taiga: Link User Story to Epic",
      description:
        "Links an existing user story to an epic, establishing the parent/child relationship used for roadmap " +
        "rollups. Requires the 'modify_epic' permission.\n\n" +
        "Args:\n" +
        "  - epic_id (number, required): internal numeric epic ID\n" +
        "  - user_story_id (number, required): internal numeric user story ID\n\n" +
        "Returns: confirmation of the created link.\n\n" +
        "Use when: \"attach US #42 to Epic #3\". Note both IDs must be internal numeric IDs, not refs — look them up " +
        "first with taiga_get_user_story / taiga_get_epic if you only have the ref number shown in the UI.",
      inputSchema: LinkStorySchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await taigaClient.request("POST", `${RESOURCE_PATH}/${params.epic_id}/related_userstories`, {
          data: { user_story: params.user_story_id },
        });
        return textResult(`Linked user story ${params.user_story_id} to epic ${params.epic_id}.`, {
          linked: true,
          epic_id: params.epic_id,
          user_story_id: params.user_story_id,
        });
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );
}
