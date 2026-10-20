/** An error the operator can act on; code and message are safe to show. */
export class HttpError extends Error {
  readonly name = "HttpError";
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** An error answered by the Ivora API, with its stable code. */
export class IvoraError extends Error {
  readonly name = "IvoraError";
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string | null = null,
  ) {
    super(message);
  }
}
