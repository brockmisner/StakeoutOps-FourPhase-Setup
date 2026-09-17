export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface DuoPlusEnvelope<T> {
  code: number;
  data: T;
  message?: string;
  msg?: string;
}

export const DUOPLUS_PHONE_STATUS = {
  NOT_CONFIGURED: 0,
  ON: 1,
  OFF: 2,
  EXPIRED: 3,
  RENEWAL_OVERDUE: 4,
  POWERING_ON: 10,
  CONFIGURING: 11,
  CONFIG_FAILED: 12,
} as const;

export type DuoPlusPhoneStatus =
  (typeof DUOPLUS_PHONE_STATUS)[keyof typeof DUOPLUS_PHONE_STATUS];

export interface DuoPlusPhone {
  id: string;
  name?: string;
  status: number;
  adb?: string;
  adb_password?: string;
  ip?: string;
  os?: string;
  expired_at?: string;
  [key: string]: unknown;
}

export interface DuoPlusTemplate {
  id: string;
  name?: string;
  /** Official-template responses use `desc`; some user-template responses use `description`. */
  desc?: string;
  description?: string;
  [key: string]: unknown;
}

export interface DuoPlusTemplateListInput {
  name?: string;
}

export interface DuoPlusPhoneGroup {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface DuoPlusProxy {
  id: string;
  name?: string;
  host?: string;
  port?: string | number;
  user?: string;
  area?: string;
  group_ids?: string[];
  group_name?: string[];
  [key: string]: unknown;
}

export interface DuoPlusProxyInput {
  protocol: "socks5" | "http" | "https";
  host: string;
  port: number;
  user?: string;
  password?: string;
  name?: string;
}

export interface DuoPlusAddProxiesInput {
  proxy_list: DuoPlusProxyInput[];
  ip_scan_channel?: "ip2location" | "ipapi";
}

export interface DuoPlusAddProxiesData {
  success?: Array<{ index: number; id: string }>;
  fail?: Array<{ index: number; message?: string }>;
  [key: string]: unknown;
}

export interface DuoPlusSubscriptionStartup {
  id: string;
  name?: string;
  /** 0 is currently assigned/in use; 1 is available. */
  free_status: 0 | 1;
  expired_at?: string | number;
  /** Provider payloads have used booleans, 0/1, and numeric strings. */
  need_renewal?: boolean | number | string;
  [key: string]: unknown;
}

export interface DuoPlusSubscriptionCapacity {
  total: number;
  inUse: number;
  available: number;
}

export interface DuoPlusPage<T> {
  list?: T[];
  rows?: T[];
  data?: T[];
  total?: number;
  cursor_id?: string | number | null;
  [key: string]: unknown;
}

export interface DuoPlusListPhonesInput {
  page?: number;
  page_size?: number;
  pagesize?: number;
  image_id?: string[];
  group_id?: string;
  link_status?: number[];
  [key: string]: unknown;
}

export interface DuoPlusPowerInput {
  image_ids: string[];
}

export interface DuoPlusCommandInput {
  image_id: string;
  /** Shell command only. DuoPlus explicitly says not to prefix it with `adb shell`. */
  command: string;
}

export interface DuoPlusCommandData {
  output?: string;
  result?: unknown;
  message?: string;
  [key: string]: unknown;
}

export interface DuoPlusGpsSettings {
  /** 1 derives fake GPS from proxy IP; 2 uses explicit coordinates. */
  type: 1 | 2;
  /** DuoPlus documents strings but also shows numeric coordinates in examples. */
  longitude?: number | string;
  latitude?: number | string;
}

export interface DuoPlusLocaleSettings {
  type: 1 | 2;
  timezone?: string;
  language?: string;
}

export interface DuoPlusPhoneUpdate {
  image_id: string;
  proxy?: {
    id: string;
    dns?: 1 | 2;
  };
  gps?: DuoPlusGpsSettings;
  locale?: DuoPlusLocaleSettings;
  [key: string]: unknown;
}

export interface DuoPlusUpdatePhonesInput {
  images: DuoPlusPhoneUpdate[];
}

export interface DuoPlusUpdatePhonesData {
  success?: string[];
  fail?: string[];
  fail_reason?: Record<string, string> | string;
  [key: string]: unknown;
}

export type DuoPlusConfigValueType =
  | "string"
  | "number"
  | "boolean"
  | "textarea"
  | "file"
  | "excel";

interface DuoPlusTaskConfigEntryBase {
  key: string;
  required: boolean;
}

/**
 * DuoPlus validates a config value against its declared type. Keep this a
 * discriminated union so callers cannot accidentally send (for example) a
 * numeric value with `type: "file"`.
 */
export type DuoPlusTaskConfigEntry =
  | (DuoPlusTaskConfigEntryBase & {
      value: string;
      type: "string" | "textarea";
    })
  | (DuoPlusTaskConfigEntryBase & {
      /** DuoPlus documents numeric strings; native numbers are also accepted. */
      value: string | number;
      type: "number";
    })
  | (DuoPlusTaskConfigEntryBase & {
      /** DuoPlus documents "true"/"false" strings; native booleans remain valid. */
      value: string | boolean;
      type: "boolean";
    })
  | (DuoPlusTaskConfigEntryBase & {
      value: string[];
      type: "file";
    })
  | (DuoPlusTaskConfigEntryBase & {
      value: string | string[];
      type: "excel";
    });

export interface DuoPlusTaskImageInput {
  image_id: string;
  /** DuoPlus expects UTC as YYYY-MM-DD HH:mm. */
  issue_at: string;
  config?: Record<string, DuoPlusTaskConfigEntry>;
}

export interface DuoPlusAddTaskInput {
  template_id: string;
  template_type: 1 | 2;
  name: string;
  remark?: string;
  images: DuoPlusTaskImageInput[];
}

export interface DuoPlusAddTaskData {
  message?: string;
  id?: string;
  task_id?: string;
  [key: string]: unknown;
}

export interface DuoPlusTask {
  id: string;
  name?: string;
  image_id?: string;
  image_name?: string;
  ip?: string;
  remark?: string;
  task_type_name?: string;
  issue_at?: string;
  status: number;
  start_at?: string;
  /** Documented DuoPlus terminal timestamp field. */
  finish_at?: string;
  /** Kept for compatibility with older/alternate response shapes. */
  finished_at?: string;
  cost_time?: number;
  execution_time?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface DuoPlusTaskListInput {
  /** DuoPlus taskList requires YYYY-MM-DD HH:mm:ss. */
  issue_at_start: string;
  /** DuoPlus taskList requires YYYY-MM-DD HH:mm:ss. */
  issue_at_end: string;
  id?: string;
  execution_at_start?: string;
  execution_at_end?: string;
  status?: number[];
  template_type?: Array<1 | 2>;
  name?: string;
  image_id?: string;
  image_name?: string;
  image_ip?: string;
  sort_by?: "issue_at" | "created_at";
  order?: "asc" | "desc";
  page?: number;
  page_size?: number;
  pagesize?: number;
  [key: string]: unknown;
}

export interface DuoPlusTaskLog {
  id?: string;
  task_id?: string;
  node_name?: string;
  result?: unknown;
  error_message?: string;
  start_at?: string;
  finish_at?: string;
  created_at?: string;
  result_info?: {
    action?: string;
    result?: boolean;
    error_message?: string;
    condition_result_message?: string;
    extra_data?: {
      screenshot?: string | string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface DuoPlusTaskLogListInput {
  task_id: string;
  cursor_id?: string | number;
  page_size?: number;
  pagesize?: number;
  [key: string]: unknown;
}

export interface DuoPlusSetTaskStatusData {
  success?: string[];
  fail?: string[];
  fail_reason?: Record<string, string> | string;
  [key: string]: unknown;
}

export interface DuoPlusSetTaskStatusInput {
  ids: string[];
  /** 0 re-runs, 5 cancels. */
  status: 0 | 5;
}

export interface DuoPlusUpdateTaskTimeInput {
  ids: string[];
  issue_at: string;
}

export interface DuoPlusRequestMeta {
  connectionId: string;
  endpoint: string;
  startedAt: Date;
  finishedAt: Date;
  httpStatus: number | null;
  duoCode: number | null;
  ok: boolean;
  requestBody: unknown;
  responseBody: unknown;
  errorMessage?: string;
}

export interface DuoPlusOutboundLogger {
  log(meta: DuoPlusRequestMeta): Promise<void>;
}
