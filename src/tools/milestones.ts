import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { taigaClient } from "../taigaClient.js";
import { errorResult, handleApiError, textResult, truncateText } from "../formatting.js";
import { ProjectRefSchema } from "../schemas/common.js";
import { registerListTool } from "./crudFactory.js";
import { resolveProjectId } from "./projects.js";

const RESOURCE_PATH = "/milestones";

interface MilestoneSummary {
  id: number;
  name: string;
  estimated_start: string;
  estimated_finish: string;
  closed: boolean;
}

interface MilestoneDetail extends MilestoneSummary {
  project: number;
  version: number;
  total_points?: number;
  closed_points?: number;
}

interface MilestoneStats {
  total_points: number;
  completed_points: Record<string, number>;
  name: string;
  days: Array<{ day: string; open_points: number }>;
}

function renderListItem(item: MilestoneSummary): string {
  return `## ${item.name}\n- **ID**: ${item.id} | **Start**: ${item.estimated_start} | **Finish**: ${item.estimated_finish} | **Closed**: ${item.closed}\n`;
}

export function registerMilestoneTools(server: McpServer): void {
  registerListTool<MilestoneSummary>(server, {
    toolName: "taiga_list_milestones",
    title: "Taiga: List Milestones (Sprints)",
    resourcePath: RESOURCE_PATH,
    markdownTitle: "Milestones",
    renderItem: renderListItem,
    extraFilters: {
      closed: z.boolean().optional().describe("Filter by whether the sprint is closed"),
    },
    buildFilterParams: (f) => f,
    description:
      "Lists sprints (milestones) in a Taiga project.\n\n" +
      "Args:\n" +
      "  - project (number | string, required)\n" +
      "  - closed (boolean, optional): filter to open or closed sprints\n" +
      "  - page, page_size, response_format\n\n" +
      "Returns: paginated list of sprints with name, start/finish dates, closed flag.\n\n" +
      "Use when: \"what's the current sprint for project X\" / \"list past sprints\".",
  });

  const GetSchema = z
    .object({
      id: z.number().int().describe("Internal numeric ID of the milestone (milestones have no project-scoped ref; get the id from taiga_list_milestones)"),
    })
    .strict();

  server.registerTool(
    "taiga_get_milestone",
    {
      title: "Taiga: Get Milestone",
      description:
        "Fetches full details of a single sprint/milestone by its internal ID.\n\n" +
        "Args:\n  - id (number, required)\n\n" +
        "Returns: full milestone object including point totals.\n\n" +
        "Use when: you need the exact dates or point totals of a sprint you found via taiga_list_milestones.",
      inputSchema: GetSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const { data } = await taigaClient.request<MilestoneDetail>("GET", `${RESOURCE_PATH}/${params.id}`);
        const { text } = truncateText(JSON.stringify(data, null, 2));
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  server.registerTool(
    "taiga_get_milestone_stats",
    {
      title: "Taiga: Get Milestone Stats",
      description:
        "Fetches burndown statistics for a sprint/milestone: total points, points completed per role, and a " +
        "day-by-day breakdown of remaining open points.\n\n" +
        "Args:\n  - id (number, required): internal numeric milestone ID\n\n" +
        "Returns: stats object suitable for summarizing sprint progress or burndown.\n\n" +
        "Use when: \"how is sprint 3 progressing\" / \"give me the burndown for the current sprint\".",
      inputSchema: GetSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const { data } = await taigaClient.request<MilestoneStats>("GET", `${RESOURCE_PATH}/${params.id}/stats`);
        const { text } = truncateText(JSON.stringify(data, null, 2));
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  const CreateSchema = z
    .object({
      project: ProjectRefSchema,
      name: z.string().min(1).max(200).describe("Name of the sprint, e.g. 'Sprint 4'"),
      estimated_start: z.string().describe("Start date in YYYY-MM-DD format"),
      estimated_finish: z.string().describe("Finish date in YYYY-MM-DD format"),
    })
    .strict();

  server.registerTool(
    "taiga_create_milestone",
    {
      title: "Taiga: Create Milestone (Sprint)",
      description:
        "Creates a new sprint in a Taiga project. Requires the 'add_milestone' permission.\n\n" +
        "Args:\n  - project (number | string, required)\n  - name (string, required)\n  - estimated_start, estimated_finish (YYYY-MM-DD, required)\n\n" +
        "Returns: the created milestone object.\n\n" +
        "Use when: \"create a new sprint for project X running from A to B\".",
      inputSchema: CreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const projectId = await resolveProjectId(params.project);
        const { data } = await taigaClient.request<MilestoneDetail>("POST", RESOURCE_PATH, {
          data: { ...params, project: projectId },
        });
        const { text } = truncateText(`Created milestone "${data.name}" (id: ${data.id})`);
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  const UpdateSchema = z
    .object({
      id: z.number().int().describe("Internal numeric ID of the milestone"),
      name: z.string().min(1).max(200).optional(),
      estimated_start: z.string().optional(),
      estimated_finish: z.string().optional(),
      closed: z.boolean().optional(),
    })
    .strict();

  server.registerTool(
    "taiga_update_milestone",
    {
      title: "Taiga: Update Milestone (Sprint)",
      description:
        "Updates fields of an existing sprint (dates, name, open/closed state). Automatically handles " +
        "optimistic-concurrency versioning. Requires the 'modify_milestone' permission.\n\n" +
        "Args:\n  - id (number, required), plus any fields to change (name, estimated_start, estimated_finish, closed)\n\n" +
        "Returns: the updated milestone object.\n\n" +
        "Use when: \"close out sprint 3\" / \"push back the end date of sprint 4\".",
      inputSchema: UpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const { id, ...fields } = params;
        const { data } = await taigaClient.patchWithVersion<MilestoneDetail>(RESOURCE_PATH, id, fields);
        const { text } = truncateText(`Updated milestone "${data.name}" (id: ${data.id})`);
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  const DeleteSchema = z.object({ id: z.number().int().describe("Internal numeric ID of the milestone") }).strict();

  server.registerTool(
    "taiga_delete_milestone",
    {
      title: "Taiga: Delete Milestone (Sprint)",
      description:
        "Permanently deletes a sprint from Taiga. Stories/tasks inside it are not deleted, only unassigned from " +
        "the sprint. Requires the 'delete_milestone' permission.\n\n" +
        "Args:\n  - id (number, required)\n\n" +
        "Returns: confirmation message.",
      inputSchema: DeleteSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await taigaClient.request("DELETE", `${RESOURCE_PATH}/${params.id}`);
        return textResult(`Deleted milestone ${params.id}.`, { deleted: true, id: params.id });
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );
}
