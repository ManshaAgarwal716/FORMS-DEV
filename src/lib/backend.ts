import axios, { AxiosRequestConfig, Method } from "axios";

type ApiError = { message: string; code?: string };

type AppUser = {
  id: string;
  email: string;
  role?: string;
  created_at?: string;
  user_metadata?: Record<string, unknown>;
};

type AppSession = {
  access_token: string;
  refresh_token: string;
  user: AppUser;
};

type AuthEvent = "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | "INITIAL_SESSION";
type ApiHttpResponse = {
  ok: boolean;
  status: number;
  data: any;
  json: () => Promise<any>;
};

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
const STORAGE_KEY = "aqora_auth_session";

let currentSession: AppSession | null = loadSession();
const authListeners = new Set<(event: AuthEvent, session: AppSession | null) => void>();
let inFlightRefresh: Promise<boolean> | null = null;

function loadSession(): AppSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AppSession;
  } catch {
    return null;
  }
}

function saveSession(session: AppSession | null) {
  currentSession = session;
  if (session) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function notifyAuth(event: AuthEvent, session: AppSession | null) {
  for (const listener of authListeners) {
    listener(event, session);
  }
}

function toError(message: string, code?: string): ApiError {
  return { message, code };
}

async function parseJsonSafe(response: ApiHttpResponse): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function rawRequest(path: string, options: RequestInit = {}): Promise<ApiHttpResponse> {
  const headers = new Headers(options.headers ?? {});
  const hasBody = options.body !== undefined;
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const method = (options.method ?? "GET").toUpperCase() as Method;
  const requestConfig: AxiosRequestConfig = {
    url: `${API_BASE_URL}${path}`,
    method,
    headers: headersToObject(headers),
    validateStatus: () => true
  };

  if (hasBody) {
    if (typeof options.body === "string") {
      try {
        requestConfig.data = JSON.parse(options.body);
      } catch {
        requestConfig.data = options.body;
      }
    } else {
      requestConfig.data = options.body;
    }
  }

  try {
    const response = await axios.request(requestConfig);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data: response.data,
      json: async () => response.data
    };
  } catch (error: any) {
    return {
      ok: false,
      status: Number(error?.response?.status ?? 0),
      data: { message: error?.message ?? "Network error" },
      json: async () => ({ message: error?.message ?? "Network error" })
    };
  }
}

