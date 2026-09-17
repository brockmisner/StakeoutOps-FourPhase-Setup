export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function apiErrorResponse(error: unknown): Response {
  const headers = { "Cache-Control": "private, no-store" };
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ?? {}),
        },
      },
      { status: error.status, headers },
    );
  }

  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
      },
    },
    { status: 500, headers },
  );
}

export function dataResponse<T>(data: T, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "private, no-store");
  }
  return Response.json({ data }, { ...init, headers });
}
