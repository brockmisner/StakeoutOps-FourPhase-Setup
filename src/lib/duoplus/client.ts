import {
  DuoPlusApiError,
  DuoPlusPaginationError,
  isDuoPlusApiError,
} from "./errors";
import {
  compactDuoPlusAuditValue,
  extractDuoPlusCursor,
  extractDuoPlusList,
  extractDuoPlusTotal,
  extractDuoPlusTotalPages,
  parseDuoPlusEnvelope,
  redactKnownSecrets,
} from "./protocol";
import { sanitizeDuoPlusTaskConfig } from "./task-config";
import {
  InMemoryRateSlotAllocator,
  type Clock,
  type RateSlotAllocator,
  type Sleeper,
  systemClock,
  systemSleeper,
  waitForReservedSlot,
} from "./rate-limit";
import type {
  DuoPlusAddTaskData,
  DuoPlusAddTaskInput,
  DuoPlusAddProxiesData,
  DuoPlusAddProxiesInput,
  DuoPlusCommandData,
  DuoPlusCommandInput,
  DuoPlusListPhonesInput,
  DuoPlusOutboundLogger,
  DuoPlusPhone,
  DuoPlusPhoneGroup,
  DuoPlusProxy,
  DuoPlusPowerInput,
  DuoPlusSetTaskStatusData,
  DuoPlusSetTaskStatusInput,
  DuoPlusSubscriptionCapacity,
  DuoPlusSubscriptionStartup,
  DuoPlusTask,
  DuoPlusTaskLog,
  DuoPlusTaskLogListInput,
  DuoPlusTaskListInput,
  DuoPlusTemplate,
  DuoPlusTemplateListInput,
  DuoPlusUpdatePhonesInput,
  DuoPlusUpdatePhonesData,
  DuoPlusUpdateTaskTimeInput,
} from "./types";

export const DUOPLUS_ENDPOINTS = {
  PHONE_LIST: "/api/v1/cloudPhone/list",
  PHONE_GROUP_LIST: "/api/v1/cloudPhone/groupList",
  POWER_ON: "/api/v1/cloudPhone/powerOn",
  POWER_OFF: "/api/v1/cloudPhone/powerOff",
  PHONE_COMMAND: "/api/v1/cloudPhone/command",
  PHONE_UPDATE: "/api/v1/cloudPhone/update",
  PROXY_LIST: "/api/v1/proxy/list",
  PROXY_ADD: "/api/v1/proxy/add",
  USER_TEMPLATE_LIST: "/api/v1/automation/userTemplateList",
  OFFICIAL_TEMPLATE_LIST: "/api/v1/automation/officialTemplateList",
  ADD_TASK: "/api/v1/automation/addTask",
  TASK_LIST: "/api/v1/automation/taskList",
  TASK_LOG_LIST: "/api/v1/automation/taskLogList",
  SET_TASK_STATUS: "/api/v1/automation/setTaskStatus",
  UPDATE_TASK_TIME: "/api/v1/automation/updateTaskTime",
  SUBSCRIPTION_STARTUP_LIST: "/api/v1/subscriptionStartup/list",
} as const;

function proxyCredentialsFromPayload(endpoint: string, body: unknown): string[] {
  if (
    (endpoint !== DUOPLUS_ENDPOINTS.PROXY_ADD &&
      endpoint !== DUOPLUS_ENDPOINTS.PROXY_LIST) ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return [];
  }

  const credentials: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const record = candidate as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (
        (key === "user" || key === "password") &&
        typeof value === "string" &&
        value.length > 0
      ) {
        credentials.push(value);
      } else {
        visit(value);
      }
    }
  };
  visit(body);
  return credentials;
}

function redactProxyCredentialFields(endpoint: string, value: unknown): unknown {
  if (
    endpoint !== DUOPLUS_ENDPOINTS.PROXY_ADD &&
    endpoint !== DUOPLUS_ENDPOINTS.PROXY_LIST
  ) {
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactProxyCredentialFields(endpoint, item));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key === "user" || key === "password"
        ? "[REDACTED]"
        : redactProxyCredentialFields(endpoint, item),
    ]),
  );
}

