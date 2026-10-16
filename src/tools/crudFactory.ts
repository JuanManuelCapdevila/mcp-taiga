import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { taigaClient } from "../taigaClient.js";
import {
  buildListOutput,
  errorResult,
  handleApiError,
  renderMarkdownList,
  textResult,
  truncateText,
} from "../formatting.js";
import { PaginationInputSchema, ProjectRefSchema, ResponseFormat, responseFormatField } from "../schemas/common.js";
import { resolveProjectId } from "./projects.js";

/** Shared Zod fields for resources addressable either by internal numeric id or by (project, ref) pair. */
export const RefLookupFields = {
  id: z.number().int().optional().describe("Internal numeric ID of the item (use this OR project+ref, not both)"),
  project: ProjectRefSchema.optional().describe("Project ID or slug (required together with 'ref' if 'id' is not given)"),
  ref: z.number().int().optional().describe("Project-scoped reference number shown in the UI, e.g. the '42' in 'US #42' (required together with 'project' if 'id' is not given)"),
};

export function requireIdOrRef<T extends { id?: number; project?: number | string; ref?: number }>(
  data: T,
  ctx: z.RefinementCtx
): void {
  if (data.id === undefined && (data.project === undefined || data.ref === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either 'id', or both 'project' and 'ref'.",
    });
  }
}

/** Resolves an item's internal numeric id, looking it up by project-scoped ref when id isn't given directly. */
export async function resolveRefId(
  resourcePath: string,
  params: { id?: number; project?: number | string; ref?: number }
): Promise<number> {
  if (params.id !== undefined) return params.id;
  const projectId = await resolveProjectId(params.project!);
  const { data } = await taigaClient.request<{ id: number }>("GET", `${resourcePath}/by_ref`, {
    params: { project: projectId, ref: params.ref },
  });
  return data.id;
}

interface ListToolConfig<TItem> {
  toolName: string;
  title: string;
  description: string;
  resourcePath: string;
  extraFilters?: z.ZodRawShape;
  buildFilterParams: (filters: Record<string, unknown>) => Record<string, unknown>;
  renderItem: (item: TItem) => string;
  markdownTitle: string;
}

export function registerListTool<TItem>(server: McpServer, config: ListToolConfig<TItem>): void {
  const schema = z
    .object({
      project: ProjectRefSchema,
      ...(config.extraFilters ?? {}),
      ...PaginationInputSchema,
      response_format: responseFormatField,
    })
    .strict();

  server.registerTool(
    config.toolName,
    {
      title: config.title,
      description: config.description,
      inputSchema: schema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: Record<string, unknown>) => {
      try {
        const projectId = await resolveProjectId(params.project as number | string);
        const { page, page_size, response_format, project, ...filters } = params;
        const queryParams = {
          project: projectId,
          page,
          page_size,
          ...config.buildFilterParams(filters),
        };
        const { data, pagination } = await taigaClient.request<TItem[]>("GET", config.resourcePath, {
          params: queryParams,
        });
        const output = buildListOutput(data, pagination, page as number, page_size as number);

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          text = renderMarkdownList(config.markdownTitle, output, config.renderItem);
        }
        const { text: finalText } = truncateText(text);
        return textResult(finalText, output as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );
}

interface GetToolConfig<TItem> {
  toolName: string;
  title: string;
  description: string;
  resourcePath: string;
  renderDetail: (item: TItem) => string;
}

export function registerGetTool<TItem>(server: McpServer, config: GetToolConfig<TItem>): void {
  const schema = z
    .object({
      ...RefLookupFields,
      response_format: responseFormatField,
    })
    .strict()
    .superRefine(requireIdOrRef);

  server.registerTool(
    config.toolName,
    {
      title: config.title,
      description: config.description,
      inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: { id?: number; project?: number | string; ref?: number; response_format: ResponseFormat }) => {
      try {
        const id = await resolveRefId(config.resourcePath, params);
        const { data } = await taigaClient.request<TItem>("GET", `${config.resourcePath}/${id}`);

        const text =
          params.response_format === ResponseFormat.JSON ? JSON.stringify(data, null, 2) : config.renderDetail(data);
        const { text: finalText } = truncateText(text);
        return textResult(finalText, data as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );
}

interface DeleteToolConfig {
  toolName: string;
  title: string;
  description: string;
  resourcePath: string;
  singularName: string;
}

export function registerDeleteTool(server: McpServer, config: DeleteToolConfig): void {
  const schema = z.object(RefLookupFields).strict().superRefine(requireIdOrRef);

  server.registerTool(
    config.toolName,
    {
      title: config.title,
      description: config.description,
      inputSchema: schema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: { id?: number; project?: number | string; ref?: number }) => {
      try {
        const id = await resolveRefId(config.resourcePath, params);
        await taigaClient.request("DELETE", `${config.resourcePath}/${id}`);
        return textResult(`Deleted ${config.singularName} ${id}.`, { deleted: true, id });
      } catch (error) {
        return errorResult(handleApiError(error));
      }
    }
  );
}
