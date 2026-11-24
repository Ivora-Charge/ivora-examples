const ID = /^[\x21-\x7e]{1,255}$/;

/**
 * The X-Request-ID and X-Correlation-ID of an OCPI answer: the request's own when they
 * are printable ASCII of at most 255 characters, a new UUID otherwise.
 */
export function ocpiRequestIds(h: Headers): {
  requestId: string;
  correlationId: string;
} {
  const pick = (name: string) => {
    const value = h.get(name) ?? "";
    return ID.test(value) ? value : crypto.randomUUID();
  };
  return {
    requestId: pick("X-Request-ID"),
    correlationId: pick("X-Correlation-ID"),
  };
}
