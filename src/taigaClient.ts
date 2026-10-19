import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import { API_BASE_URL } from "./constants.js";

export class TaigaApiError extends Error {
  readonly status?: number;
  readonly taigaDetail?: unknown;

  constructor(message: string, status?: number, taigaDetail?: unknown) {
    super(message);
    this.name = "TaigaApiError";
    this.status = status;
    this.taigaDetail = taigaDetail;
  }
}

interface AuthState {
  authToken: string;
  refreshToken: string;
}

export interface PaginationInfo {
  paginated: boolean;
  count?: number;
  current?: number;
  next?: number;
  prev?: number;
  resultsPerPage?: number;
}

interface RequestOptions {
  data?: unknown;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface TaigaResponse<T> {
  data: T;
  pagination: PaginationInfo;
}

function readPaginationHeaders(headers: Record<string, unknown>): PaginationInfo {
  const get = (name: string): string | undefined => {
    const value = headers[name];
    return typeof value === "string" ? value : undefined;
  };
  const toInt = (value: string | undefined): number | undefined =>
    value !== undefined && value !== "" ? Number.parseInt(value, 10) : undefined;

  return {
    paginated: get("x-paginated") === "true",
    count: toInt(get("x-pagination-count")),
    current: toInt(get("x-pagination-current")),
    next: toInt(get("x-pagination-next")),
    prev: toInt(get("x-pagination-prev")),
    resultsPerPage: toInt(get("x-paginated-by")),
  };
}

class TaigaClient {
  private readonly http: AxiosInstance;
  private auth: AuthState | null = null;
  private loginPromise: Promise<AuthState> | null = null;
  private memberCache: { userId: number; projectIds: Set<number>; expires: number } | null = null;
  private readonly itemProjectCache = new Map<string, number>();

  constructor() {
    this.http = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  }

  private get username(): string {
    const value = process.env.TAIGA_USERNAME;
    if (!value) {
      throw new TaigaApiError(
        "TAIGA_USERNAME environment variable is not set. Configure it with the username/email of the Taiga account this server should act as."
      );
    }
    return value;
  }

  private get password(): string {
    const value = process.env.TAIGA_PASSWORD;
    if (!value) {
      throw new TaigaApiError(
        "TAIGA_PASSWORD environment variable is not set. Configure it with the password of the Taiga account this server should act as."
      );
    }
    return value;
  }

  private async login(): Promise<AuthState> {
    const response = await this.http.post("/auth", {
      type: "normal",
      username: this.username,
      password: this.password,
    });
    const auth: AuthState = {
      authToken: response.data.auth_token,
      refreshToken: response.data.refresh,
    };
    this.auth = auth;
    return auth;
  }

  private async refresh(): Promise<AuthState> {
    if (!this.auth) {
      return this.login();
    }
    try {
      const response = await this.http.post("/auth/refresh", {
        refresh: this.auth.refreshToken,
      });
      const auth: AuthState = {
        authToken: response.data.auth_token,
        refreshToken: response.data.refresh,
      };
      this.auth = auth;
      return auth;
    } catch {
      // Refresh token expired or invalid: fall back to a full re-login.
      return this.login();
    }
  }

