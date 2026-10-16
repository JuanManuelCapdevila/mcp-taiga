import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CHARACTER_LIMIT } from "./constants.js";
import { TaigaApiError } from "./taigaClient.js";
import { PaginationInfo } from "./taigaClient.js";

export function textResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structuredContent) {
    result.structuredContent = structuredContent;
  }
  return result;
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function handleApiError(error: unknown): string {
  if (error instanceof TaigaApiError) {
    switch (error.status) {
      case 401:
        return "Error: Authentication with Taiga failed. Check TAIGA_USERNAME and TAIGA_PASSWORD.";
      case 403:
        return `Error: Permission denied. The authenticated Taiga user's role does not allow this action. (${error.message})`;
      case 404:
        return "Error: Resource not found. Double-check the ID, slug, or ref is correct and belongs to a project you can access.";
      case 409:
        return "Error: The object changed since it was last read (version conflict). Re-fetch it and retry the update.";
      case 429:
        return "Error: Rate limit exceeded. Please wait before making more requests.";
      default:
        return `Error: Taiga API request failed${error.status ? ` with status ${error.status}` : ""}: ${error.message}`;
    }
  }
  return `Error: Unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`;
}

export function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, CHARACTER_LIMIT)}\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Narrow your query with filters or a smaller page_size.]`,
    truncated: true,
  };
}

export interface ListOutput<T> {
  total: number | null;
  count: number;
  page: number;
  page_size: number;
  has_more: boolean;
  next_page: number | null;
  items: T[];
}

export function buildListOutput<T>(items: T[], pagination: PaginationInfo, page: number, pageSize: number): ListOutput<T> {
  return {
    total: pagination.count ?? null,
    count: items.length,
    page: pagination.current ?? page,
    page_size: pagination.resultsPerPage ?? pageSize,
    has_more: pagination.next !== undefined,
    next_page: pagination.next ?? null,
    items,
  };
}

export function renderMarkdownList<T>(
  title: string,
  output: ListOutput<T>,
  renderItem: (item: T) => string
): string {
  const lines = [`# ${title}`, ""];
  const totalLabel = output.total !== null ? output.total : "unknown";
  lines.push(`Showing ${output.count} result(s) (page ${output.page}, total: ${totalLabel})`, "");

  if (output.items.length === 0) {
    lines.push("_No results found._");
  } else {
    for (const item of output.items) {
      lines.push(renderItem(item));
    }
  }

  if (output.has_more) {
    lines.push("", `More results available. Use page=${output.next_page} to continue.`);
  }

  return lines.join("\n");
}
