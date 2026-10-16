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
    options: { data?: unknown; params?: Record<string, unknown>; headers?: Record<string, string> } = {}
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