  private async ensureAuth(): Promise<AuthState> {
    if (this.auth) {
      return this.auth;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  /**
   * Who the server authenticates as is entirely determined by TAIGA_USERNAME's
   * Taiga account. Permissions are NOT re-implemented here: every request below
   * is forwarded as-is and Taiga enforces whatever that user's project role
   * allows, returning 403 for anything out of scope.
   */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: RequestOptions = {}
  ): Promise<TaigaResponse<T>> {
    const guarded = await this.applyMembershipGuard(method, path, options);
    const response = await this.rawRequest<T>(method, path, guarded);
    if (path === "/projects/by_slug") {
      await this.assertMemberOf((response.data as { id: number }).id);
    }
    return response;
  }

  /**
   * Restricts this server to projects the authenticated user is a *member* of.
   * Taiga also exposes public projects to non-members; those are hidden here:
   * the project list is forced to member=me, and any request that targets a
   * project (directly, or through the item it belongs to) is rejected otherwise.
   */
  private async applyMembershipGuard(method: string, path: string, options: RequestOptions): Promise<RequestOptions> {
    if (path === "/projects" && method === "GET") {
      const { userId } = await this.memberships();
      return { ...options, params: { ...options.params, member: userId } };
    }

    const body = (options.data ?? {}) as Record<string, unknown>;
    const params = options.params ?? {};
    for (const candidate of [params.project, params.project_id, body.project, body.project_id]) {
      if (candidate !== undefined && candidate !== null && /^\d+$/.test(String(candidate))) {
        await this.assertMemberOf(Number(candidate));
      }
    }

    const projectMatch = path.match(/^\/projects\/(\d+)(?:\/|$)/);
    if (projectMatch) await this.assertMemberOf(Number(projectMatch[1]));

    const itemMatch = path.match(/^\/(userstories|tasks|issues|epics|milestones)\/(\d+)(?:\/|$)/);
    if (itemMatch) await this.assertMemberOf(await this.projectOfItem(itemMatch[1], itemMatch[2]));

    const historyMatch = path.match(/^\/history\/(userstory|task|issue|epic)\/(\d+)$/);
    if (historyMatch) {
      const resource = { userstory: "userstories", task: "tasks", issue: "issues", epic: "epics" }[historyMatch[1]]!;
      await this.assertMemberOf(await this.projectOfItem(resource, historyMatch[2]));
    }
    return options;
  }

  private async memberships(): Promise<{ userId: number; projectIds: Set<number> }> {
    if (this.memberCache && this.memberCache.expires > Date.now()) return this.memberCache;
    const { data: me } = await this.rawRequest<{ id: number }>("GET", "/users/me");
    const { data: projects } = await this.rawRequest<{ id: number }[]>("GET", "/projects", {
      params: { member: me.id },
      headers: { "x-disable-pagination": "True" },
    });
    this.memberCache = { userId: me.id, projectIds: new Set(projects.map((p) => p.id)), expires: Date.now() + 60_000 };
    return this.memberCache;
  }

  private async assertMemberOf(projectId: number): Promise<void> {
    let { projectIds } = await this.memberships();
    if (!projectIds.has(projectId)) {
      this.memberCache = null; // membership may have just been granted; re-check once before refusing
      ({ projectIds } = await this.memberships());
    }
    if (!projectIds.has(projectId)) {
      throw new TaigaApiError(
        `Project ${projectId} is not accessible: the authenticated user is not a member of it. ` +
          "This server only operates on projects the user participates in.",
        403
      );
    }
  }

  private async projectOfItem(resource: string, id: string): Promise<number> {
    const key = `${resource}/${id}`;
    const cached = this.itemProjectCache.get(key);
    if (cached !== undefined) return cached;
    const { data } = await this.rawRequest<{ project: number }>("GET", `/${resource}/${id}`);
    this.itemProjectCache.set(key, data.project);
    return data.project;
  }

  private async rawRequest<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: RequestOptions = {}
  ): Promise<TaigaResponse<T>> {
    try {
      const auth = await this.ensureAuth();
      const config: AxiosRequestConfig = {
        method,
        url: path,
        data: options.data,
        params: cleanParams(options.params),
        headers: {
          Authorization: `Bearer ${auth.authToken}`,
          ...options.headers,
        },
      };

      try {
        const response = await this.http.request<T>(config);
        return {
          data: response.data,
          pagination: readPaginationHeaders(response.headers as Record<string, unknown>),
        };
      } catch (error) {
        if (isAxiosError401(error)) {
          const refreshed = await this.refresh();
          const retryResponse = await this.http.request<T>({
            ...config,
            headers: { ...config.headers, Authorization: `Bearer ${refreshed.authToken}` },
          });
          return {
            data: retryResponse.data,
            pagination: readPaginationHeaders(retryResponse.headers as Record<string, unknown>),
          };
        }
        throw error;
      }
    } catch (error) {
      throw toTaigaApiError(error);
    }
  }

  /** Fetches the current `version` field of an object, required by Taiga for PATCH/PUT (optimistic concurrency). */
  async getVersion(resourcePath: string, id: number | string): Promise<number> {
    const { data } = await this.request<{ version: number }>("GET", `${resourcePath}/${id}`);
    return data.version;
  }

  /** PATCHes an object, automatically attaching the latest `version` to satisfy Taiga's concurrency control. */
  async patchWithVersion<T = unknown>(
    resourcePath: string,
    id: number | string,
    data: Record<string, unknown>
  ): Promise<TaigaResponse<T>> {
    const version = await this.getVersion(resourcePath, id);
    return this.request<T>("PATCH", `${resourcePath}/${id}`, { data: { ...data, version } });
  }
}

function cleanParams(params?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function isAxiosError401(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401;
}

function toTaigaApiError(error: unknown): TaigaApiError {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ _error_message?: string; detail?: string }>;
    const status = axiosError.response?.status;
    const detail =
      axiosError.response?.data?._error_message ||
      axiosError.response?.data?.detail ||
      axiosError.message;
    return new TaigaApiError(String(detail), status, axiosError.response?.data);
  }
  return new TaigaApiError(error instanceof Error ? error.message : String(error));
}

export const taigaClient = new TaigaClient();