export interface DuoPlusClientOptions {
  apiKey: string;
  connectionId: string;
  baseUrl?: string;
  minGapMs?: number;
  fetchImpl?: typeof fetch;
  rateSlotAllocator?: RateSlotAllocator;
  logger?: DuoPlusOutboundLogger;
  clock?: Clock;
  sleeper?: Sleeper;
}

interface DuoPlusPostOptions {
  timeoutMs?: number;
}

/** A fixed, read-only hierarchy capture command used only for failure evidence. */
export const DUOPLUS_UI_HIERARCHY_DUMP_COMMAND = "uiautomator dump /dev/tty";

export class DuoPlusClient {
  private readonly apiKey: string;
  private readonly connectionId: string;
  private readonly baseUrl: string;
  private readonly minGapMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly rateSlotAllocator: RateSlotAllocator;
  private readonly logger?: DuoPlusOutboundLogger;
  private readonly clock: Clock;
  private readonly sleeper: Sleeper;

  constructor(options: DuoPlusClientOptions) {
    if (!options.apiKey.trim()) throw new Error("A DuoPlus API key is required");
    this.apiKey = options.apiKey.trim();
    this.connectionId = options.connectionId;
    this.baseUrl = (options.baseUrl ?? "https://openapi.duoplus.net").replace(/\/$/, "");
    this.minGapMs = options.minGapMs ?? 1_200;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.sleeper = options.sleeper ?? systemSleeper;
    this.rateSlotAllocator =
      options.rateSlotAllocator ?? new InMemoryRateSlotAllocator(this.clock);
    this.logger = options.logger;
  }

