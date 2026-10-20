export type ErrorInfo = {
  error: string;
  message: string;
  requestId?: string | null;
  docs?: string | null;
};

/** Shows the API's code, the request ID and the portal link, never a bare "something went wrong". */
export function ErrorBox({
  info,
  title = "That didn't work",
}: {
  info: ErrorInfo;
  title?: string;
}) {
  return (
    <div className="notice bad" role="alert">
      <strong>{title}</strong>
      <p style={{ margin: "0.25rem 0" }}>{info.message}</p>
      <p className="muted" style={{ margin: 0 }}>
        Code <code>{info.error}</code>
        {info.requestId ? (
          <>
            {" "}
            · request <code>{info.requestId}</code>
          </>
        ) : null}
        {info.docs ? (
          <>
            {" "}
            · <a href={info.docs}>Errors and statuses</a>
          </>
        ) : null}
      </p>
    </div>
  );
}