async function refreshSession(): Promise<boolean> {
  const refreshToken = currentSession?.refresh_token;
  if (!refreshToken) return false;

  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    try {
      const response = await rawRequest("/api/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken })
      });

      if (!response.ok) {
        saveSession(null);
        notifyAuth("SIGNED_OUT", null);
        return false;
      }

      const payload = await parseJsonSafe(response);
      if (!payload?.tokens || !payload?.user) {
        saveSession(null);
        notifyAuth("SIGNED_OUT", null);
        return false;
      }

      const session: AppSession = {
        access_token: payload.tokens.accessToken,
        refresh_token: payload.tokens.refreshToken,
        user: {
          ...payload.user,
          user_metadata: {
            username: payload.user.username,
            avatar_url: payload.user.avatar_url
          }
        }
      };

      saveSession(session);
      notifyAuth("TOKEN_REFRESHED", session);
      return true;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

async function apiFetch(
  path: string,
  options: RequestInit = {},
  authMode: "optional" | "required" = "optional"
): Promise<ApiHttpResponse> {
  const headers = new Headers(options.headers ?? {});
  const hasBody = options.body !== undefined;
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (currentSession?.access_token) {
    headers.set("Authorization", `Bearer ${currentSession.access_token}`);
  }

  let response = await rawRequest(path, {
    ...options,
    headers
  });

  if (response.status === 401 && currentSession?.refresh_token) {
    const refreshed = await refreshSession();
    if (refreshed && currentSession?.access_token) {
      headers.set("Authorization", `Bearer ${currentSession.access_token}`);
      response = await rawRequest(path, {
        ...options,
        headers
      });
    }
  }

  if (authMode === "required" && response.status === 401) {
    throw toError("Unauthorized", "401");
  }

  return response;
}

class QueryBuilder {
  private table: string;
  private action: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: any = null;
  private selectedColumns = "*";
  private selectOptions: Record<string, any> | undefined;
  private filters: Array<{ kind: "eq" | "gte" | "in"; column: string; value: any }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitValue: number | null = null;
  private wantsSingle = false;
  private wantsMaybeSingle = false;

  constructor(table: string) {
    this.table = table;
  }

  select(columns = "*", options?: Record<string, any>) {
    this.selectedColumns = columns;
    this.selectOptions = options;
    if (this.action === "select") {
      this.action = "select";
    }
    return this;
  }

  insert(payload: any) {
    this.action = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: any) {
    this.action = "update";
    this.payload = payload;
    return this;
  }

  upsert(payload: any) {
    this.action = "upsert";
    this.payload = payload;
    return this;
  }

  delete() {
    this.action = "delete";
    return this;
  }

  eq(column: string, value: any) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  gte(column: string, value: any) {
    this.filters.push({ kind: "gte", column, value });
    return this;
  }

  in(column: string, value: any[]) {
    this.filters.push({ kind: "in", column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending ?? true };
    return this;
  }

  limit(value: number) {
    this.limitValue = value;
    return this;
  }

  single() {
    this.wantsSingle = true;
    return this.execute();
  }

  maybeSingle() {
    this.wantsMaybeSingle = true;
    return this.execute();
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private getFilter(kind: "eq" | "gte" | "in", column: string) {
    return this.filters.find((f) => f.kind === kind && f.column === column)?.value;
  }

  private async executeSelect() {
    const countOnly = this.selectOptions?.count === "exact" && this.selectOptions?.head === true;

    if (this.table === "forms") {
      const id = this.getFilter("eq", "id");
      if (!countOnly && id) {
        const response = await apiFetch(`/api/forms/${id}`);
        if (!response.ok) {
          const payload = await parseJsonSafe(response);
          return { data: null, error: toError(payload?.message || "Failed to fetch form"), count: null };
        }
        const data = await parseJsonSafe(response);
        return { data, error: null, count: null };
      }

      if (countOnly) {
        const userId = this.getFilter("eq", "user_id");
        const since = this.getFilter("gte", "created_at");
        const params = new URLSearchParams();
        if (userId) params.set("userId", String(userId));
        if (since) params.set("since", String(since));
        const response = await apiFetch(`/api/forms/count?${params.toString()}`, {}, "required");
        const payload = await parseJsonSafe(response);
        if (!response.ok) {
          return { data: null, error: toError(payload?.message || "Failed to count forms"), count: null };
        }
        return { data: null, error: null, count: payload?.count ?? 0 };
      }

      const userId = this.getFilter("eq", "user_id");
      const params = new URLSearchParams();
      if (userId) params.set("userId", String(userId));
      if (this.limitValue) params.set("limit", String(this.limitValue));
      const response = await apiFetch(`/api/forms?${params.toString()}`, {}, "required");
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to fetch forms"), count: null };
      }
      return { data: payload ?? [], error: null, count: null };
    }

    if (this.table === "responses") {
      const id = this.getFilter("eq", "id");
      if (!countOnly && id) {
        const response = await apiFetch(`/api/responses/${id}`);
        const payload = await parseJsonSafe(response);
        if (!response.ok) {
          return { data: null, error: toError(payload?.message || "Failed to fetch response"), count: null };
        }
        return { data: payload, error: null, count: null };
      }

      const params = new URLSearchParams();
      const formId = this.getFilter("eq", "form_id");
      const formIds = this.getFilter("in", "form_id");
      const since = this.getFilter("gte", "submitted_at");
      if (formId) params.set("formId", String(formId));
      if (Array.isArray(formIds) && formIds.length > 0) params.set("formIds", formIds.join(","));
      if (since) params.set("since", String(since));
      if (countOnly) params.set("countOnly", "true");
      if (this.limitValue) params.set("limit", String(this.limitValue));

      const response = await apiFetch(`/api/responses?${params.toString()}`);
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to fetch responses"), count: null };
      }
      if (countOnly) {
        return { data: null, error: null, count: payload?.count ?? 0 };
      }
      return { data: payload ?? [], error: null, count: null };
    }

    if (this.table === "profiles") {
      const id = this.getFilter("eq", "id");
      if (!id) return { data: null, error: toError("Profile id filter required"), count: null };
      const response = await apiFetch(`/api/profiles/${id}`, {}, "required");
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to fetch profile"), count: null };
      }
      return { data: payload, error: null, count: null };
    }

    if (this.table === "complaints") {
      const params = new URLSearchParams();
      const status = this.getFilter("eq", "status");
      const type = this.getFilter("eq", "type");
      const since = this.getFilter("gte", "created_at");
      if (status) params.set("status", String(status));
      if (type) params.set("type", String(type));
      if (since) params.set("since", String(since));
      if (countOnly) params.set("countOnly", "true");

      const response = await apiFetch(`/api/complaints?${params.toString()}`, {}, "required");
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to fetch complaints"), count: null };
      }
      if (countOnly) {
        return { data: null, error: null, count: payload?.count ?? 0 };
      }
      return { data: payload ?? [], error: null, count: null };
    }

    if (this.table === "user_roles") {
      const userId = this.getFilter("eq", "user_id");
      const role = this.getFilter("eq", "role");
      const sessionUser = currentSession?.user;
      const isMatch = !!sessionUser && sessionUser.id === userId && sessionUser.role === role;
      return {
        data: isMatch ? { role } : null,
        error: null,
        count: null
      };
    }

    return { data: null, error: toError(`Unsupported table: ${this.table}`), count: null };
  }

  private async executeInsert() {
    const body = Array.isArray(this.payload) ? this.payload[0] : this.payload;

    if (this.table === "forms") {
      const response = await apiFetch("/api/forms", { method: "POST", body: JSON.stringify(body) }, "required");
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to create form"), count: null };
      }
      return { data: payload, error: null, count: null };
    }

    if (this.table === "responses") {
      const response = await apiFetch("/api/responses", { method: "POST", body: JSON.stringify(body) });
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to create response"), count: null };
      }
      return { data: payload, error: null, count: null };
    }

    if (this.table === "complaints") {
      const response = await apiFetch("/api/complaints", { method: "POST", body: JSON.stringify(body) });
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to create complaint"), count: null };
      }
      return { data: payload, error: null, count: null };
    }

    return { data: null, error: toError(`Insert not supported for table: ${this.table}`), count: null };
  }

  private async executeUpdate() {
    const id = this.getFilter("eq", "id");
    if (!id) return { data: null, error: toError("Missing id filter for update"), count: null };

    if (this.table === "forms") {
      const response = await apiFetch(`/api/forms/${id}`, { method: "PATCH", body: JSON.stringify(this.payload) }, "required");
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to update form"), count: null };
      }
      return { data: payload, error: null, count: null };
    }

    if (this.table === "profiles") {
      const response = await apiFetch(`/api/profiles/${id}`, { method: "PATCH", body: JSON.stringify(this.payload) }, "required");
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to update profile"), count: null };
      }
      return { data: payload, error: null, count: null };
    }

    if (this.table === "complaints") {
      const response = await apiFetch(`/api/complaints/${id}`, { method: "PATCH", body: JSON.stringify(this.payload) }, "required");
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to update complaint"), count: null };
      }
      return { data: payload, error: null, count: null };
    }

    return { data: null, error: toError(`Update not supported for table: ${this.table}`), count: null };
  }

  private async executeDelete() {
    const id = this.getFilter("eq", "id");
    if (!id) return { data: null, error: toError("Missing id filter for delete"), count: null };

    if (this.table === "forms") {
      const response = await apiFetch(`/api/forms/${id}`, { method: "DELETE" }, "required");
      if (!response.ok && response.status !== 204) {
        const payload = await parseJsonSafe(response);
        return { data: null, error: toError(payload?.message || "Failed to delete form"), count: null };
      }
      return { data: null, error: null, count: null };
    }

    if (this.table === "responses") {
      const response = await apiFetch(`/api/responses/${id}`, { method: "DELETE" }, "required");
      if (!response.ok && response.status !== 204) {
        const payload = await parseJsonSafe(response);
        return { data: null, error: toError(payload?.message || "Failed to delete response"), count: null };
      }
      return { data: null, error: null, count: null };
    }

    return { data: null, error: toError(`Delete not supported for table: ${this.table}`), count: null };
  }

  private async executeUpsert() {
    if (this.table === "forms") {
      const response = await apiFetch("/api/forms/upsert", { method: "POST", body: JSON.stringify(this.payload) }, "required");
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to upsert form"), count: null };
      }
      return { data: payload, error: null, count: null };
    }

    if (this.table === "profiles") {
      const response = await apiFetch("/api/profiles/upsert", { method: "POST", body: JSON.stringify(this.payload) }, "required");
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: toError(payload?.message || "Failed to upsert profile"), count: null };
      }
      return { data: payload, error: null, count: null };
    }

    return { data: null, error: toError(`Upsert not supported for table: ${this.table}`), count: null };
  }

  private async execute() {
    let result: { data: any; error: ApiError | null; count: number | null };
    if (this.action === "select") result = await this.executeSelect();
    else if (this.action === "insert") result = await this.executeInsert();
    else if (this.action === "update") result = await this.executeUpdate();
    else if (this.action === "delete") result = await this.executeDelete();
    else result = await this.executeUpsert();

    if ((this.wantsSingle || this.wantsMaybeSingle) && Array.isArray(result.data)) {
      const first = result.data[0] ?? null;
      if (this.wantsSingle && !first && !result.error) {
        return { data: null, error: toError("No rows found"), count: result.count };
      }
      return { data: first, error: result.error, count: result.count };
    }

    return result;
  }
}

