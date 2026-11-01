"use client";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api, useResource } from "../../../lib/pramaan/client";
import type { Contact, ContactsData } from "../../../lib/pramaan/contacts";

const field = "block w-full rounded border bg-background p-2";
const button = "rounded border px-3 py-2 hover:bg-muted disabled:opacity-50";

export function ContactsPanel() {
  const { data, error, loading, reload } = useResource<ContactsData>("/api/pramaan/contacts");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<Contact | "person" | "company">();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [deleting, setDeleting] = useState<Contact>();
  const addPerson = useRef<HTMLButtonElement>(null);
  const addCompany = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<"person" | "company" | "edit" | undefined>(undefined);
  const contact = data?.contacts.find((c) => c.id === selected);
  const draft = typeof editing === "object" ? editing : undefined;
  const kind = draft?.kind ?? (editing === "company" ? "company" : "person");
  useEffect(() => {
    if (!editing && returnFocus.current) {
      const target = returnFocus.current;
      (target === "edit"
        ? editButton.current
        : target === "person"
          ? addPerson.current
          : addCompany.current
      )?.focus();
      returnFocus.current = undefined;
    }
  }, [editing]);

  async function save(body: Record<string, unknown>, success = "Saved.") {
    if (busy || (draft?.id === body.id && body.action !== "save")) return false;
    setBusy(true);
    setMessage("");
    setConflict(false);
    try {
      await api("/api/pramaan/contacts", {
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
    returnFocus.current = draft ? "edit" : kind;
    setEditing(undefined);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (
      await save({
        action: "save",
        id: draft?.id,
        revision: draft?.revision,
        kind,
        name: form.get("name"),
        email: form.get("email"),
        companyId: form.get("companyId") ?? "",
      })
    )
      closeEditor();
  }
  if (loading && !data) return <p role="status">Loading contacts…</p>;
  if (error)
    return (
      <div role="alert">
        <p>{error.message}</p>
        <button type="button" className={button} onClick={reload}>
          Try again
        </button>
      </div>
    );
  const companies = new Map(
    data?.contacts.filter((c) => c.kind === "company").map((c) => [c.id, c.name]),
  );
  const matches =
    data?.contacts.filter((c) =>
      `${c.name} ${c.email} ${companies.get(c.companyId) ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  return (
    <div className="space-y-6">
      <label className="block">
        Search people and companies
        <input className={field} value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          ref={addPerson}
          className={button}
          disabled={busy}
          onClick={() => {
            setSelected(undefined);
            setEditing("person");
            setMessage("");
            setConflict(false);
          }}
        >
          Add person
        </button>
        <button
          type="button"
          ref={addCompany}
          className={button}
          disabled={busy}
          onClick={() => {
            setSelected(undefined);
            setEditing("company");
            setMessage("");
            setConflict(false);
          }}
        >
          Add company
        </button>
      </div>
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
            setMessage("Latest contacts requested. Your draft is still open.");
          }}
        >
          Refresh contacts
        </button>
      )}
      {deleting && (
        <div
          role="alertdialog"
          aria-label="Delete contact?"
          className="space-y-3 rounded border p-4"
        >
          <p>
            Delete {deleting.name}? Notes will be removed. People linked to this company will keep
            their details without a company link. This cannot be undone.
          </p>
          <button
            type="button"
            data-focus-on-open
            className={button}
            disabled={busy}
            onClick={() => {
              setDeleting(undefined);
              editButton.current?.focus();
            }}
          >
            Keep contact
          </button>{" "}
          <button
            type="button"
            className={button}
            disabled={busy || draft?.id === deleting.id}
            onClick={async () => {
              if (
                await save(
                  { action: "delete", id: deleting.id, revision: deleting.revision },
                  "Contact deleted.",
                )
              ) {
                setDeleting(undefined);
                setSelected(undefined);
                setEditing(undefined);
                addPerson.current?.focus();
              }
            }}
          >
            Confirm delete
          </button>
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-label="Contacts" className="rounded border p-4">
          <h2 className="font-serif text-xl">People and companies</h2>
          <ul className="divide-y">
            {matches.map((c) => (
              <li key={c.id} className="py-3">
                <button
                  type="button"
                  disabled={busy}
                  className="text-left underline"
                  onClick={() => {
                    setSelected(c.id);
                    setEditing(undefined);
                    setMessage("");
                    setConflict(false);
                  }}
                >
                  {c.name}
                </button>
                <p className="text-sm text-muted-foreground">
                  {c.kind === "person" ? "Person" : "Company"}
                  {c.companyId && ` · ${companies.get(c.companyId) ?? ""}`}
                </p>
              </li>
            ))}
          </ul>
          {!data?.contacts.length && <p>No contacts yet. Add your first person or company.</p>}
          {!!data?.contacts.length && !matches.length && <p>No matching contacts.</p>}
        </section>
        <section aria-label="Contact details" className="space-y-4 rounded border p-4">
          {editing && (
            <form
              aria-label="Contact"
              key={draft ? `${draft.id}-${draft.revision}` : kind}
              onSubmit={submit}
              className="space-y-3"
            >
              <h2 className="font-serif text-xl">
                {draft ? "Edit contact" : kind === "person" ? "New person" : "New company"}
              </h2>
              <label className="block">
                Name
                <input
                  data-focus-on-open
                  name="name"
                  className={field}
                  required
                  maxLength={200}
                  defaultValue={draft?.name}
                />
              </label>
              <label className="block">
                Email
                <input
                  name="email"
                  type="email"
                  className={field}
                  maxLength={254}
                  defaultValue={draft?.email}
                />
              </label>
              {kind === "person" && (
                <label className="block">
                  Company
                  <select
                    aria-label="Company"
                    name="companyId"
                    className={field}
                    defaultValue={draft?.companyId ?? ""}
                  >
                    <option value="">No company</option>
                    {[...companies].map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button type="submit" className={button} disabled={busy}>
                Save contact
              </button>{" "}
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
                      const latest = await api<ContactsData>("/api/pramaan/contacts");
                      const fresh = latest.contacts.find((c) => c.id === draft.id);
                      if (!fresh) {
                        setMessage("This contact is no longer available.");
                        return;
                      }
                      setEditing(fresh);
                      setConflict(false);
                      reload();
                      setMessage("Latest contact loaded. Please enter your changes again.");
                    } catch (e) {
                      setMessage(
                        e instanceof Error ? e.message : "Something went wrong. Please try again.",
                      );
                    }
                  }}
                >
                  Replace draft with latest contact
                </button>
              )}
            </form>
          )}
          {contact ? (
            <ContactDetail
              key={contact.id}
              contact={contact}
              company={companies.get(contact.companyId)}
              busy={busy}
              editing={draft?.id === contact.id}
              editButton={editButton}
              edit={() => {
                setDeleting(undefined);
                setEditing({ ...contact });
                setMessage("");
                setConflict(false);
              }}
              remove={() => setDeleting({ ...contact })}
              save={save}
            />
          ) : (
            !editing && <p>Choose a contact to see notes and history.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function ContactDetail({
  contact,
  company,
  busy,
  editing,
  editButton,
  edit,
  remove,
  save,
}: {
  contact: Contact;
  company?: string;
  busy: boolean;
  editing: boolean;
  editButton: React.RefObject<HTMLButtonElement | null>;
  edit: () => void;
  remove: () => void;
  save: (body: Record<string, unknown>, success?: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const [deletingNote, setDeletingNote] = useState<{ index: number; revision: number }>();
  useEffect(() => {
    if (editing) setDeletingNote(undefined);
  }, [editing]);
  return (
    <div className="space-y-4">
      {!editing && (
        <>
          <h2 className="font-serif text-xl">{contact.name}</h2>
          <p>{contact.email}</p>
          {company && <p>Company: {company}</p>}
          <button type="button" ref={editButton} className={button} disabled={busy} onClick={edit}>
            Edit contact
          </button>
        </>
      )}
      <button type="button" className={button} disabled={busy || editing} onClick={remove}>
        Delete contact
      </button>
      <h3 className="font-serif text-lg">Notes</h3>
      {editing && <p>Save or cancel this edit before adding or deleting notes.</p>}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || editing) return;
          if (await save({ action: "note", id: contact.id, revision: contact.revision, note }))
            setNote("");
        }}
        className="space-y-2"
      >
        <label className="block">
          New note
          <textarea
            disabled={busy || editing}
            className={field}
            required
            maxLength={4000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button type="submit" className={button} disabled={busy || editing}>
          Add note
        </button>
      </form>
      {deletingNote && (
        <div role="alertdialog" aria-label="Delete note?" className="space-y-2 rounded border p-3">
          <p>Delete this note? This cannot be undone.</p>
          <button
            type="button"
            data-focus-on-open
            className={button}
            disabled={busy || editing}
            onClick={() => setDeletingNote(undefined)}
          >
            Keep note
          </button>{" "}
          <button
            type="button"
            className={button}
            disabled={busy || editing}
            onClick={async () => {
              if (
                await save(
                  {
                    action: "delete-note",
                    id: contact.id,
                    revision: deletingNote.revision,
                    noteIndex: deletingNote.index,
                  },
                  "Note deleted.",
                )
              )
                setDeletingNote(undefined);
            }}
          >
            Confirm delete
          </button>
        </div>
      )}
      {!contact.notes.length && <p>No notes yet.</p>}
      <ul aria-label="Notes">
        {contact.notes.map((n, i) => (
          <li key={`${n.at}-${n.text}`} className="border-b py-2">
            <p className="whitespace-pre-wrap">{n.text}</p>
            <time className="text-sm text-muted-foreground" dateTime={n.at}>
              {new Date(n.at).toLocaleString()}
            </time>{" "}
            <button
              type="button"
              className={button}
              disabled={busy || editing}
              onClick={() => setDeletingNote({ index: i, revision: contact.revision })}
            >
              Delete note {i + 1}
            </button>
          </li>
        ))}
      </ul>
      <h3 className="font-serif text-lg">History</h3>
      <ol aria-label="History">
        {contact.history.map((h) => (
          <li key={`${h.at}-${h.text}`} className="border-l pl-3 pb-3">
            {h.text}{" "}
            <time className="block text-sm text-muted-foreground" dateTime={h.at}>
              {new Date(h.at).toLocaleString()}
            </time>
          </li>
        ))}
      </ol>
    </div>
  );
}
