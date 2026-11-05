"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Button, Field, Textarea, TextInput } from "@/components/onboarding/primitives";
import { ApiError } from "@/lib/api/types";
import { submitFoundingApplication } from "@/lib/founding/api";
import {
  shareOnX,
  utmFromSearch,
  validateApplication,
  type ApplyErrors,
  type ApplyFields,
} from "@/lib/founding/apply";

type Phase = "idle" | "submitting" | "success" | "duplicate" | "closed" | "limited" | "error";

const EMPTY: ApplyFields = {
  email: "",
  xHandle: "",
  agentName: "",
  description: "",
};

export function ApplyForm({ open }: { open: boolean }) {
  const [fields, setFields] = useState<ApplyFields>(EMPTY);
  const [honeypot, setHoneypot] = useState("");
  const [errors, setErrors] = useState<ApplyErrors>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const utm = useMemo(
    () => (typeof window === "undefined" ? undefined : utmFromSearch(window.location.search)),
    [],
  );

  const shareHref =
    typeof window === "undefined"
      ? "https://x.com/intent/post"
      : shareOnX(`${window.location.origin}/founding-5?utm_source=x&utm_medium=share`);

  function set<K extends keyof ApplyFields>(key: K, value: ApplyFields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!open) {
      setPhase("closed");
      return;
    }
    const parsed = validateApplication(fields);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setPhase("idle");
      return;
    }
    setErrors({});
    setPhase("submitting");
    try {
      await submitFoundingApplication({
        ...parsed.value,
        utm,
        company_website: honeypot,
      });
      setPhase("success");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setPhase("duplicate");
          return;
        }
        if (err.status === 403) {
          setPhase("closed");
          return;
        }
        if (err.status === 429) {
          setPhase("limited");
          return;
        }
        if (err.status === 400 && Array.isArray(err.details)) {
          const next: ApplyErrors = {};
          for (const issue of err.details) {
            if (issue.path in EMPTY) next[issue.path as keyof ApplyFields] = issue.message;
          }
          if (Object.keys(next).length > 0) setErrors(next);
        }
      }
      setPhase("error");
    }
  }

  if (!open || phase === "closed") {
    return <p className="text-[15px] leading-[1.6] text-muted">Applications are closed.</p>;
  }

  if (phase === "success") {
    return (
      <div className="rounded-2xl border hairline bg-paper-2 px-6 py-8">
        <h3 className="text-[22px] font-medium tracking-[-0.01em]">You&rsquo;re in.</h3>
        <p className="mt-3 text-[15px] leading-[1.6] text-muted">
          We will contact you about the Arc mainnet beta. We do not promise a filing date.
        </p>
        <a
          href={shareHref}
          target="_blank"
          rel="noreferrer"
          className="mt-6 inline-flex items-center rounded-full bg-ink px-5 py-2.5 text-[13.5px] font-medium text-paper hover:bg-ink-hover"
        >
          Share on X
        </a>
      </div>
    );
  }

  const count = fields.description.trim().length;

  return (
    <form onSubmit={onSubmit} className="relative flex flex-col gap-5" noValidate>
      {phase === "duplicate" && (
        <p className="text-[13.5px] text-[#ff8a84]">
          This email or X handle already has an application.
        </p>
      )}
      {phase === "limited" && (
        <p className="text-[13.5px] text-[#ff8a84]">
          Too many attempts from this network. Try again in an hour.
        </p>
      )}
      {phase === "error" && (
        <p className="text-[13.5px] text-[#ff8a84]">Something went wrong. Try again in a moment.</p>
      )}

      <Field label="Email" htmlFor="founding-email" error={errors.email}>
        <TextInput
          id="founding-email"
          type="email"
          value={fields.email}
          invalid={Boolean(errors.email)}
          onChange={(event) => set("email", event.target.value)}
          autoComplete="email"
        />
      </Field>
      <Field label="X handle" htmlFor="founding-x" hint="Optional." error={errors.xHandle}>
        <TextInput
          id="founding-x"
          value={fields.xHandle}
          invalid={Boolean(errors.xHandle)}
          onChange={(event) => set("xHandle", event.target.value)}
          placeholder="name"
          autoComplete="off"
        />
      </Field>
      <Field label="Agent name" htmlFor="founding-agent" error={errors.agentName}>
        <TextInput
          id="founding-agent"
          value={fields.agentName}
          maxLength={80}
          invalid={Boolean(errors.agentName)}
          onChange={(event) => set("agentName", event.target.value)}
        />
      </Field>
      <Field
        label="What does your agent do?"
        htmlFor="founding-description"
        hint={`${count}/600`}
        error={errors.description}
      >
        <Textarea
          id="founding-description"
          value={fields.description}
          maxLength={600}
          rows={5}
          invalid={Boolean(errors.description)}
          onChange={(event) => set("description", event.target.value)}
        />
      </Field>

      <div className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0" aria-hidden="true">
        <label htmlFor="company_website">Company website</label>
        <input
          id="company_website"
          name="company_website"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(event) => setHoneypot(event.target.value)}
        />
      </div>

      <div>
        <Button type="submit" size="lg" loading={phase === "submitting"}>
          Submit application
        </Button>
      </div>
    </form>
  );
}
