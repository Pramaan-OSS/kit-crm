import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvCell, listRecords, saveRecord } from "./admin-table/records";
import { getContacts, updateContacts } from "./pramaan/contacts";
import { checkRevision, createStore, documentJson, requestUser, text } from "./pramaan/crm-data";
import { getPipeline, updatePipeline } from "./pramaan/pipeline";
import { membership, workspaceAction } from "./workspace";

if (!process.env.DATABASE_URL)
  throw new Error("Postgres tests require DATABASE_URL; the gate must supply its test database.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const store = createStore(pool);
const users = Array.from({ length: 6 }, () => randomUUID());
const own = users[0]!;
const editor = users[1]!;
const viewer = users[2]!;
const other = users[3]!;
const stranger = users[4]!;
const joiner = users[5]!;
let joinerOrg = "";
const email = (id: string) => `${id}@example.test`;
let org: string;
let org2: string;
const as = <T>(id: string, f: () => Promise<T>) => requestUser.run(id, f);
beforeAll(async () => {
  for (const id of users)
    await pool.query(
      "INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,'not-a-password','member')",
      [id, email(id)],
    );
  await workspaceAction(pool, own, { action: "create", name: "First team" });
  await workspaceAction(pool, other, { action: "create", name: "Other team" });
  org = (await membership(pool, own))!.org_id;
  org2 = (await membership(pool, other))!.org_id;
  await workspaceAction(pool, own, { action: "grant", email: email(editor), role: "editor" });
  await workspaceAction(pool, own, { action: "grant", email: email(viewer), role: "viewer" });
});
afterAll(async () => {
  for (const id of [org, org2, joinerOrg].filter(Boolean)) {
    for (const table of ["crm_contacts", "crm_pipeline", "crm_records"])
      await pool.query(`DELETE FROM ${table} WHERE scope=$1`, [id]);
    await pool.query("DELETE FROM crm_members WHERE org_id=$1", [id]);
    await pool.query("DELETE FROM crm_organisations WHERE id=$1", [id]);
  }
  await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [users]);
  await pool.end();
});
describe("releasing a member who never confirmed their address", () => {
  // The starter's own statement, from the owner action in lib/accounts.ts once it is re-synced here.
  const release = (id: string) =>
    pool.query(
      "DELETE FROM app_users WHERE email=$1 AND role='member' AND email_verified_at IS NULL AND id<>$2",
      [email(id), own],
    );
  // Everything a workspace keeps: its rows (0106) and its notes document.
  const documents = async (scope: string) => {
    let found = 0;
    for (const table of ["crm_contact_rows", "crm_deals", "crm_stages"])
      found += (await pool.query(`SELECT 1 FROM ${table} WHERE org_id=$1`, [scope])).rowCount ?? 0;
    for (const table of ["crm_contacts", "crm_pipeline", "crm_records"])
      found += (await pool.query(`SELECT 1 FROM ${table} WHERE scope=$1`, [scope])).rowCount ?? 0;
    return found;
  };
  const fill = async (user: string, scope: string) => {
    await as(user, () =>
      updateContacts(scope, { action: "save", kind: "company", name: "Kept company" }),
    );
    const stageId = (await as(user, () => getPipeline(scope))).stages[0]!.id;
    await as(user, () =>
      updatePipeline(scope, {
        action: "save",
        kind: "deal",
        title: "Kept deal",
        value: 1,
        owner: "Sam",
        stageId,
      }),
    );
    await as(user, () => store.changeData("records", scope, {}, () => {}));
  };
  const account = (id: string) =>
    pool.query(
      "INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,'not-a-password','member')",
      [id, email(id)],
    );
  it("takes the workspace they made, its access and its documents", async () => {
    const released = randomUUID();
    const teammate = randomUUID();
    await account(released);
    await account(teammate);
    try {
      await workspaceAction(pool, released, { action: "create", name: "Squatted" });
      const scope = (await membership(pool, released))!.org_id;
      await workspaceAction(pool, released, {
        action: "grant",
        email: email(teammate),
        role: "editor",
      });
      await fill(teammate, scope);
      // Three stages, a company, a deal and the notes document.
      expect(await documents(scope)).toBe(6);
      expect((await release(released)).rowCount).toBe(1);
      expect(await documents(scope)).toBe(0);
      expect(
        (await pool.query("SELECT 1 FROM crm_organisations WHERE id=$1", [scope])).rowCount,
      ).toBe(0);
      expect(
        (await pool.query("SELECT 1 FROM crm_members WHERE org_id=$1", [scope])).rowCount,
      ).toBe(0);
      // The teammate keeps their account and is free to start again.
      expect((await pool.query("SELECT 1 FROM app_users WHERE id=$1", [teammate])).rowCount).toBe(
        1,
      );
      await workspaceAction(pool, teammate, { action: "create", name: "Fresh start" });
      await pool.query("DELETE FROM crm_organisations WHERE owner_id=$1", [teammate]);
    } finally {
      await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [[released, teammate]]);
    }
  });
  it("takes only their own access to someone else's workspace, and hands their rows to its owner", async () => {
    const released = randomUUID();
    await account(released);
    await workspaceAction(pool, own, { action: "grant", email: email(released), role: "editor" });
    await as(released, () =>
      updateContacts(org, { action: "save", kind: "person", name: "Added by a leaver" }),
    );
    const before = await documents(org);
    expect((await release(released)).rowCount).toBe(1);
    expect((await membership(pool, released))?.org_id).toBeUndefined();
    expect((await membership(pool, own))?.org_id).toBe(org);
    expect(await documents(org)).toBe(before);
    const kept = await pool.query(
      "SELECT owner_id FROM crm_contact_rows WHERE org_id=$1 AND name='Added by a leaver'",
      [org],
    );
    expect(kept.rows).toEqual([{ owner_id: own }]);
    await pool.query("DELETE FROM crm_contact_rows WHERE org_id=$1 AND name='Added by a leaver'", [
      org,
    ]);
  });
  it("lets a write in progress finish first, and leaves nothing of it behind", async () => {
    const released = randomUUID();
    await account(released);
    await workspaceAction(pool, released, { action: "create", name: "Busy" });
    const scope = (await membership(pool, released))!.org_id;
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM crm_organisations WHERE id=$1 FOR UPDATE", [scope]);
      await tx.query(
        "INSERT INTO crm_contact_rows(id,org_id,owner_id,kind,name) VALUES($1,$2,$3,'person','Mid-write')",
        [randomUUID(), scope, released],
      );
      const removed = release(released);
      await tx.query("COMMIT");
      expect((await removed).rowCount).toBe(1);
      expect(await documents(scope)).toBe(0);
      await expect(
        as(released, () =>
          updateContacts(scope, { action: "save", kind: "person", name: "Too late" }),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(await documents(scope)).toBe(0);
    } finally {
      tx.release();
    }
  });
});
describe("validation", () => {
  it("rejects stale and missing revisions", () => {
    expect(() => checkRevision({ revision: 2 }, 1, "contact")).toThrow(/changed/);
    expect(() => checkRevision({ revision: 0 }, undefined, "card")).toThrow();
  });
  it("bounds stored bytes, including multibyte text", () => {
    expect(() => documentJson({ value: "漢".repeat(1500000) })).toThrow(/full/);
  });
  it("validates names and safe exports", () => {
    expect(() => text(" ", "a name")).toThrow();
    expect(() => text("toolong", "a name", 2)).toThrow();
    expect(csvCell(" =SUM(A1)")).toBe('"\' =SUM(A1)"');
    expect(csvCell('a"b')).toBe('"a""b"');
  });
});
describe("real organisation permissions", () => {
  it("shares contacts with editors and viewers while isolating another organisation", async () => {
    await as(editor, () =>
      updateContacts(org, { action: "save", kind: "company", name: "Shared company", email: "" }),
    );
    expect((await as(viewer, () => getContacts(org))).contacts).toHaveLength(1);
    expect((await as(other, () => getContacts(org2))).contacts).toHaveLength(0);
    await expect(as(other, () => getContacts(org))).rejects.toMatchObject({ status: 403 });
    await expect(as(stranger, () => getContacts(org))).rejects.toMatchObject({ status: 403 });
    await expect(
      as(viewer, () => updateContacts(org, { action: "save", kind: "person", name: "Denied" })),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("supports company links, notes, history, stale edits and deletion", async () => {
    const company = (await as(own, () => getContacts(org))).contacts[0]!;
    await as(own, () =>
      updateContacts(org, { action: "save", kind: "person", name: "Sam", companyId: company.id }),
    );
    const person = (await as(editor, () => getContacts(org))).contacts.find(
      (c) => c.name === "Sam",
    )!;
    await as(editor, () =>
      updateContacts(org, { action: "note", id: person.id, revision: 0, note: "Call next week" }),
    );
    await expect(
      as(editor, () =>
        updateContacts(org, { action: "note", id: person.id, revision: 0, note: "Stale" }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await as(own, () =>
      updateContacts(org, { action: "delete", id: company.id, revision: company.revision }),
    );
    const updated = (await as(viewer, () => getContacts(org))).contacts[0]!;
    expect(updated.companyId).toBe("");
    expect(updated.notes[0]?.text).toBe("Call next week");
    expect(updated.history[0]?.text).toBe("Company link removed");
  });
  it("checks team management and cannot cross organisation boundaries", async () => {
    await expect(
      workspaceAction(pool, editor, { action: "grant", email: email(stranger), role: "editor" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      workspaceAction(pool, own, { action: "grant", email: email(other), role: "editor" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      workspaceAction(pool, own, { action: "grant", email: email(editor), role: "manager" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(workspaceAction(pool, own, { action: "remove", id: own })).rejects.toMatchObject({
      status: 400,
    });
  });
  it("stops at 50 people in a workspace", async () => {
    const count = async () =>
      Number(
        (await pool.query("SELECT count(*) FROM crm_members WHERE org_id=$1", [org])).rows[0].count,
      );
    const extra = await pool.query(
      `INSERT INTO app_users(id,email,password_hash,role) SELECT gen_random_uuid(), gen_random_uuid()||'@example.test','not-a-password','member' FROM generate_series(1,$1::int) RETURNING id`,
      [50 - (await count())],
    );
    const ids = extra.rows.map((r) => r.id);
    try {
      await pool.query(
        "INSERT INTO crm_members(org_id,user_id,role) SELECT $1, unnest($2::uuid[]), 'viewer'",
        [org, ids],
      );
      expect(await count()).toBe(50);
      await expect(
        workspaceAction(pool, own, { action: "grant", email: email(stranger), role: "viewer" }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/50 people/) });
    } finally {
      await pool.query("DELETE FROM crm_members WHERE user_id=ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [ids]);
    }
  });
  it("refuses a record edit made from an old copy", async () => {
    await as(editor, () => saveRecord(org, { action: "save", title: "Revised", notes: "one" }));
    const record = (await as(editor, () => listRecords(org))).records.find(
      (r) => r.title === "Revised",
    )!;
    const edit = (notes: string) =>
      as(editor, () =>
        saveRecord(org, {
          action: "save",
          id: record.id,
          revision: record.revision,
          title: "Revised",
          notes,
        }),
      );
    await edit("two");
    await expect(edit("stale")).rejects.toMatchObject({ status: 409 });
  });
  it("rejects writes after access has been removed", async () => {
    await workspaceAction(pool, own, { action: "remove", id: editor });
    await expect(
      as(editor, () => saveRecord(org, { action: "save", title: "Denied", notes: "Denied" })),
    ).rejects.toMatchObject({ status: 403 });
    await workspaceAction(pool, own, { action: "grant", email: email(editor), role: "editor" });
  });
  it("runs the pipeline and rejects stale moves", async () => {
    const [fresh, doing, won] = (await as(viewer, () => getPipeline(org))).stages;
    await as(editor, () =>
      updatePipeline(org, {
        action: "save",
        kind: "task",
        title: "Sprint task",
        value: 0,
        owner: "Sam",
        stageId: fresh!.id,
      }),
    );
    const card = (await as(viewer, () => getPipeline(org))).deals[0]!;
    expect(card.stageId).toBe(fresh!.id);
    await as(editor, () =>
      updatePipeline(org, { action: "move", id: card.id, revision: 0, stageId: doing!.id }),
    );
    await expect(
      as(editor, () =>
        updatePipeline(org, { action: "move", id: card.id, revision: 0, stageId: won!.id }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as(viewer, () =>
        updatePipeline(org, { action: "move", id: card.id, revision: 1, stageId: won!.id }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
describe("Postgres races", () => {
  it("waits for the organisation lock and checks revoked access after the wait", async () => {
    const tx = await pool.connect();
    await tx.query("BEGIN");
    await tx.query("SELECT id FROM crm_organisations WHERE id=$1 FOR UPDATE", [org]);
    let settled = false;
    const write = as(editor, () =>
      store.changeData("records", org, { records: [] as unknown[] }, (s) => {
        s.records.push({ title: "must not save" });
      }),
    )
      .then(
        () => ({ ok: true, status: 0 }),
        (e) => ({ ok: false, status: e.status }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await new Promise((r) => setTimeout(r, 150));
      expect(settled, "write must wait on the held organisation lock").toBe(false);
      await tx.query("UPDATE crm_members SET role='viewer' WHERE org_id=$1 AND user_id=$2", [
        org,
        editor,
      ]);
      await tx.query("COMMIT");
      expect(await write).toEqual({ ok: false, status: 403 });
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
      await write;
    }
    await workspaceAction(pool, own, { action: "grant", email: email(editor), role: "editor" });
  });
  it("makes a grant wait while that account creates its own workspace", async () => {
    const tx = await pool.connect();
    await tx.query("BEGIN");
    // What "create" holds while it checks the account has no workspace yet.
    await tx.query("SELECT id FROM app_users WHERE id=$1 FOR UPDATE", [joiner]);
    let settled = false;
    const grant = workspaceAction(pool, own, {
      action: "grant",
      email: email(joiner),
      role: "editor",
    })
      .then(
        () => ({ status: 0 }),
        (e) => ({ status: e.status }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await new Promise((r) => setTimeout(r, 150));
      expect(settled, "grant must wait on the account lock").toBe(false);
      joinerOrg = randomUUID();
      await tx.query("INSERT INTO crm_organisations(id,name,owner_id) VALUES($1,'Own team',$2)", [
        joinerOrg,
        joiner,
      ]);
      await tx.query("INSERT INTO crm_members(org_id,user_id,role) VALUES($1,$2,'manager')", [
        joinerOrg,
        joiner,
      ]);
      await tx.query("COMMIT");
      expect(await grant).toEqual({ status: 409 });
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
      await grant;
    }
  });
  it("does not lose competing additions", async () => {
    await as(own, () =>
      store.changeData("records", org, { records: [] }, (s) => {
        s.records = [];
      }),
    );
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        as(editor, () =>
          saveRecord(org, { action: "save", title: `Concurrent ${i}`, notes: "kept" }),
        ),
      ),
    );
    const result = await as(viewer, () => store.readData("records", org, { records: [] }));
    expect(result.records).toHaveLength(12);
  });
  it("only accepts one of two edits from the same revision", async () => {
    const { deals, stages } = await as(editor, () => getPipeline(org));
    const card = deals[0]!;
    const results = await Promise.allSettled(
      [stages[0]!.id, stages[2]!.id].map((stageId) =>
        as(editor, () =>
          updatePipeline(org, { action: "move", id: card.id, revision: card.revision, stageId }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("storage limits under concurrent writes", () => {
  it("allows only the last contact that fits, including concurrent additions", async () => {
    const existing = (await as(own, () => getContacts(org))).contacts.length;
    await pool.query(
      `INSERT INTO crm_contact_rows(id,org_id,owner_id,kind,name)
       SELECT gen_random_uuid(),$1,$2,'person','Filler '||i FROM generate_series(1,$3::int) i`,
      [org, own, 1999 - existing],
    );
    const results = await Promise.allSettled(
      ["Last one", "One too many"].map((name) =>
        as(editor, () => updateContacts(org, { action: "save", kind: "person", name })),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await as(viewer, () => getContacts(org))).contacts).toHaveLength(2000);
    await pool.query(
      "DELETE FROM crm_contact_rows WHERE org_id=$1 AND (name LIKE 'Filler %' OR name IN ('Last one','One too many'))",
      [org],
    );
  });
  it("stops at 500 cards, including concurrent additions", async () => {
    const { deals, stages } = await as(own, () => getPipeline(org));
    await pool.query(
      `INSERT INTO crm_deals(id,org_id,owner_id,stage_id,kind,title,value,owner)
       SELECT gen_random_uuid(),$1,$2,$3,'task','Filler '||i,0,'Sam' FROM generate_series(1,$4::int) i`,
      [org, own, stages[0]!.id, 499 - deals.length],
    );
    const results = await Promise.allSettled(
      ["Last card", "One card too many"].map((title) =>
        as(editor, () =>
          updatePipeline(org, {
            action: "save",
            kind: "task",
            title,
            value: 0,
            owner: "Sam",
            stageId: stages[0]!.id,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await as(viewer, () => getPipeline(org))).deals).toHaveLength(500);
    await pool.query(
      "DELETE FROM crm_deals WHERE org_id=$1 AND (title LIKE 'Filler %' OR title LIKE 'Last card')",
      [org],
    );
  });
  it("refuses a note once the workspace's notes reach their byte limit", async () => {
    const person = (await as(own, () => getContacts(org))).contacts[0]!;
    // Rows of 3.5 MiB of notes each, made inside Postgres, push the workspace past 16 MiB.
    await pool.query(
      `INSERT INTO crm_contact_rows(id,org_id,owner_id,kind,name,notes)
       SELECT gen_random_uuid(),$1,$2,'person','Heavy '||i,
         jsonb_build_array(jsonb_build_object('text',repeat('x',3670016),'at','')) FROM generate_series(1,5) i`,
      [org, own],
    );
    try {
      await expect(
        as(own, () =>
          updateContacts(org, {
            action: "note",
            id: person.id,
            revision: person.revision,
            note: "One more",
          }),
        ),
      ).rejects.toThrow(/full/);
    } finally {
      await pool.query("DELETE FROM crm_contact_rows WHERE org_id=$1 AND name LIKE 'Heavy %'", [
        org,
      ]);
    }
  });
  it("does not replace a document when it exceeds the byte limit", async () => {
    const before = await as(own, () => store.readData("records", org, { records: [] }));
    await expect(
      as(own, () =>
        store.changeData("records", org, { records: [] }, (s) => {
          Object.assign(s, { oversized: "x".repeat(4194304) });
        }),
      ),
    ).rejects.toThrow(/full/);
    expect(await as(own, () => store.readData("records", org, { records: [] }))).toEqual(before);
  });
  it("stops at 500 internal records", async () => {
    const fill = (records: unknown[]) =>
      as(own, () =>
        store.changeData("records", org, { records: [] as unknown[] }, (s) => {
          s.records = records;
        }),
      );
    await fill(
      Array.from({ length: 500 }, (_, i) => ({
        id: randomUUID(),
        title: `R${i}`,
        notes: "n",
        revision: 0,
      })),
    );
    await expect(
      as(editor, () => saveRecord(org, { action: "save", title: "One more", notes: "n" })),
    ).rejects.toThrow(/500 records/);
    await fill([]);
  });
  it("says the workspace is full when only the database's size check refuses it", async () => {
    // A private pool keeps the small test constraint out of every other connection.
    const small = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await small.query(`CREATE TEMP TABLE crm_records (
        scope text PRIMARY KEY, data jsonb NOT NULL CHECK (octet_length(data::text) <= 4096)
      )`);
      const limited = createStore(small);
      const before = { records: [] };
      const pad = Array.from({ length: 1500 }, () => 0);
      expect(Buffer.byteLength(JSON.stringify(pad))).toBeLessThan(4096);
      await expect(
        as(own, () =>
          limited.changeData("records", org, before, (state) => {
            Object.assign(state, { pad });
          }),
        ),
      ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/full/) });
      expect(await as(own, () => limited.readData("records", org, before))).toEqual(before);
      expect((await small.query("SELECT count(*) FROM crm_records")).rows[0].count).toBe("0");
    } finally {
      await small.end();
    }
  });
  it("rejects oversized documents at the database boundary too", async () => {
    // Generate the large string inside Postgres, avoiding a large wire payload and JSON parse.
    await expect(
      pool.query(
        "UPDATE crm_records SET data=jsonb_build_object('value', repeat('x',4194304)) WHERE scope=$1",
        [org],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
