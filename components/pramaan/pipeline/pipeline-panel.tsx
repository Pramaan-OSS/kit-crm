"use client";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api, useResource } from "../../../lib/pramaan/client";
import type { Deal, PipelineData, Stage } from "../../../lib/pramaan/pipeline";

const field = "block w-full rounded border bg-background p-2";
const button = "rounded border px-3 py-2 hover:bg-muted disabled:opacity-50";
const money = (value: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
const day = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );

export function PipelinePanel() {
  const [view, setView] = useState<"board" | "list">("board");
  const [filter, setFilter] = useState("");
  const [byRenewal, setByRenewal] = useState(false);
  const params = new URLSearchParams(
    view === "list"
      ? { ...(filter ? { stage: filter } : {}), ...(byRenewal ? { sort: "renewal" } : {}) }
      : {},
  ).toString();
  const query = params ? `?${params}` : "";
  const { data, error, loading, reload } = useResource<PipelineData>(
    `/api/pramaan/pipeline${query}`,
  );
  const [editing, setEditing] = useState<Deal | "new">();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [grabbed, setGrabbed] = useState<string>();
  const [deleting, setDeleting] = useState<Deal>();
  const addButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnToEdit = useRef<string | "new" | undefined>(undefined);
  const focusAfterMove = useRef<{ id: string; stageId: string } | undefined>(undefined);
  const stages = data?.stages ?? [];

  useEffect(() => {
    const target = focusAfterMove.current;
    if (
      !busy &&
      target &&
      data?.deals.some((d) => d.id === target.id && d.stageId === target.stageId)
    ) {
      moveButtons.current.get(target.id)?.focus();
      focusAfterMove.current = undefined;
    }
    if (!editing && returnToEdit.current) {
      const id = returnToEdit.current;
      (id === "new" ? addButton.current : editButtons.current.get(id))?.focus();
      returnToEdit.current = undefined;
    }
  }, [busy, data, editing]);

  async function save(body: Record<string, unknown>, success = "Saved.") {
    if (busy || (typeof editing === "object" && editing.id === body.id && body.action !== "save"))
      return false;
    setBusy(true);
    setMessage("");
    setConflict(false);
    try {
      await api("/api/pramaan/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      reload();
      setMessage(success);
      return true;
    } catch (e) {
      setConflict(e instanceof ApiError && e.status === 409);
      setMessage(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function closeEditor() {
    returnToEdit.current = editing === "new" ? "new" : editing?.id;
    setEditing(undefined);
  }
  async function move(deal: Deal, stage: Stage) {
    if (busy || (typeof editing === "object" && editing.id === deal.id)) return;
    if (stage.id === deal.stageId) {
      setMessage(`${deal.title} is already in ${stage.name}.`);
      return;
    }
    focusAfterMove.current = { id: deal.id, stageId: stage.id };
    const saved = await save(
      { action: "move", id: deal.id, revision: deal.revision, stageId: stage.id },
      `${deal.title} moved to ${stage.name}.`,
    );
    if (!saved) {
      focusAfterMove.current = undefined;
      moveButtons.current.get(deal.id)?.focus();
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const card = editing && editing !== "new" ? editing : undefined;
    const saved = await save({
      action: "save",
      id: card?.id,
      revision: card?.revision,
      title: form.get("title"),
      kind: form.get("kind"),
      value: Number(form.get("value")),
      owner: form.get("owner"),
      companyId: form.get("companyId") ?? "",
      contactId: form.get("contactId") ?? "",
      renewalOn: form.get("renewalOn") ?? "",
      ...(card ? {} : { stageId: form.get("stageId") }),
    });
    if (saved) closeEditor();
  }
  if (loading && !data) return <p role="status">Loading pipeline…</p>;
  if (error)
    return (
      <div role="alert">
        <p>{error.message}</p>
        <button type="button" className={button} onClick={reload}>
          Try again
        </button>
      </div>
    );
  const draft = editing && editing !== "new" ? editing : undefined;
  return (
    <div className="space-y-5">
      <button
        type="button"
        ref={addButton}
        className={button}
        disabled={busy}
        onClick={() => {
          setEditing("new");
          setMessage("");
          setConflict(false);
        }}
      >
        Add card
      </button>{" "}
      <button
        type="button"
        className={button}
        aria-pressed={view === "list"}
        onClick={() => setView(view === "board" ? "list" : "board")}
      >
        {view === "board" ? "Show as list" : "Show as board"}
      </button>
      {data?.canEdit && <StageSettings stages={stages} busy={busy} save={save} />}
      <p id="pipeline-help" className="text-sm text-muted-foreground">
        Drag a card to another stage, or focus its move handle and use the left and right arrow
        keys. You can also choose a stage on each card.
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {conflict && (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => {
            reload();
            setMessage("Latest cards requested. Your draft is still open.");
          }}
        >
          Refresh board
        </button>
      )}
      {editing && (
        <form
          aria-label="Card"
          key={draft ? `${draft.id}-${draft.revision}` : "new"}
          className="grid gap-3 rounded border p-4 sm:grid-cols-2"
          onSubmit={submit}
        >
          <label>
            Title
            <input
              data-focus-on-open
              name="title"
              className={field}
              required
              maxLength={200}
              defaultValue={draft?.title}
            />
          </label>
          <label>
            Type
            <select
              aria-label="Type"
              name="kind"
              className={field}
              defaultValue={draft?.kind ?? "deal"}
            >
              <option value="deal">Deal</option>
              <option value="task">Task</option>
            </select>
          </label>
          <label>
            Value (£)
            <input
              name="value"
              type="number"
              min="0"
              max="1000000000000"
              step="0.01"
              className={field}
              required
              defaultValue={draft?.value ?? 0}
            />
          </label>
          <label>
            Owner
            <input
              name="owner"
              className={field}
              required
              maxLength={200}
              defaultValue={draft?.owner}
            />
          </label>
          <label>
            Renewal date (optional)
            <input
              name="renewalOn"
              type="date"
              className={field}
              defaultValue={draft?.renewalOn ?? ""}
            />
          </label>
          <label>
            Company
            <select
              aria-label="Company"
              name="companyId"
              className={field}
              defaultValue={draft?.companyId ?? ""}
            >
              <option value="">No company</option>
              {data?.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Person
            <select
              aria-label="Person"
              name="contactId"
              className={field}
              defaultValue={draft?.contactId ?? ""}
            >
              <option value="">No person</option>
              {data?.people.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {!draft && (
            <label>
              Stage
              <select
                aria-label="Stage"
                name="stageId"
                className={field}
                defaultValue={stages[0]?.id}
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft && <p>Save or cancel this edit before moving or deleting this card.</p>}
          <div className="flex flex-wrap items-end gap-2">
            <button type="submit" className={button} disabled={busy}>
              Save card
            </button>
            <button type="button" className={button} disabled={busy} onClick={closeEditor}>
              Cancel
            </button>
            {conflict && draft && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={async () => {
                  try {
                    const latest = await api<PipelineData>("/api/pramaan/pipeline");
                    const card = latest.deals.find((d) => d.id === draft.id);
                    if (!card) {
                      setMessage("This card is no longer available.");
                      return;
                    }
                    setEditing(card);
                    setConflict(false);
                    reload();
                    setMessage("Latest card loaded. Please enter your changes again.");
                  } catch (e) {
                    setMessage(
                      e instanceof Error ? e.message : "Something went wrong. Please try again.",
                    );
                  }
                }}
              >
                Replace draft with latest card
              </button>
            )}
          </div>
        </form>
      )}
      {deleting && (
        <div role="alertdialog" aria-label="Delete card?" className="space-y-3 rounded border p-4">
          <p>Delete {deleting.title}? This cannot be undone.</p>
          <button
            type="button"
            data-focus-on-open
            className={button}
            disabled={busy}
            onClick={() => {
              const id = deleting.id;
              setDeleting(undefined);
              editButtons.current.get(id)?.focus();
            }}
          >
            Keep card
          </button>{" "}
          <button
            type="button"
            className={button}
            disabled={busy || draft?.id === deleting.id}
            onClick={async () => {
              if (
                await save(
                  { action: "delete", id: deleting.id, revision: deleting.revision },
                  "Card deleted.",
                )
              ) {
                if (draft?.id === deleting.id) setEditing(undefined);
                setDeleting(undefined);
                addButton.current?.focus();
              }
            }}
          >
            Confirm delete
          </button>
        </div>
      )}
      {!data?.deals.length && !filter && <p>No cards yet. Add a deal or task to get started.</p>}
      {view === "list" ? (
        <DealList
          data={data}
          filter={filter}
          setFilter={setFilter}
          byRenewal={byRenewal}
          setByRenewal={setByRenewal}
          edit={(deal) => {
            setEditing({ ...deal });
            setMessage("");
            setConflict(false);
          }}
          busy={busy}
        />
      ) : (
        <div className="grid gap-4 overflow-x-auto md:grid-flow-col md:auto-cols-[minmax(14rem,1fr)]">
          {stages.map((stage) => {
            const cards = data?.deals.filter((d) => d.stageId === stage.id) ?? [];
            return (
              <section
                key={stage.id}
                aria-label={stage.name}
                className="min-h-48 space-y-3 rounded border bg-muted/30 p-4"
                onDragOver={(e) => {
                  if (!busy) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const card = data?.deals.find(
                    (d) => d.id === e.dataTransfer.getData("text/plain"),
                  );
                  if (card) void move(card, stage);
                  setGrabbed(undefined);
                }}
              >
                <h2 className="font-serif text-xl">{stage.name}</h2>
                <p>
                  {stage.count} {stage.count === 1 ? "card" : "cards"} · {money(stage.value)}
                </p>
                {cards.map((deal) => (
                  <article
                    aria-label={deal.title}
                    key={deal.id}
                    draggable={!busy && draft?.id !== deal.id}
                    onDragStart={(e) => {
                      if (busy || draft?.id === deal.id) {
                        e.preventDefault();
                        return;
                      }
                      e.dataTransfer.setData("text/plain", deal.id);
                      setGrabbed(deal.id);
                    }}
                    onDragEnd={() => setGrabbed(undefined)}
                    className={`space-y-2 rounded border bg-background p-3 ${grabbed === deal.id ? "opacity-50" : ""}`}
                  >
                    <h3 className="font-medium">{deal.title}</h3>
                    <p>
                      {deal.kind === "deal" ? "Deal" : "Task"} · {money(deal.value)}
                    </p>
                    <p>Owner: {deal.owner}</p>
                    {deal.renewalOn && <p>Renews {day(deal.renewalOn)}</p>}
                    {deal.company && <p>Company: {deal.company}</p>}
                    {deal.contact && <p>Person: {deal.contact}</p>}
                    <button
                      type="submit"
                      ref={(node) => {
                        if (node) moveButtons.current.set(deal.id, node);
                        else moveButtons.current.delete(deal.id);
                      }}
                      className={button}
                      aria-label={`Move ${deal.title}`}
                      aria-describedby="pipeline-help"
                      aria-disabled={busy || draft?.id === deal.id}
                      onKeyDown={(e) => {
                        const direction =
                          e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                        if (!direction) return;
                        e.preventDefault();
                        if (busy || draft?.id === deal.id) return;
                        const next =
                          stages[stages.findIndex((s) => s.id === deal.stageId) + direction];
                        if (next) void move(deal, next);
                        else
                          setMessage(
                            direction < 0
                              ? "Already in the first stage."
                              : "Already in the last stage.",
                          );
                      }}
                      onClick={() => {
                        if (!busy && draft?.id !== deal.id)
                          setMessage("Use the left and right arrow keys, or choose a stage below.");
                      }}
                    >
                      Move
                    </button>{" "}
                    <button
                      type="submit"
                      ref={(node) => {
                        if (node) editButtons.current.set(deal.id, node);
                        else editButtons.current.delete(deal.id);
                      }}
                      className={button}
                      disabled={busy}
                      onClick={() => {
                        if (deleting?.id === deal.id) setDeleting(undefined);
                        setEditing({ ...deal });
                        setMessage("");
                        setConflict(false);
                      }}
                    >
                      Edit {deal.title}
                    </button>{" "}
                    <button
                      type="button"
                      className={button}
                      disabled={busy || draft?.id === deal.id}
                      onClick={() => setDeleting({ ...deal })}
                    >
                      Delete {deal.title}
                    </button>
                    <label className="block">
                      Stage for {deal.title}
                      <select
                        className={field}
                        disabled={busy || draft?.id === deal.id}
                        aria-label={`Stage for ${deal.title}`}
                        value={deal.stageId}
                        onChange={(e) => {
                          const stage = stages.find((s) => s.id === e.target.value);
                          if (stage) void move(deal, stage);
                        }}
                      >
                        {stages.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

type Save = (body: Record<string, unknown>, success?: string) => Promise<boolean>;

/** Owners and editors add, rename, reorder and remove the workspace's stages. */
function StageSettings({ stages, busy, save }: { stages: Stage[]; busy: boolean; save: Save }) {
  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">Stage settings</summary>
      <p className="text-sm text-muted-foreground">
        Stages are shared by everyone in this workspace. A stage with cards cannot be removed; move
        its cards first.
      </p>
      <ol className="space-y-2">
        {stages.map((stage, i) => (
          <li key={`${stage.id}-${stage.name}`}>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const name = new FormData(e.currentTarget).get("name");
                void save(
                  { action: "stage-rename", stageId: stage.id, name },
                  `Stage renamed to ${name}.`,
                );
              }}
            >
              <label>
                Name for {stage.name}
                <input
                  name="name"
                  className={field}
                  required
                  maxLength={60}
                  defaultValue={stage.name}
                />
              </label>
              <button type="submit" className={button} disabled={busy}>
                Rename {stage.name}
              </button>
              <button
                type="button"
                className={button}
                disabled={busy || i === 0}
                onClick={() =>
                  void save(
                    { action: "stage-move", stageId: stage.id, direction: -1 },
                    `${stage.name} moved earlier.`,
                  )
                }
              >
                Move {stage.name} earlier
              </button>
              <button
                type="button"
                className={button}
                disabled={busy || i === stages.length - 1}
                onClick={() =>
                  void save(
                    { action: "stage-move", stageId: stage.id, direction: 1 },
                    `${stage.name} moved later.`,
                  )
                }
              >
                Move {stage.name} later
              </button>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void save({ action: "stage-remove", stageId: stage.id }, `${stage.name} removed.`)
                }
              >
                Remove {stage.name}
              </button>
            </form>
          </li>
        ))}
      </ol>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const name = new FormData(form).get("name");
          if (await save({ action: "stage-add", name }, `Stage ${name} added.`)) form.reset();
        }}
      >
        <label>
          New stage name
          <input name="name" className={field} required maxLength={60} />
        </label>
        <button type="submit" className={button} disabled={busy}>
          Add stage
        </button>
      </form>
    </details>
  );
}

/** The cards as a table, optionally showing one stage. */
function DealList({
  data,
  filter,
  setFilter,
  byRenewal,
  setByRenewal,
  edit,
  busy,
}: {
  data?: PipelineData;
  filter: string;
  setFilter: (stage: string) => void;
  byRenewal: boolean;
  setByRenewal: (on: boolean) => void;
  edit: (deal: Deal) => void;
  busy: boolean;
}) {
  const names = new Map(data?.stages.map((s) => [s.id, s.name]));
  return (
    <div className="space-y-3">
      <label className="block">
        Show stage
        <select
          aria-label="Show stage"
          className={field}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">All stages</option>
          {data?.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted-foreground">
        {byRenewal
          ? "Sorted by renewal date, soonest first; cards without one come last."
          : "Choose Renewal date to sort by it."}
      </p>
      {filter && !data?.deals.length && <p>No cards in this stage.</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Stage</th>
              <th>Value</th>
              <th>Owner</th>
              <th>Company</th>
              <th aria-sort={byRenewal ? "ascending" : "none"}>
                <button
                  type="button"
                  className="underline"
                  onClick={() => setByRenewal(!byRenewal)}
                >
                  Renewal date
                </button>
              </th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.deals.map((deal) => (
              <tr key={deal.id} className="border-t">
                <td>{deal.title}</td>
                <td>{deal.kind === "deal" ? "Deal" : "Task"}</td>
                <td>{names.get(deal.stageId)}</td>
                <td>{money(deal.value)}</td>
                <td>{deal.owner}</td>
                <td>{deal.company}</td>
                <td>{deal.renewalOn ? day(deal.renewalOn) : "None"}</td>
                <td>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => edit(deal)}
                  >
                    Edit {deal.title}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
