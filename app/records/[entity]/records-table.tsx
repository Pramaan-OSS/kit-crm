"use client";
import { useState } from "react";
import { NOTE_FIELDS } from "../../../lib/admin-table/entities";
import type { Row } from "../../../lib/admin-table/records";
import { api, useResource } from "../../../lib/pramaan/client";
export function RecordsTable() {
  const [search, setSearch] = useState("");
  const { data, error, reload } = useResource<{ records: Row[] }>(
    `/api/records/note?search=${encodeURIComponent(search)}`,
  );
  const [editing, setEditing] = useState<Row | "new">();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(body: object) {
    setBusy(true);
    try {
      await api("/api/records/note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      reload();
      setEditing(undefined);
      setMessage("Record saved.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <label>
        Search notes
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      {error && <p role="alert">{error.message}</p>}
      <button type="button" onClick={() => setEditing("new")}>
        Add record
      </button>{" "}
      <a href="/api/records/note/export">Export notes</a>
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void save({
              action: "save",
              ...(editing === "new" ? {} : { id: editing.id, revision: editing.revision }),
              title: f.get("title"),
              notes: f.get("notes"),
            });
          }}
        >
          {NOTE_FIELDS.map((field) => (
            <label key={field.column}>
              {field.label}
              <input
                name={field.column}
                required
                maxLength={field.max}
                defaultValue={editing === "new" ? "" : editing[field.column as "title" | "notes"]}
              />
            </label>
          ))}
          <button type="submit" disabled={busy}>
            Save record
          </button>
          <button type="button" onClick={() => setEditing(undefined)}>
            Cancel
          </button>
        </form>
      )}
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Notes</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {data?.records.map((r) => (
              <tr key={r.id}>
                <td>{r.title}</td>
                <td>{r.notes}</td>
                <td>
                  <button type="button" onClick={() => setEditing(r)}>
                    Edit {r.title}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && !data.records.length && <p>No matching notes. Add a record to get started.</p>}
      <p role="status">{message}</p>
    </>
  );
}
