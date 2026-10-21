import { STATUS } from "./types";

/**
 * Errors from calling a peer's OCPI API. Messages carry the method, host and path of
 * the request and the peer's status code and message; never a token or a query string.
 */
export class OcpiError extends Error {
  constructor(
    message: string,
    readonly details: {
      /** OCPI status_code from the response body, when there was one. */
      statusCode?: number;
      httpStatus?: number;
      /** `GET host/path`, without the query string. */
      request: string;
    },
  ) {
    super(message);
    this.name = "OcpiError";
  }
  get statusCode() {
    return this.details.statusCode;
  }
  get httpStatus() {
    return this.details.httpStatus;
  }
}

/** The peer answered with a 2xxx status: our request was wrong. */
export class OcpiClientError extends OcpiError {
  override name = "OcpiClientError";
}
/** The peer answered with a 3xxx status: it failed to handle a valid request. */
export class OcpiServerError extends OcpiError {
  override name = "OcpiServerError";
}
/** The peer answered with a 4xxx status: a hub could not route the request. */
export class OcpiHubError extends OcpiError {
  override name = "OcpiHubError";
}
/** The peer refused our token (HTTP 401 or 403). */
export class OcpiUnauthorizedError extends OcpiError {
  override name = "OcpiUnauthorizedError";
}
/**
 * No usable OCPI response: a network error, a timeout, a non-OCPI body or an HTTP error
 * without an envelope.
 */
export class OcpiTransportError extends OcpiError {
  override name = "OcpiTransportError";
}

/** Maps an OCPI status_code that is not a success to its error class. */
export function errorClassFor(statusCode: number) {
  if (statusCode >= 2000 && statusCode < 3000) return OcpiClientError;
  if (statusCode >= 3000 && statusCode < 4000) return OcpiServerError;
  if (statusCode >= 4000 && statusCode < 5000) return OcpiHubError;
  return OcpiError;
}

export const isSuccess = (statusCode: number) =>
  statusCode >= STATUS.SUCCESS && statusCode < 2000;

/**
 * A reply our OCPI server sends instead of handling a request: thrown inside a handler,
 * turned into an envelope by the server middleware. The message goes to the peer.
 */
export class OcpiProblem extends Error {
  constructor(
    readonly httpStatus: number,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "OcpiProblem";
  }
}
