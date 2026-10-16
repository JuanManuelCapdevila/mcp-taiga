import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { taigaClient } from "../taigaClient.js";
import { errorResult, handleApiError, textResult, truncateText } from "../formatting.js";
import { ProjectRefSchema } from "../schemas/common.js";
import { resolveProjectId } from "./projects.js";

interface SearchResult {
  id: number;
  ref?: number;
  subject?: string;
  name?: string;
}

interface SearchResponse {
  userstories?: SearchResult[];
  tasks?: SearchResult[];
  issues?: SearchResult[];
  wikipages?: SearchResult[];
  epics?: SearchResult[];
  count: number;
}

export function registerSearchTools(server: McpServer): void {
  const SearchSchema = z
    .object({
      project: ProjectRefSchema,
      text: z.string().min(1).describe("Free-text search query"),
    })
    .strict();

  server.registerTool(
    "taiga_search",
    {
      title: "Taiga: Search Project",
      description:
        "Searches across all item types (user stories, tasks, issues, epics, wiki pages) in a single Taiga " +
        "project for a free-text query. Faster than calling each list tool separately when you don't know what " +
        "kind of item you're looking for.\n\n" +
        "Args:\n" +
        "  - project (number | string, required)\n" +
        "  - text (string, required): search query\n\n" +
        "Returns: matching items grouped by type (user stories, tasks, issues, epics, wiki pages), each with ref/id and title.\n\n" +
        "Use when: \"find anything related to 'checkout flow' in project X\" when you don't know if it's a story, " +
        "task or issue.",
      inputSchema: SearchSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const projectId = await resolveProjectId(params.project);
        const { data } = await taigaClient.request<SearchResponse>("GET", "/search", {
          params: { project: projectId, text: params.text },
        });

        const lines = [`# Search results for "${params.text}"`, ""];
        const renderGroup = (title: string, items?: SearchResult[]) => {
          if (!items || items.length === 0) return;
          lines.push(`## ${title}`);
          for (const item of items) {
            lines.push(`- ${item.ref ? `#${item.ref}` : `id ${item.id}`}: ${item.subject ?? item.name ?? ""}`);
          }
          lines.push("");
        };
        renderGroup("User Stories", data.userstories);
        renderGroup("Tasks", data.tasks);
        renderGroup("Issues", data.issues);
        renderGroup("Epics", data.epics);
        renderGroup("Wiki Pages", data.wikipages);
        if (lines.length === 2) lines.push("_No results found._");

        const { text } = truncateText(lines.join("\n"));
        return textResult(text, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );
}
