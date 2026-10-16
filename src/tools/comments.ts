import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { taigaClient } from "../taigaClient.js";
import { errorResult, handleApiError, textResult, truncateText } from "../formatting.js";
import { resolveRefId, RefLookupFields, requireIdOrRef } from "./crudFactory.js";

const ItemType = z.enum(["user_story", "task", "issue", "epic"]).describe(
  "Which kind of item to comment on / fetch history for"
);

const RESOURCE_PATH_BY_TYPE: Record<string, string> = {
  user_story: "/userstories",
  task: "/tasks",
  issue: "/issues",
  epic: "/epics",
};

// Taiga's history API uses a singular, slightly different name for user stories.
const HISTORY_SEGMENT_BY_TYPE: Record<string, string> = {
  user_story: "userstory",
  task: "task",
  issue: "issue",
  epic: "epic",
};

interface HistoryEntry {
  id: string;
  created_at: string;
  user: { name: string; username?: string } | null;
  comment: string;
  delete_comment_date: string | null;
}

export function registerCommentTools(server: McpServer): void {
  const AddCommentSchema = z
    .object({
      item_type: ItemType,
      ...RefLookupFields,
      comment: z.string().min(1).describe("Comment text to add (Markdown supported)"),
    })
    .strict()
    .superRefine(requireIdOrRef);

  server.registerTool(
    "taiga_add_comment",
    {
      title: "Taiga: Add Comment",
      description:
        "Adds a comment to a user story, task, issue or epic. Automatically handles optimistic-concurrency " +
        "versioning. Requires whichever 'modify_*' permission applies to the item type.\n\n" +
        "Args:\n" +
        "  - item_type ('user_story' | 'task' | 'issue' | 'epic', required)\n" +
        "  - EITHER 'id' (internal numeric ID) OR BOTH 'project' and 'ref'\n" +
        "  - comment (string, required)\n\n" +
        "Returns: confirmation with the item's ref.\n\n" +
        "Use when: \"add a comment to US #42 saying X\" / \"tell the team on Task #7 that Y\".",
      inputSchema: AddCommentSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const resourcePath = RESOURCE_PATH_BY_TYPE[params.item_type];
        const id = await resolveRefId(resourcePath, params);
        const { data } = await taigaClient.patchWithVersion<{ ref: number; subject: string }>(resourcePath, id, {
          comment: params.comment,
        });
        const { text } = truncateText(`Added comment to ${params.item_type} #${data.ref}: ${data.subject}`);
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );

  const ListCommentsSchema = z
    .object({
      item_type: ItemType,
      ...RefLookupFields,
      include_deleted: z.boolean().default(false).describe("Include comments that were later deleted (default: false)"),
    })
    .strict()
    .superRefine(requireIdOrRef);

  server.registerTool(
    "taiga_list_comments",
    {
      title: "Taiga: List Comments",
      description:
        "Lists the comment history of a user story, task, issue or epic, in chronological order.\n\n" +
        "Args:\n" +
        "  - item_type ('user_story' | 'task' | 'issue' | 'epic', required)\n" +
        "  - EITHER 'id' (internal numeric ID) OR BOTH 'project' and 'ref'\n" +
        "  - include_deleted (boolean, default false)\n\n" +
        "Returns: list of comments with author, timestamp and text.\n\n" +
        "Use when: \"what has been discussed on US #42\" / \"show me the comment thread on Issue #15\".",
      inputSchema: ListCommentsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const resourcePath = RESOURCE_PATH_BY_TYPE[params.item_type];
        const id = await resolveRefId(resourcePath, params);
        const historySegment = HISTORY_SEGMENT_BY_TYPE[params.item_type];
        const { data } = await taigaClient.request<HistoryEntry[]>("GET", `/history/${historySegment}/${id}`);

        const comments = data.filter((entry) => entry.comment && (params.include_deleted || !entry.delete_comment_date));
        if (comments.length === 0) {
          return textResult("No comments found.", { items: [] });
        }
        const lines = comments.map(
          (c) => `**${c.user?.name ?? "unknown"}** (${c.created_at}):\n${c.comment}\n`
        );
        const { text } = truncateText(lines.join("\n"));
        return textResult(text, { items: comments });
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );
}
