"use client";

import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/components/landing/Nav";
import { WalletSignInCard } from "@/components/guardian/WalletSignInCard";
import { Button } from "@/components/onboarding/primitives";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { ApiError } from "@/lib/api/types";
import { formatFoundingWhen } from "@/lib/founding/apply";
import {
  downloadFoundingCsv,
  getFoundingApplication,
  listFoundingApplications,
  saveFoundingReview,
  setFoundingStatus,
  type FoundingDetail,
  type FoundingListItem,
  type FoundingStatus,
} from "@/lib/founding/api";

const STATUSES: FoundingStatus[] = ["new", "shortlist", "winner", "rejected", "waitlist"];

export function AdminReview() {
  const { session } = useAuth();
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<"date" | "score">("date");
  const [rows, setRows] = useState<FoundingListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FoundingDetail | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      const result = await listFoundingApplications(session.token, {
        status,
        sort,
        dir: "desc",
      });
      setRows(result.applications);
    } catch (err) {
      setRows([]);
      setError(err instanceof ApiError && err.status === 403 ? "not-reviewer" : "load");
    }
  }, [session, status, sort]);

  useEffect(() => {
    if (!session) return;
    let live = true;
    listFoundingApplications(session.token, { status, sort, dir: "desc" })
      .then((result) => {
        if (live) {
          setRows(result.applications);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!live) return;
        setRows([]);
        setError(err instanceof ApiError && err.status === 403 ? "not-reviewer" : "load");
      });
    return () => {
      live = false;
    };
  }, [session, status, sort]);

  useEffect(() => {
    if (!session || !selected) return;
    let live = true;
    getFoundingApplication(session.token, selected)
      .then((result) => {
        if (live) setDetail(result.application);
      })
      .catch(() => {
        if (live) setDetail(null);
      });
    return () => {
      live = false;
    };
  }, [session, selected]);

  return (
    <div className="flex min-h-full flex-1 flex-col bg-paper text-ink">
      <Nav />
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-6 py-10 lg:px-10">
        <h1 className="text-[28px] font-medium tracking-[-0.02em]">Founding 5</h1>
        <p className="mt-2 max-w-xl text-[14px] leading-[1.55] text-muted">
          Winner and waitlist are labels. This page does not send an invite.
        </p>

        {!session ? (
          <div className="mt-8 max-w-md">
            <WalletSignInCard body="Sign in with a reviewer wallet to read applications." />
          </div>
        ) : error === "not-reviewer" ? (
          <p className="mt-8 text-[14px] text-muted">This wallet is not a reviewer.</p>
        ) : (
          <>
            <div className="mt-8 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[12px] text-muted">
                Status
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className="rounded-xl border hairline-strong bg-paper-2 px-3 py-2 text-[13px] text-ink"
                >
                  <option value="">All</option>
                  {STATUSES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[12px] text-muted">
                Sort
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value === "score" ? "score" : "date")}
                  className="rounded-xl border hairline-strong bg-paper-2 px-3 py-2 text-[13px] text-ink"
                >
                  <option value="date">Date</option>
                  <option value="score">Score</option>
                </select>
              </label>
              <Button
                variant="ghost"
                onClick={() => downloadFoundingCsv(session.token).catch(() => setError("load"))}
              >
                Export CSV
              </Button>
            </div>

            {error === "load" && (
              <p className="mt-4 text-[13px] text-[#ff8a84]">Could not load applications.</p>
            )}

            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="text-[11px] uppercase tracking-[0.14em] text-muted-2">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Date</th>
                    <th className="py-2 pr-3 font-medium">Agent</th>
                    <th className="py-2 pr-3 font-medium">X</th>
                    <th className="py-2 pr-3 font-medium">Score</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer border-t hairline hover:bg-paper-2"
                      onClick={() => setSelected(row.id)}
                    >
                      <td className="py-3 pr-3 text-muted">
                        {formatFoundingWhen(row.createdAt)?.replace(" UTC", "")}
                      </td>
                      <td className="py-3 pr-3">{row.agentName}</td>
                      <td className="py-3 pr-3">
                        {row.xHandle ? (
                          <a
                            href={`https://x.com/${row.xHandle}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-accent-soft hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            @{row.xHandle}
                          </a>
                        ) : (
                          <span className="text-muted-2">None</span>
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        {row.averageScore === null
                          ? `${row.reviewCount}/3`
                          : row.averageScore.toFixed(1)}
                      </td>
                      <td className="py-3">{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows?.length === 0 && error !== "load" && (
                <p className="mt-4 text-[13px] text-muted">No applications yet.</p>
              )}
            </div>
          </>
        )}
      </main>

      {session && detail && detail.id === selected && (
        <DetailDrawer
          key={`${detail.id}:${detail.status}:${detail.reviews.map((review) => `${review.reviewer}:${review.updatedAt}`).join("|")}`}
          token={session.token}
          reviewer={session.address}
          detail={detail}
          onClose={() => setSelected(null)}
          onChanged={() => {
            load().catch(() => setError("load"));
            getFoundingApplication(session.token, detail.id)
              .then((result) => setDetail(result.application))
              .catch(() => setDetail(null));
          }}
        />
      )}
    </div>
  );
}

function DetailDrawer({
  token,
  reviewer,
  detail,
  onClose,
  onChanged,
}: {
  token: string;
  reviewer: string;
  detail: FoundingDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const mine = detail.reviews.find(
    (review) => review.reviewer.toLowerCase() === reviewer.toLowerCase(),
  );
  const [useCase, setUseCase] = useState(mine?.useCase ?? 3);
  const [moneyFlow, setMoneyFlow] = useState(mine?.moneyFlow ?? 3);
  const [builder, setBuilder] = useState(mine?.builder ?? 3);
  const [note, setNote] = useState(mine?.note ?? "");
  const [status, setStatus] = useState<FoundingStatus>(detail.status);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function saveReview() {
    setSaving(true);
    setMessage(null);
    try {
      await saveFoundingReview(token, detail.id, {
        useCase,
        moneyFlow,
        builder,
        note,
      });
      onChanged();
    } catch {
      setMessage("Could not save the score.");
    } finally {
      setSaving(false);
    }
  }

  async function saveStatus() {
    setSaving(true);
    setMessage(null);
    try {
      await setFoundingStatus(token, detail.id, status);
      onChanged();
    } catch {
      setMessage("Could not save the status.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close" onClick={onClose} />
      <aside className="relative h-full w-full max-w-md overflow-y-auto border-l hairline bg-paper px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[20px] font-medium">{detail.agentName}</h2>
          </div>
          <button type="button" onClick={onClose} className="text-[13px] text-muted hover:text-ink">
            Close
          </button>
        </div>
        <dl className="mt-6 flex flex-col gap-3 text-[13.5px]">
          <div>
            <dt className="text-muted-2">Email</dt>
            <dd>{detail.email}</dd>
          </div>
          {detail.xHandle && (
            <div>
              <dt className="text-muted-2">X</dt>
              <dd>
                <a href={`https://x.com/${detail.xHandle}`} className="text-accent-soft" target="_blank" rel="noreferrer">
                  @{detail.xHandle}
                </a>
              </dd>
            </div>
          )}
          <div>
            <dt className="text-muted-2">What it does</dt>
            <dd className="whitespace-pre-wrap leading-[1.55]">{detail.description}</dd>
          </div>
        </dl>

        <div className="mt-8 flex flex-col gap-3">
          <p className="text-[12px] uppercase tracking-[0.14em] text-muted-2">Your score</p>
          <Score label="Use case" value={useCase} onChange={setUseCase} />
          <Score label="Money" value={moneyFlow} onChange={setMoneyFlow} />
          <Score label="Builder" value={builder} onChange={setBuilder} />
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Note
            <textarea
              value={note}
              maxLength={2000}
              rows={3}
              onChange={(event) => setNote(event.target.value)}
              className="rounded-xl border hairline-strong bg-paper-2 px-3 py-2 text-[13px] text-ink"
            />
          </label>
          <Button onClick={saveReview} loading={saving}>
            Save score
          </Button>
        </div>

        <div className="mt-8 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as FoundingStatus)}
              className="rounded-xl border hairline-strong bg-paper-2 px-3 py-2 text-[13px] text-ink"
            >
              {STATUSES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <Button variant="ghost" onClick={saveStatus} loading={saving}>
            Save status
          </Button>
        </div>
        {message && <p className="mt-4 text-[13px] text-[#ff8a84]">{message}</p>}

        {detail.reviews.length > 0 && (
          <ul className="mt-8 flex flex-col gap-3 text-[12.5px] text-muted">
            {detail.reviews.map((review) => (
              <li key={review.reviewer}>
                {review.reviewer.slice(0, 6)}…{review.reviewer.slice(-4)} scored{" "}
                {review.useCase}/{review.moneyFlow}/{review.builder}
                {review.note ? `. ${review.note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function Score({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-[13px]">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded-lg border hairline-strong bg-paper-2 px-2 py-1 text-ink"
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