  async post<T>(
    endpoint: string,
    body: unknown,
    options: DuoPlusPostOptions = {},
  ): Promise<T> {
    await waitForReservedSlot(
      this.rateSlotAllocator,
      this.connectionId,
      this.minGapMs,
      { clock: this.clock, sleeper: this.sleeper },
    );

    const startedAt = this.clock.now();
    let httpStatus: number | null = null;
    let duoCode: number | null = null;
    let responseBody: unknown = null;
    let result: T | undefined;
    let caught: unknown;
    let ok = false;
    const sensitiveLiterals = [
      this.apiKey,
      ...proxyCredentialsFromPayload(endpoint, body),
    ];

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "DuoPlus-API-Key": this.apiKey,
          Lang: "en",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal:
          options.timeoutMs && options.timeoutMs > 0
            ? AbortSignal.timeout(options.timeoutMs)
            : undefined,
      });
      httpStatus = response.status;

      const rawText = await response.text();
      try {
        responseBody = rawText ? JSON.parse(rawText) : null;
      } catch {
        responseBody = { message: rawText.slice(0, 500) };
      }

      if (response.status === 401) {
        throw new DuoPlusApiError({
          endpoint,
          httpStatus: response.status,
          duoCode:
            responseBody && typeof responseBody === "object"
              ? Number((responseBody as Record<string, unknown>).code) || 401
              : 401,
          message: `${endpoint} 401: DuoPlus API key is invalid or expired`,
          retryable: false,
        });
      }

      if (!response.ok) {
        const reportedCode =
          responseBody && typeof responseBody === "object"
            ? Number((responseBody as Record<string, unknown>).code) || null
            : null;
        throw new DuoPlusApiError({
          endpoint,
          httpStatus: response.status,
          duoCode: reportedCode,
          message: `${endpoint} HTTP ${response.status}: DuoPlus request failed`,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      result = parseDuoPlusEnvelope<T>(responseBody, endpoint, response.status);
      ok = true;
      return result;
    } catch (error) {
      caught = error;
      if (isDuoPlusApiError(error)) {
        duoCode = error.duoCode;
        const errorSecrets = [
          ...sensitiveLiterals,
          ...proxyCredentialsFromPayload(endpoint, responseBody),
        ];
        const safeError = new DuoPlusApiError({
          endpoint: error.endpoint,
          httpStatus: error.httpStatus,
          duoCode: error.duoCode,
          retryable: error.retryable,
          message: redactKnownSecrets(error.message, errorSecrets) as string,
        });
        caught = safeError;
        throw safeError;
      }
      throw new DuoPlusApiError({
        endpoint,
        httpStatus,
        message: `${endpoint} network request failed`,
        retryable: true,
      });
    } finally {
      if (this.logger) {
        const logSecrets = [
          ...sensitiveLiterals,
          ...proxyCredentialsFromPayload(endpoint, responseBody),
        ];
        const rawLogError = caught instanceof Error ? caught.message : undefined;
        const logError = rawLogError
          ? (redactKnownSecrets(rawLogError, logSecrets) as string)
          : undefined;
        try {
          await this.logger.log({
            connectionId: this.connectionId,
            endpoint,
            startedAt,
            finishedAt: this.clock.now(),
            httpStatus,
            duoCode:
              duoCode ??
              (responseBody && typeof responseBody === "object"
                ? Number((responseBody as Record<string, unknown>).code) || null
                : null),
            ok,
            requestBody: compactDuoPlusAuditValue(
              redactProxyCredentialFields(
                endpoint,
                redactKnownSecrets(body, logSecrets),
              ),
            ),
            responseBody: compactDuoPlusAuditValue(
              redactProxyCredentialFields(
                endpoint,
                redactKnownSecrets(responseBody, logSecrets),
              ),
            ),
            errorMessage: logError,
          });
        } catch {
          // Audit logging is best effort and must never duplicate an outbound call.
        }
      }
    }
  }

  async listPhones(input: DuoPlusListPhonesInput = {}): Promise<DuoPlusPhone[]> {
    const data = await this.post<unknown>(DUOPLUS_ENDPOINTS.PHONE_LIST, input);
    return extractDuoPlusList<DuoPlusPhone>(data, DUOPLUS_ENDPOINTS.PHONE_LIST);
  }

  async listAllPhones(
    input: Omit<DuoPlusListPhonesInput, "page" | "page_size" | "pagesize"> = {},
  ): Promise<DuoPlusPhone[]> {
    return this.listCompleteInventory<DuoPlusPhone>(
      DUOPLUS_ENDPOINTS.PHONE_LIST,
      input,
      "Cloud phone",
    );
  }

  async getPhone(imageId: string): Promise<DuoPlusPhone | null> {
    const phones = await this.listPhones({ image_id: [imageId], page: 1, pagesize: 100 });
    return phones.find((phone) => phone.id === imageId) ?? null;
  }

  async listPhoneGroups(
    input: Record<string, unknown> = {},
  ): Promise<DuoPlusPhoneGroup[]> {
    const data = await this.post<unknown>(DUOPLUS_ENDPOINTS.PHONE_GROUP_LIST, input);
    return extractDuoPlusList<DuoPlusPhoneGroup>(
      data,
      DUOPLUS_ENDPOINTS.PHONE_GROUP_LIST,
    );
  }

  async listProxies(): Promise<DuoPlusProxy[]> {
    const proxies: DuoPlusProxy[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 100; page += 1) {
      const data = await this.post<unknown>(DUOPLUS_ENDPOINTS.PROXY_LIST, {
        page,
        pagesize: pageSize,
      });
      const rows = extractDuoPlusList<DuoPlusProxy>(
        data,
        DUOPLUS_ENDPOINTS.PROXY_LIST,
      );
      proxies.push(...rows);
      if (rows.length < pageSize) break;
    }
    return proxies;
  }

  addProxies(input: DuoPlusAddProxiesInput): Promise<DuoPlusAddProxiesData> {
    if (input.proxy_list.length < 1 || input.proxy_list.length > 20) {
      throw new Error("DuoPlus proxy batches must contain between 1 and 20 proxies");
    }
    for (const proxy of input.proxy_list) {
      if (!proxy.host.trim()) throw new Error("DuoPlus proxy host is required");
      if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65_535) {
        throw new Error("DuoPlus proxy port must be an integer between 1 and 65535");
      }
      if ((proxy.user === undefined) !== (proxy.password === undefined)) {
        throw new Error("DuoPlus proxy user and password must be provided together");
      }
    }
    return this.post(DUOPLUS_ENDPOINTS.PROXY_ADD, input);
  }

  async listSubscriptionStartups(
    freeStatus: 0 | 1,
  ): Promise<DuoPlusSubscriptionStartup[]> {
    return this.listCompleteInventory<DuoPlusSubscriptionStartup>(
      DUOPLUS_ENDPOINTS.SUBSCRIPTION_STARTUP_LIST,
      { free_status: freeStatus },
      freeStatus === 0
        ? "Assigned Subscription Startup"
        : "Available Subscription Startup",
    );
  }

  async getSubscriptionStartupCapacity(
    now = new Date(),
  ): Promise<DuoPlusSubscriptionCapacity> {
    // The endpoint requires free_status, so both pools are requested. The
    // shared rate-slot allocator keeps these calls inside DuoPlus' one-QPS
    // contract even when another worker is active.
    const assigned = await this.listSubscriptionStartups(0);
    const available = await this.listSubscriptionStartups(1);
    const isCurrent = (subscription: DuoPlusSubscriptionStartup) => {
      const rawRenewal = subscription.need_renewal;
      const renewalValue = typeof rawRenewal === "string"
        ? rawRenewal.trim().toLowerCase()
        : rawRenewal;
      if (
        renewalValue !== undefined &&
        renewalValue !== false &&
        renewalValue !== 0 &&
        renewalValue !== "0" &&
        renewalValue !== "false" &&
        renewalValue !== true &&
        renewalValue !== 1 &&
        renewalValue !== "1" &&
        renewalValue !== "true"
      ) {
        throw new DuoPlusApiError({
          endpoint: DUOPLUS_ENDPOINTS.SUBSCRIPTION_STARTUP_LIST,
          message:
            "DuoPlus Subscription Startup inventory returned an invalid need_renewal value",
          retryable: true,
        });
      }
      const rawExpiration = subscription.expired_at;
      const hasNumericShape =
        (typeof rawExpiration === "number" && Number.isFinite(rawExpiration)) ||
        (typeof rawExpiration === "string" &&
          rawExpiration.trim().length > 0 &&
          Number.isFinite(Number(rawExpiration)));
      if (!hasNumericShape) {
        throw new DuoPlusApiError({
          endpoint: DUOPLUS_ENDPOINTS.SUBSCRIPTION_STARTUP_LIST,
          message:
            "DuoPlus Subscription Startup inventory returned an invalid expired_at value",
          retryable: true,
        });
      }
      // `need_renewal` is an advance renewal warning, not proof that the
      // purchased Startup slot is unavailable. Expiration is the actual
      // eligibility boundary; dropping warned records undercounted a
      // three-slot subscription as one slot.
      return Number(rawExpiration) * 1_000 > now.getTime();
    };
    const currentAssigned = assigned.filter(isCurrent);
    const assignedIds = new Set(currentAssigned.map((subscription) => subscription.id));
    // The two provider lists are fetched sequentially. A Startup slot can move
    // from available to assigned between those requests and briefly appear in
    // both responses. Count that overlap once, conservatively as in use.
    const currentAvailableIds = new Set(
      available
        .filter(isCurrent)
        .map((subscription) => subscription.id)
        .filter((id) => !assignedIds.has(id)),
    );
    const inUse = assignedIds.size;
    const free = currentAvailableIds.size;
    return { total: inUse + free, inUse, available: free };
  }

  powerOn(imageIds: string[]): Promise<unknown> {
    const body: DuoPlusPowerInput = { image_ids: imageIds };
    return this.post(DUOPLUS_ENDPOINTS.POWER_ON, body);
  }

  powerOff(imageIds: string[]): Promise<unknown> {
    const body: DuoPlusPowerInput = { image_ids: imageIds };
    return this.post(DUOPLUS_ENDPOINTS.POWER_OFF, body);
  }

  dumpUiHierarchy(imageId: string): Promise<DuoPlusCommandData> {
    if (!imageId.trim()) throw new Error("DuoPlus image id is required");
    const body: DuoPlusCommandInput = {
      image_id: imageId.trim(),
      command: DUOPLUS_UI_HIERARCHY_DUMP_COMMAND,
    };
    // DuoPlus documents cloudPhone/command for commands that complete within
    // ten seconds. Abort locally at that same boundary so diagnostics can
    // never hold a scheduler invocation open indefinitely.
    return this.post(DUOPLUS_ENDPOINTS.PHONE_COMMAND, body, {
      timeoutMs: 10_000,
    });
  }

  updatePhones(input: DuoPlusUpdatePhonesInput): Promise<DuoPlusUpdatePhonesData> {
    if (input.images.length < 1 || input.images.length > 20) {
      throw new Error("DuoPlus phone updates must contain between 1 and 20 phones");
    }
    return this.post(DUOPLUS_ENDPOINTS.PHONE_UPDATE, input);
  }

  private async listCompleteInventory<T extends { id: string }>(
    endpoint: string,
    filters: Record<string, unknown>,
    resource: string,
  ): Promise<T[]> {
    const pageSize = 100;
    // Five inventories are fetched serially under the one-QPS contract. A
    // 40-page/source ceiling keeps the worst complete sync within this
    // route's 300-second Pro duration while still allowing 4,000 rows/source.
    const maxPages = 40;
    const rowsById = new Map<string, T>();
    let expectedTotal: number | null = null;
    let expectedTotalPages: number | null = null;

    for (let page = 1; page <= maxPages; page += 1) {
      const data = await this.post<unknown>(endpoint, {
        ...filters,
        page,
        pagesize: pageSize,
      });
      const pageRows = extractDuoPlusList<T>(data, endpoint);
      const pageTotal = extractDuoPlusTotal(data);
      const pageTotalPages = extractDuoPlusTotalPages(data);

      if (
        (expectedTotal !== null && pageTotal !== null && pageTotal !== expectedTotal) ||
        (expectedTotalPages !== null &&
          pageTotalPages !== null &&
          pageTotalPages !== expectedTotalPages)
      ) {
        throw new DuoPlusPaginationError({
          endpoint,
          resource,
          reason: "DuoPlus changed its pagination totals during the fetch",
        });
      }
      expectedTotal ??= pageTotal;
      expectedTotalPages ??= pageTotalPages;

      let added = 0;
      for (const [rowIndex, row] of pageRows.entries()) {
        if (typeof row?.id !== "string" || !row.id.trim()) {
          throw new DuoPlusPaginationError({
            endpoint,
            resource,
            reason: `page ${page} row ${rowIndex + 1} was missing a nonblank string id`,
          });
        }
        const id = row.id.trim();
        if (rowsById.has(id)) continue;
        rowsById.set(id, { ...row, id });
        added += 1;
      }

      if (expectedTotal !== null && rowsById.size > expectedTotal) {
        throw new DuoPlusPaginationError({
          endpoint,
          resource,
          reason: "DuoPlus returned more unique rows than its reported total",
        });
      }
      if (pageRows.length > 0 && added === 0) {
        throw new DuoPlusPaginationError({
          endpoint,
          resource,
          reason: `page ${page} repeated rows before completion`,
        });
      }

      const reachedReportedCount =
        expectedTotal !== null && rowsById.size === expectedTotal;
      const reachedReportedLastPage =
        expectedTotalPages !== null && page >= expectedTotalPages;

      if (
        expectedTotalPages === 0 &&
        pageRows.length > 0
      ) {
        throw new DuoPlusPaginationError({
          endpoint,
          resource,
          reason: "DuoPlus reported zero pages but returned inventory rows",
        });
      }

      // When DuoPlus supplies both totals, they must agree on completion.
      // Returning as soon as either one is satisfied can silently truncate a
      // catalog when upstream reports contradictory metadata.
      if (
        reachedReportedCount &&
        expectedTotalPages !== null &&
        !reachedReportedLastPage
      ) {
        throw new DuoPlusPaginationError({
          endpoint,
          resource,
          reason: `reported total was reached on page ${page} before reported page ${expectedTotalPages}`,
        });
      }
      if (reachedReportedLastPage) {
        if (expectedTotal !== null && rowsById.size !== expectedTotal) {
          throw new DuoPlusPaginationError({
            endpoint,
            resource,
            reason: `received ${rowsById.size} of ${expectedTotal} reported rows`,
          });
        }
        return [...rowsById.values()];
      }
      if (reachedReportedCount) return [...rowsById.values()];

      if (pageRows.length < pageSize) {
        if (
          (expectedTotal !== null && rowsById.size < expectedTotal) ||
          (expectedTotalPages !== null && page < expectedTotalPages)
        ) {
          throw new DuoPlusPaginationError({
            endpoint,
            resource,
            reason: `page ${page} ended before the reported inventory was complete`,
          });
        }
        return [...rowsById.values()];
      }
    }

    throw new DuoPlusPaginationError({
      endpoint,
      resource,
      reason: `more than ${maxPages * pageSize} rows requires a resumable sync`,
    });
  }

  private async listAllTemplates(
    endpoint:
      | typeof DUOPLUS_ENDPOINTS.USER_TEMPLATE_LIST
      | typeof DUOPLUS_ENDPOINTS.OFFICIAL_TEMPLATE_LIST,
    input: DuoPlusTemplateListInput = {},
  ): Promise<DuoPlusTemplate[]> {
    return this.listCompleteInventory<DuoPlusTemplate>(
      endpoint,
      input.name === undefined ? {} : { name: input.name },
      endpoint === DUOPLUS_ENDPOINTS.OFFICIAL_TEMPLATE_LIST
        ? "Official template"
        : "Custom template",
    );
  }

  listUserTemplates(
    input: DuoPlusTemplateListInput = {},
  ): Promise<DuoPlusTemplate[]> {
    return this.listAllTemplates(DUOPLUS_ENDPOINTS.USER_TEMPLATE_LIST, input);
  }

  listOfficialTemplates(
    input: DuoPlusTemplateListInput = {},
  ): Promise<DuoPlusTemplate[]> {
    return this.listAllTemplates(DUOPLUS_ENDPOINTS.OFFICIAL_TEMPLATE_LIST, input);
  }

  addTask(input: DuoPlusAddTaskInput): Promise<DuoPlusAddTaskData> {
    if (input.template_type !== 1 && input.template_type !== 2) {
      throw new Error("DuoPlus template type must be numeric 1 or 2");
    }
    return this.post(DUOPLUS_ENDPOINTS.ADD_TASK, {
      ...input,
      images: input.images.map((image) =>
        image.config
          ? { ...image, config: sanitizeDuoPlusTaskConfig(image.config) }
          : image,
      ),
    });
  }

  async listTasks(input: DuoPlusTaskListInput): Promise<DuoPlusTask[]> {
    const data = await this.post<unknown>(DUOPLUS_ENDPOINTS.TASK_LIST, input);
    return extractDuoPlusList<DuoPlusTask>(data, DUOPLUS_ENDPOINTS.TASK_LIST);
  }

  async listTaskLogs(input: DuoPlusTaskLogListInput): Promise<DuoPlusTaskLog[]> {
    const logs: DuoPlusTaskLog[] = [];
    let cursor = input.cursor_id;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 10 && logs.length < 1_000; page += 1) {
      const data = await this.post<unknown>(DUOPLUS_ENDPOINTS.TASK_LOG_LIST, {
        ...input,
        cursor_id: cursor,
      });
      const pageLogs = extractDuoPlusList<DuoPlusTaskLog>(
        data,
        DUOPLUS_ENDPOINTS.TASK_LOG_LIST,
      );
      logs.push(...pageLogs);
      const nextCursor = extractDuoPlusCursor(data);
      if (nextCursor === null || pageLogs.length === 0) break;
      const cursorKey = String(nextCursor);
      if (seenCursors.has(cursorKey)) break;
      seenCursors.add(cursorKey);
      cursor = nextCursor;
    }
    return logs.slice(0, 1_000);
  }

  setTaskStatus(
    input: DuoPlusSetTaskStatusInput,
  ): Promise<DuoPlusSetTaskStatusData> {
    return this.post(DUOPLUS_ENDPOINTS.SET_TASK_STATUS, input);
  }

  cancelTasks(ids: string[]): Promise<DuoPlusSetTaskStatusData> {
    return this.setTaskStatus({ ids, status: 5 });
  }

  rerunTasks(ids: string[]): Promise<DuoPlusSetTaskStatusData> {
    return this.setTaskStatus({ ids, status: 0 });
  }

  updateTaskTime(input: DuoPlusUpdateTaskTimeInput): Promise<unknown> {
    return this.post(DUOPLUS_ENDPOINTS.UPDATE_TASK_TIME, input);
  }
}

export function createDuoPlusClient(options: DuoPlusClientOptions): DuoPlusClient {
  return new DuoPlusClient(options);
}