async function handleAuthPayload(response: ApiHttpResponse) {
  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    return { data: null, error: toError(payload?.message || "Authentication failed") };
  }

  const user = payload?.user as AppUser | undefined;
  const tokens = payload?.tokens as { accessToken: string; refreshToken: string } | undefined;
  if (!user || !tokens) {
    return { data: null, error: toError("Invalid auth response") };
  }

  const session: AppSession = {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    user: {
      ...user,
      user_metadata: {
        username: (user as any).username,
        avatar_url: (user as any).avatar_url
      }
    }
  };

  saveSession(session);
  notifyAuth("SIGNED_IN", session);

  return { data: { user: session.user, session }, error: null };
}

export const backend = {
  from(table: string) {
    return new QueryBuilder(table);
  },
  functions: {
    async invoke(functionName: string, options: { body?: any } = {}) {
      const response = await apiFetch(`/api/ai/${functionName}`, {
        method: "POST",
        body: JSON.stringify(options.body ?? {}),
      });
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        return { data: null, error: { message: payload?.message || "Function invocation failed" } };
      }
      return { data: payload, error: null };
    },
  },
  async rpc(functionName: string, params: Record<string, any>) {
    if (functionName === "increment_form_views") {
      const response = await apiFetch(`/api/forms/${params.form_id}/increment-views`, { method: "POST" });
      const payload = await parseJsonSafe(response);
      return {
        data: response.ok ? payload : null,
        error: response.ok ? null : toError(payload?.message || "RPC failed")
      };
    }

    return {
      data: null,
      error: toError(`RPC not implemented: ${functionName}`)
    };
  },
  channel(_name: string) {
    return {
      on() {
        return this;
      },
      subscribe() {
        return { unsubscribe() {} };
      }
    };
  },
  removeChannel(_channel: unknown) {},
  auth: {
    async signUp(input: {
      email: string;
      password: string;
      options?: { data?: { username?: string; avatar_url?: string } };
    }) {
      const response = await apiFetch("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          username: input.options?.data?.username,
          avatar_url: input.options?.data?.avatar_url
        })
      });
      const result = await handleAuthPayload(response);
      if (result.error) return { data: null, error: result.error };
      return { data: { user: result.data?.user }, error: null };
    },
    async signInWithPassword(input: { email: string; password: string }) {
      const response = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(input)
      });
      const result = await handleAuthPayload(response);
      return { data: result.data, error: result.error };
    },
    async signOut() {
      const refreshToken = currentSession?.refresh_token;
      if (refreshToken) {
        await apiFetch("/api/auth/logout", {
          method: "POST",
          body: JSON.stringify({ refreshToken })
        });
      }
      saveSession(null);
      notifyAuth("SIGNED_OUT", null);
      return { error: null };
    },
    async getSession() {
      return {
        data: {
          session: currentSession
        }
      };
    },
    onAuthStateChange(callback: (event: AuthEvent, session: AppSession | null) => void) {
      authListeners.add(callback);
      queueMicrotask(() => callback("INITIAL_SESSION", currentSession));
      return {
        data: {
          subscription: {
            unsubscribe() {
              authListeners.delete(callback);
            }
          }
        }
      };
    },
    async resetPasswordForEmail(_email: string, _options?: Record<string, unknown>) {
      return {
        data: null,
        error: toError("Password reset is not implemented on this backend yet")
      };
    }
  }
};
