export const API_BASE_URL = (process.env.TAIGA_API_URL ?? "").replace(/\/+$/, "");

// Maximum size (in characters) of a tool's text response before it gets truncated.
export const CHARACTER_LIMIT = 25000;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
