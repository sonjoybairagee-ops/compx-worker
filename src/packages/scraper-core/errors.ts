export enum ProviderErrorType {
  TIMEOUT = "TIMEOUT",
  EMPTY_RESULT = "EMPTY_RESULT",
  HTML_PARSE = "HTML_PARSE",
  UNAUTHORIZED = "UNAUTHORIZED",     // 401
  PAYMENT_REQUIRED = "PAYMENT_REQUIRED", // 402
  FORBIDDEN = "FORBIDDEN",           // 403
  RATE_LIMIT = "RATE_LIMIT",         // 429
  SERVER_ERROR = "SERVER_ERROR",     // 5xx
  CIRCUIT_OPEN = "CIRCUIT_OPEN",
  UNKNOWN = "UNKNOWN",
}

export class ProviderError extends Error {
  constructor(public type: ProviderErrorType, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
