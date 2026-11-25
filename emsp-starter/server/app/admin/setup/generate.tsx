"use client";

import { useEffect, useRef, useState } from "react";
import { generateSetting, type GeneratedSetting } from "@/lib/setup/generate";
import { Icon } from "../ui/kit";
import { Copy } from "../ui/parts";

const PURPOSE: Record<GeneratedSetting, string> = {
  OCPI_TOKEN_ENCRYPTION_KEY: "the key that encrypts stored peer tokens",
  CRON_SECRET: "the secret the scheduled job is called with",
};

/**
 * A Generate button per setting. A value is made in the browser when its button is
 * pressed and lives only in this component's state: it goes into no form, request,
 * address or browser storage, so the server never has it, and leaving or reloading the
 * page loses it.
 */
export function Generator({ names }: { names: readonly GeneratedSetting[] }) {
  return (
    <div className="stack">
      {names.includes("OCPI_TOKEN_ENCRYPTION_KEY") && (
        <div className="msg limit" role="note">
          <p className="t">
            <Icon name="alert" />
            <span>Keep the encryption key you have.</span>
          </p>
          <p>
            Replacing <code>OCPI_TOKEN_ENCRYPTION_KEY</code> after peers are
            registered makes their stored tokens unreadable, and stored
            live-data API keys too: every peer would have to register again and
            every key be entered again. If peers were registered with an earlier
            key, put that key back instead.
          </p>
        </div>
      )}
      {names.map((name) => (
        <Setting key={name} name={name} />
      ))}
      <p className="small muted">
        Made in your browser: this page does not send a value to the server or
        save it anywhere.
      </p>
    </div>
  );
}

/** One setting: its button, then, once pressed, its new value in the button's place. */
function Setting({ name }: { name: GeneratedSetting }) {
  const [value, setValue] = useState<string | null>(null);
  if (value !== null) return <NewValue name={name} value={value} />;
  return (
    <div className="stack tight">
      <p>
        <code>{name}</code>: {PURPOSE[name]}.
      </p>
      <p>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => setValue(generateSetting(name))}
        >
          Generate<span className="sr"> {name}</span>
        </button>
      </p>
    </div>
  );
}

/**
 * A value just made, shown this once: with a copy button, where to paste it and the
 * redeploy that makes it count. It takes the focus the button had.
 */
export function NewValue({
  name,
  value,
}: {
  name: GeneratedSetting;
  value: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div
      className="stack tight"
      ref={box}
      tabIndex={-1}
      role="group"
      aria-label={`New value for ${name}`}
    >
      <p>
        New value for <code>{name}</code>, shown only now: copy it before you
        leave or reload this page.
      </p>
      <Copy text={value} label={`Value of ${name}`} />
      <p>
        Paste it into your host&apos;s environment settings, as the value of{" "}
        <code>{name}</code>. On Vercel: your project, then Settings, then
        Environment Variables. Then redeploy: a changed variable only reaches a
        new deployment.
      </p>
    </div>
  );
}
