export class DuoPlusApiError extends Error {
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly duoCode: number | null;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    endpoint: string;
    httpStatus?: number | null;
    duoCode?: number | null;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "DuoPlusApiError";
    this.endpoint = options.endpoint;
    this.httpStatus = options.httpStatus ?? null;
    this.duoCode = options.duoCode ?? null;
    this.retryable = options.retryable ?? false;
  }

  get unauthorized(): boolean {
    return this.httpStatus === 401 || this.duoCode === 401;
  }
}

export function isDuoPlusApiError(value: unknown): value is DuoPlusApiError {
  return value instanceof DuoPlusApiError;
}

export class DuoPlusPaginationError extends DuoPlusApiError {
  constructor(options: { endpoint: string; resource: string; reason: string }) {
    super({
      endpoint: options.endpoint,
      retryable: true,
      message: `${options.resource} inventory was incomplete: ${options.reason}`,
    });
    this.name = "DuoPlusPaginationError";
  }
}

export function isDuoPlusPaginationError(
  value: unknown,
): value is DuoPlusPaginationError {
  return value instanceof DuoPlusPaginationError;
}
