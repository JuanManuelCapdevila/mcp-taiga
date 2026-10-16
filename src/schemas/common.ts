import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../constants.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable text or 'json' for machine-readable data (default: 'markdown')");

export const PaginationInputSchema = {
  page: z.number().int().min(1).default(1).describe("Page number to retrieve, starting at 1 (default: 1)"),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`Number of results per page, 1-${MAX_PAGE_SIZE} (default: ${DEFAULT_PAGE_SIZE})`),
};

export const ProjectRefSchema = z
  .union([z.number().int(), z.string()])
  .describe("Numeric project ID or project slug (e.g. 42 or 'my-team-project')");
