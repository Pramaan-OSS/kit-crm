"use client";
import { useState } from "react";
import { api, useResource } from "../../lib/pramaan/client";

type Team = {
  workspace: null | { name: string; role: string };
  members: { id: string; email: string | null; role: string }[];
};
export default function Team() {
  const { data, error, reload } = useResource<Team>("/api/workspace");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(body: object) {
    setBusy(true);
    setMessage("");
    try {
      await api("/api/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      reload();
      setMessage("Team saved.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="workspace">
      <p className="eyebrow">Shared work, clear access</p>
      <h1>Your team</h1>
      {error ? (
        <p role="alert">
          {error.message} <a href="/">Sign in</a>
        </p>
      ) : !data ? (
        <p>Loading team…</p>
      ) : !data.workspace ? (
        <section>
          <h2>Create a workspace</h2>
          <p>If you are joining a team, ask its owner to add your sign-in email instead.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save({ action: "create", name: new FormData(e.currentTarget).get("name") });
            }}
          >
            <label>
              Workspace name
              <input name="name" required maxLength={120} />
            </label>
            <button type="submit" disabled={busy}>
              Create workspace
            </button>
          </form>
        </section>
      ) : (
        <>
          <section>
            <h2>{data.workspace.name}</h2>
            <p>
              Your access:{" "}
              {data.workspace.role === "manager"
                ? "Workspace owner"
                : data.workspace.role === "editor"
                  ? "Can edit"
                  : "Read only"}
              .
            </p>
            <p>Everyone here shares this workspace. Other workspaces cannot see its records.</p>
            {data.workspace.role === "viewer" && (
              <p>You can read records. Ask the workspace owner if you need to make changes.</p>
            )}
          </section>
          {data.workspace.role === "manager" && (
            <section>
              <h2>Add or change access</h2>
              <p>Ask your teammate to create an account first. Up to 50 people can join.</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void save({ action: "grant", email: f.get("email"), role: f.get("role") });
                }}
              >
                <label>
                  Teammate email
                  <input name="email" type="email" required maxLength={254} />
                </label>
                <label>
                  Access
                  <select aria-label="Access" name="role">
                    <option value="editor">Can edit</option>
                    <option value="viewer">Read only</option>
                  </select>
                </label>
                <button type="submit" disabled={busy}>
                  Save access
                </button>
              </form>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save({ action: "rename", name: new FormData(e.currentTarget).get("name") });
                }}
              >
                <label>
                  Workspace name
                  <input name="name" required maxLength={120} defaultValue={data.workspace.name} />
                </label>
                <button type="submit" disabled={busy}>
                  Rename workspace
                </button>
              </form>
            </section>
          )}
          <section>
            <h2>People in this workspace</h2>
            <ul>
              {data.members.map((m) => (
                <li key={m.id}>
                  {m.email ?? "App owner"} ·{" "}
                  {m.role === "manager"
                    ? "Workspace owner"
                    : m.role === "editor"
                      ? "Can edit"
                      : "Read only"}
                  {data.workspace?.role === "manager" && m.role !== "manager" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void save({ action: "remove", id: m.id })}
                    >
                      Remove {m.email}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      <p role="status">{message}</p>
    </main>
  );
}
