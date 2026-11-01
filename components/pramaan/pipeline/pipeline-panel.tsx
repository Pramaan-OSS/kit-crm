"use client";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api, useResource } from "../../../lib/pramaan/client";
import type { Deal, PipelineData, Stage } from "../../../lib/pramaan/pipeline";

const stages: Stage[] = ["New", "In progress", "Won"];
const field = "block w-full rounded border bg-background p-2";
const button = "rounded border px-3 py-2 hover:bg-muted disabled:opacity-50";
const money = (value: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);

export function PipelinePanel() {
  const { data, error, loading, reload } = useResource<PipelineData>("/api/pramaan/pipeline");
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
  const focusAfterMove = useRef<{ id: string; stage: Stage } | undefined>(undefined);

  useEffect(() => {
    const target = focusAfterMove.current;
    if (
      !busy &&
      target &&
      data?.deals.some((d) => d.id === target.id && d.stage === target.stage)
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
    if (stage === deal.stage) {
      setMessage(`${deal.title} is already in ${stage}.`);
      return;
    }
    focusAfterMove.current = { id: deal.id, stage };
    const saved = await save(
      { action: "move", id: deal.id, revision: deal.revision, stage },
      `${deal.title} moved to ${stage}.`,
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
      ...(card ? {} : { stage: form.get("stage") }),
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
      </button>
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
          {!draft && (
            <label>
              Stage
              <select aria-label="Stage" name="stage" className={field} defaultValue="New">
                {stages.map((s) => (
                  <option key={s}>{s}</option>
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
      {!data?.deals.length && <p>No cards yet. Add a deal or task to get started.</p>}
      <div className="grid gap-4 md:grid-cols-3">
        {stages.map((stage) => {
          const cards = data?.deals.filter((d) => d.stage === stage) ?? [];
          return (
            <section
              key={stage}
              aria-label={stage}
              className="min-h-48 space-y-3 rounded border bg-muted/30 p-4"
              onDragOver={(e) => {
                if (!busy) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const card = data?.deals.find((d) => d.id === e.dataTransfer.getData("text/plain"));
                if (card) void move(card, stage);
                setGrabbed(undefined);
              }}
            >
              <h2 className="font-serif text-xl">{stage}</h2>
              <p>
                {cards.length} {cards.length === 1 ? "card" : "cards"} ·{" "}
                {money(cards.reduce((sum, d) => sum + Math.round(d.value * 100), 0) / 100)}
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
                      const direction = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                      if (!direction) return;
                      e.preventDefault();
                      if (busy || draft?.id === deal.id) return;
                      const next = stages[stages.indexOf(deal.stage) + direction];
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
                      value={deal.stage}
                      onChange={(e) => void move(deal, e.target.value as Stage)}
                    >
                      {stages.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
