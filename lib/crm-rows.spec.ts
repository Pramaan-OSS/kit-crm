import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportContacts, getContacts, updateContacts } from "./pramaan/contacts";
import { requestUser } from "./pramaan/crm-data";
import { getPipeline, updatePipeline } from "./pramaan/pipeline";
import { membership, workspaceAction } from "./workspace";

if (!process.env.DATABASE_URL)
  throw new Error("Postgres tests require DATABASE_URL; the gate must supply its test database.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users = Array.from({ length: 5 }, () => randomUUID());
const [own, editor, other, migrated, viewer] = users as [string, string, string, string, string];
const email = (id: string) => `${id}@example.test`;
const as = <T>(id: string, f: () => Promise<T>) => requestUser.run(id, f);
let org = "";
let org2 = "";
beforeAll(async () => {
  for (const id of users)
    await pool.query(
      "INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,'not-a-password','member')",
      [id, email(id)],
    );
  await workspaceAction(pool, own, { action: "create", name: "Rows team" });
  await workspaceAction(pool, other, { action: "create", name: "Elsewhere" });
  org = (await membership(pool, own))!.org_id;
  org2 = (await membership(pool, other))!.org_id;
  await workspaceAction(pool, own, { action: "grant", email: email(editor), role: "editor" });
  await workspaceAction(pool, own, { action: "grant", email: email(viewer), role: "viewer" });
});
afterAll(async () => {
  await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [users]);
  await pool.end();
});

describe("moving workspace documents into rows", () => {
  // A workspace made before 0106 ran: its documents are moved by the migration's own function.
  async function workspace() {
    await pool.query("DELETE FROM crm_organisations WHERE owner_id=$1", [migrated]);
    await workspaceAction(pool, migrated, { action: "create", name: "Before rows" });
    return (await membership(pool, migrated))!.org_id;
  }
  const move = (scope: string) => pool.query("SELECT crm_move_documents($1)", [scope]);
  it("moves an empty workspace and keeps its three stages", async () => {
    const scope = await workspace();
    await move(scope);
    const fresh = await workspace();
    await pool.query("INSERT INTO crm_contacts(scope,data) VALUES($1,'{\"contacts\":[]}')", [
      fresh,
    ]);
    await pool.query("INSERT INTO crm_pipeline(scope,data) VALUES($1,'{}')", [fresh]);
    await move(fresh);
    const board = await as(migrated, () => getPipeline(fresh));
    expect(board.stages.map((s) => s.name)).toEqual(["New", "In progress", "Won"]);
    expect(board.deals).toEqual([]);
    expect((await as(migrated, () => getContacts(fresh))).contacts).toEqual([]);
    const left = await pool.query(
      "SELECT (SELECT count(*) FROM crm_contacts WHERE scope=$1)+(SELECT count(*) FROM crm_pipeline WHERE scope=$1) AS n",
      [fresh],
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });
  it("moves a workspace near the 4 MiB cap with every record, revision and stage intact", async () => {
    const scope = await workspace();
    // Built inside Postgres: 100 companies and 1,900 people linked to them, each with a long note, and 500 cards.
    await pool.query(
      `INSERT INTO crm_contacts(scope,data) SELECT $1, jsonb_build_object('contacts', jsonb_agg(jsonb_build_object(
         'id', md5($1||'c'||i)::uuid, 'revision', i % 7, 'kind', CASE WHEN i <= 100 THEN 'company' ELSE 'person' END,
         'name', 'Contact '||i, 'email', 'c'||i||'@example.test',
         'companyId', CASE WHEN i <= 100 THEN '' ELSE md5($1||'c'||(i % 100 + 1))::uuid::text END,
         'notes', jsonb_build_array(jsonb_build_object('text', repeat('é', 875), 'at', '2026-01-01T00:00:00.000Z')),
         'history', jsonb_build_array(jsonb_build_object('text', 'Contact added', 'at', '2026-01-01T00:00:00.000Z'))
       ) ORDER BY i)) FROM generate_series(1, 2000) i`,
      [scope],
    );
    await pool.query(
      `INSERT INTO crm_pipeline(scope,data) SELECT $1, jsonb_build_object('deals', jsonb_agg(jsonb_build_object(
         'id', md5($1||'d'||i)::uuid, 'revision', i % 5, 'kind', CASE WHEN i % 2 = 0 THEN 'deal' ELSE 'task' END,
         'title', 'Card '||i, 'value', i * 1.25, 'owner', 'Owner '||i,
         'stage', (ARRAY['New','In progress','Won'])[i % 3 + 1]
       ) ORDER BY i)) FROM generate_series(1, 500) i`,
      [scope],
    );
    const size = await pool.query(
      "SELECT octet_length(data::text) AS bytes, data FROM crm_contacts WHERE scope=$1",
      [scope],
    );
    expect(size.rows[0].bytes).toBeGreaterThan(4_000_000);
    expect(size.rows[0].bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    const contacts = size.rows[0].data.contacts;
    const deals = (await pool.query("SELECT data FROM crm_pipeline WHERE scope=$1", [scope]))
      .rows[0].data.deals;
    await move(scope);
    expect((await as(migrated, () => getContacts(scope))).contacts).toEqual(contacts);
    const board = await as(migrated, () => getPipeline(scope));
    const names = new Map(board.stages.map((s) => [s.id, s.name]));
    expect(board.stages.map((s) => [s.name, s.count])).toEqual([
      ["New", 166],
      ["In progress", 167],
      ["Won", 167],
    ]);
    expect(
      board.deals.map((d) => ({
        id: d.id,
        revision: d.revision,
        kind: d.kind,
        title: d.title,
        value: d.value,
        owner: d.owner,
        stage: names.get(d.stageId),
      })),
    ).toEqual(deals);
    const owners = await pool.query(
      "SELECT DISTINCT owner_id FROM crm_contact_rows WHERE org_id=$1 UNION SELECT DISTINCT owner_id FROM crm_deals WHERE org_id=$1",
      [scope],
    );
    expect(owners.rows).toEqual([{ owner_id: migrated }]);
    await pool.query("DELETE FROM crm_organisations WHERE id=$1", [scope]);
  }, 60_000);
  it("fails rather than move a card to another stage", async () => {
    const scope = await workspace();
    await pool.query(
      `INSERT INTO crm_pipeline(scope,data) VALUES($1, jsonb_build_object('deals', jsonb_build_array(jsonb_build_object(
         'id', gen_random_uuid(), 'kind', 'deal', 'title', 'Lost', 'value', 1, 'owner', 'Sam', 'stage', 'Archived'))))`,
      [scope],
    );
    await expect(move(scope)).rejects.toMatchObject({ code: "23502" });
    await pool.query("DELETE FROM crm_organisations WHERE id=$1", [scope]);
  });
});

describe("stages as data", () => {
  const stageNames = async (scope = org, user = own) =>
    (await as(user, () => getPipeline(scope))).stages.map((s) => s.name);
  const change = (user: string, body: Record<string, unknown>) =>
    as(user, () => updatePipeline(org, body));
  const card = async (title: string, stageId: string, value: number) =>
    change(editor, { action: "save", kind: "deal", title, value, owner: "Sam", stageId });
  it("drives the board, totals and filter from five stages added as data", async () => {
    await change(editor, { action: "stage-add", name: "Qualified" });
    await change(own, { action: "stage-add", name: "Lost" });
    let stages = (await as(own, () => getPipeline(org))).stages;
    const id = (name: string) => stages.find((s) => s.name === name)!.id;
    // Qualified goes between New and In progress; In progress is renamed.
    for (let i = 0; i < 3; i++)
      await change(editor, { action: "stage-move", stageId: id("Qualified"), direction: -1 });
    await expect(
      change(editor, { action: "stage-move", stageId: id("Qualified"), direction: -1 }),
    ).rejects.toThrow("Qualified is already first.");
    await change(editor, { action: "stage-move", stageId: id("Qualified"), direction: 1 });
    await change(editor, { action: "stage-rename", stageId: id("In progress"), name: "Proposal" });
    expect(await stageNames()).toEqual(["New", "Qualified", "Proposal", "Won", "Lost"]);
    expect(await stageNames(org2, other)).not.toContain("Qualified");
    stages = (await as(own, () => getPipeline(org))).stages;
    await card("Five A", id("Qualified"), 100);
    await card("Five B", id("Qualified"), 50.5);
    await card("Five C", id("Lost"), 7);
    const board = await as(viewer, () => getPipeline(org));
    const total = (name: string) => board.stages.find((s) => s.name === name);
    expect(total("Qualified")).toMatchObject({ count: 2, value: 150.5 });
    expect(total("Lost")).toMatchObject({ count: 1, value: 7 });
    const filtered = await as(viewer, () => getPipeline(org, { stage: id("Qualified") }));
    expect(filtered.deals.map((d) => d.title)).toEqual(["Five A", "Five B"]);
    expect(filtered.stages).toHaveLength(5);
    // A move to a stage added as data, and to another workspace's stage.
    const c = board.deals.find((d) => d.title === "Five C")!;
    await change(editor, { action: "move", id: c.id, revision: c.revision, stageId: id("Won") });
    const foreign = (await as(other, () => getPipeline(org2))).stages[0]!.id;
    await expect(
      change(editor, { action: "move", id: c.id, revision: c.revision + 1, stageId: foreign }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("refuses to remove a stage that has cards, and moves nothing", async () => {
    const before = await as(own, () => getPipeline(org));
    const won = before.stages.find((s) => s.name === "Won")!;
    expect(won.count).toBeGreaterThan(0);
    await expect(change(own, { action: "stage-remove", stageId: won.id })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/^Won still has \d+ cards?\. Move/),
    });
    const after = await as(own, () => getPipeline(org));
    expect(after.stages).toEqual(before.stages);
    expect(after.deals).toEqual(before.deals);
    // The database refuses it too.
    await expect(pool.query("DELETE FROM crm_stages WHERE id=$1", [won.id])).rejects.toMatchObject({
      code: "23503",
    });
    const lost = after.stages.find((s) => s.name === "Lost")!;
    expect(lost.count).toBe(0);
    await change(editor, { action: "stage-remove", stageId: lost.id });
    expect(await stageNames()).toEqual(["New", "Qualified", "Proposal", "Won"]);
  });
  it("refuses duplicate names and more than 20 stages", async () => {
    await expect(change(own, { action: "stage-add", name: " won " })).rejects.toMatchObject({
      message: "There is already a stage called won.",
    });
    const count = (await stageNames()).length;
    for (let i = count; i < 20; i++) await change(own, { action: "stage-add", name: `Extra ${i}` });
    await expect(change(own, { action: "stage-add", name: "One too many" })).rejects.toThrow(
      /up to 20 stages/,
    );
    await pool.query("DELETE FROM crm_stages WHERE org_id=$1 AND name LIKE 'Extra %'", [org]);
  });
  it("lets a viewer see the stages but change none of them", async () => {
    const board = await as(viewer, () => getPipeline(org));
    expect(board.canEdit).toBe(false);
    const stageId = board.stages[0]!.id;
    for (const body of [
      { action: "stage-add", name: "Viewer stage" },
      { action: "stage-rename", stageId, name: "Renamed" },
      { action: "stage-move", stageId, direction: 1 },
      { action: "stage-remove", stageId },
    ])
      await expect(change(viewer, body)).rejects.toMatchObject({ status: 403 });
    expect((await as(viewer, () => getPipeline(org))).stages).toEqual(board.stages);
  });
  it("rechecks permission after waiting for the organisation lock", async () => {
    const tx = await pool.connect();
    await tx.query("BEGIN");
    await tx.query("SELECT id FROM crm_organisations WHERE id=$1 FOR UPDATE", [org]);
    let settled = false;
    const adding = change(editor, { action: "stage-add", name: "Must not land" })
      .then(
        () => 0,
        (e) => e.status,
      )
      .finally(() => {
        settled = true;
      });
    try {
      await new Promise((r) => setTimeout(r, 150));
      expect(settled, "the stage change must wait on the organisation lock").toBe(false);
      await tx.query("UPDATE crm_members SET role='viewer' WHERE org_id=$1 AND user_id=$2", [
        org,
        editor,
      ]);
      await tx.query("COMMIT");
      expect(await adding).toBe(403);
      expect(await stageNames()).not.toContain("Must not land");
    } finally {
      tx.release();
      await pool.query("UPDATE crm_members SET role='editor' WHERE org_id=$1 AND user_id=$2", [
        org,
        editor,
      ]);
    }
  });
});

describe("one-person mode", () => {
  const team = Array.from({ length: 4 }, () => randomUUID());
  const [boss, amy, ben, vic] = team as [string, string, string, string];
  let scope = "";
  const solo = (user: string, on: boolean) =>
    workspaceAction(pool, user, { action: "one-person", on });
  // Everything a person's screens can fetch, as the response bodies would carry it.
  const bodies = async (user: string) =>
    JSON.stringify([
      await as(user, () => getContacts(scope)),
      await as(user, () => getContacts(scope, "ben")),
      await as(user, () => getPipeline(scope)),
      await as(user, () => getPipeline(scope, { sort: "renewal" })),
      await as(user, () => exportContacts(scope)),
    ]);
  beforeAll(async () => {
    for (const id of team)
      await pool.query(
        "INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,'not-a-password','member')",
        [id, email(id)],
      );
    await workspaceAction(pool, boss, { action: "create", name: "Solo team" });
    scope = (await membership(pool, boss))!.org_id;
    for (const [id, role] of [
      [amy, "editor"],
      [ben, "editor"],
      [vic, "viewer"],
    ] as const)
      await workspaceAction(pool, boss, { action: "grant", email: email(id), role });
    const stageId = (await as(boss, () => getPipeline(scope))).stages[0]!.id;
    for (const [user, name] of [
      [amy, "Amy"],
      [ben, "Ben"],
    ] as const) {
      await as(user, () =>
        updateContacts(scope, { action: "save", kind: "company", name: `${name} Holdings` }),
      );
      const company = (await as(user, () => getContacts(scope))).contacts.find(
        (c) => c.name === `${name} Holdings`,
      )!;
      await as(user, () =>
        updateContacts(scope, {
          action: "save",
          kind: "person",
          name: `${name} Client`,
          email: `${name.toLowerCase()}-client@example.test`,
          companyId: company.id,
        }),
      );
      await as(user, () =>
        updatePipeline(scope, {
          action: "save",
          kind: "deal",
          title: `${name} Deal`,
          value: name === "Amy" ? 10 : 1000,
          owner: name,
          stageId,
          companyId: company.id,
        }),
      );
    }
  });
  afterAll(async () => {
    await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [team]);
  });
  it("is off by default and only the workspace owner can turn it on", async () => {
    expect((await membership(pool, boss))!.one_person).toBe(false);
    expect(await bodies(amy)).toContain("Ben Client");
    await expect(solo(amy, true)).rejects.toMatchObject({ status: 403 });
    await expect(solo(vic, true)).rejects.toMatchObject({ status: 403 });
    await solo(boss, true);
    expect((await membership(pool, amy))!.one_person).toBe(true);
  });
  it("never puts another member's contacts or cards in a member's responses", async () => {
    const amys = await bodies(amy);
    for (const word of ["Ben", "ben-client"]) expect(amys).not.toContain(word);
    expect(amys).toContain("Amy Client");
    expect(await bodies(ben)).not.toContain("Amy");
    // Viewers own nothing, so they see nothing; the owner still sees all of it.
    expect(await bodies(vic)).not.toMatch(/Amy|Ben/);
    const all = await bodies(boss);
    for (const word of ["Amy Client", "Ben Client", "Ben Deal"]) expect(all).toContain(word);
    // Totals count only Amy's own card.
    const board = await as(amy, () => getPipeline(scope));
    expect(board.stages[0]).toMatchObject({ count: 1, value: 10 });
    expect((await as(boss, () => getPipeline(scope))).stages[0]).toMatchObject({
      count: 2,
      value: 1010,
    });
  });
  it("refuses a member's change to another member's rows, or a join to them", async () => {
    const bens = (await as(ben, () => getContacts(scope))).contacts;
    const benCompany = bens.find((c) => c.kind === "company")!;
    const benCard = (await as(ben, () => getPipeline(scope))).deals[0]!;
    await expect(
      as(amy, () =>
        updateContacts(scope, {
          action: "save",
          id: benCompany.id,
          revision: benCompany.revision,
          kind: "company",
          name: "Taken",
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as(amy, () =>
        updateContacts(scope, {
          action: "save",
          kind: "person",
          name: "Sneaky",
          companyId: benCompany.id,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      as(amy, () =>
        updatePipeline(scope, {
          action: "move",
          id: benCard.id,
          revision: benCard.revision,
          stageId: benCard.stageId,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const amyStage = (await as(amy, () => getPipeline(scope))).stages[0]!.id;
    await expect(
      as(amy, () =>
        updatePipeline(scope, {
          action: "save",
          kind: "deal",
          title: "Sneaky deal",
          value: 1,
          owner: "Amy",
          stageId: amyStage,
          contactId: bens.find((c) => c.kind === "person")!.id,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      as(vic, () => updateContacts(scope, { action: "save", kind: "person", name: "Viewer" })),
    ).rejects.toMatchObject({ status: 403 });
    // Ben's own card is still where it was.
    expect((await as(ben, () => getPipeline(scope))).deals[0]).toEqual(benCard);
  });
  it("keeps a link the owner made to a contact the member cannot see", async () => {
    await as(boss, () =>
      updateContacts(scope, { action: "save", kind: "company", name: "Boss Group" }),
    );
    const group = (await as(boss, () => getContacts(scope, "boss group"))).contacts[0]!;
    const card = (await as(amy, () => getPipeline(scope))).deals[0]!;
    await as(boss, () =>
      updatePipeline(scope, {
        ...card,
        action: "save",
        companyId: group.id,
        contactId: "",
      }),
    );
    const seen = (await as(amy, () => getPipeline(scope))).deals[0]!;
    expect(seen.company).toBe("");
    await as(amy, () => updatePipeline(scope, { ...seen, action: "save", title: "Amy Deal 2" }));
    const kept = await pool.query("SELECT company_id FROM crm_deals WHERE id=$1", [card.id]);
    expect(kept.rows[0].company_id).toBe(group.id);
    // The same for a person's company.
    const client = (await as(amy, () => getContacts(scope, "amy client"))).contacts[0]!;
    await as(boss, () => updateContacts(scope, { ...client, action: "save", companyId: group.id }));
    const linked = (await as(amy, () => getContacts(scope, "amy client"))).contacts[0]!;
    expect(linked.companyId).toBe("");
    await as(amy, () => updateContacts(scope, { ...linked, action: "save", name: "Amy Client" }));
    const person = await pool.query("SELECT company_id FROM crm_contact_rows WHERE id=$1", [
      client.id,
    ]);
    expect(person.rows[0].company_id).toBe(group.id);
  });
  it("restores the shared view when turned off", async () => {
    await solo(boss, false);
    const amys = await bodies(amy);
    for (const word of ["Ben Client", "Ben Deal", "Boss Group"]) expect(amys).toContain(word);
    await expect(
      as(vic, () => updatePipeline(scope, { action: "stage-add", name: "Viewer" })),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("renewal dates", () => {
  const save = async (title: string, renewalOn?: string) => {
    const stageId = (await as(own, () => getPipeline(org))).stages[0]!.id;
    await as(editor, () =>
      updatePipeline(org, {
        action: "save",
        kind: "deal",
        title,
        value: 1,
        owner: "Sam",
        stageId,
        ...(renewalOn === undefined ? {} : { renewalOn }),
      }),
    );
    return (await as(own, () => getPipeline(org))).deals.find((d) => d.title === title)!;
  };
  it("saves, clears and refuses impossible dates", async () => {
    const deal = await save("Renews soon", "2027-02-28");
    expect(deal.renewalOn).toBe("2027-02-28");
    await as(editor, () => updatePipeline(org, { ...deal, action: "save", renewalOn: "" }));
    const cleared = (await as(own, () => getPipeline(org))).deals.find((d) => d.id === deal.id)!;
    expect(cleared.renewalOn).toBe("");
    for (const renewalOn of ["2027-02-30", "2027-13-01", "28/02/2027", 20270228])
      await expect(
        as(editor, () => updatePipeline(org, { ...cleared, action: "save", renewalOn })),
      ).rejects.toThrow("Enter a renewal date, or leave it empty.");
  });
  it("sorts by renewal date with empty dates last", async () => {
    await save("Renews late", "2028-06-01");
    await save("Renews early", "2026-12-01");
    await save("No renewal");
    const deals = (await as(own, () => getPipeline(org, { sort: "renewal" }))).deals;
    const firstEmpty = deals.findIndex((d) => !d.renewalOn);
    expect(deals.slice(firstEmpty).every((d) => !d.renewalOn)).toBe(true);
    expect(deals.slice(0, firstEmpty).map((d) => d.renewalOn)).toEqual([
      "2026-12-01",
      "2028-06-01",
    ]);
    expect(deals.at(-1)?.title).toBe("No renewal");
  });
});

describe("rows that join and search", () => {
  it("joins a deal to its company and person, and unlinks them when they go", async () => {
    await as(editor, () =>
      updateContacts(org, { action: "save", kind: "company", name: "Acme Works" }),
    );
    const company = (await as(own, () => getContacts(org))).contacts.find(
      (c) => c.name === "Acme Works",
    )!;
    await as(editor, () =>
      updateContacts(org, {
        action: "save",
        kind: "person",
        name: "Rita Lane",
        email: "rita@north.test",
        companyId: company.id,
      }),
    );
    const person = (await as(own, () => getContacts(org))).contacts.find(
      (c) => c.name === "Rita Lane",
    )!;
    const { stages } = await as(own, () => getPipeline(org));
    await as(editor, () =>
      updatePipeline(org, {
        action: "save",
        kind: "deal",
        title: "Acme renewal",
        value: 900,
        owner: "Rita",
        stageId: stages[1]!.id,
        companyId: company.id,
        contactId: person.id,
      }),
    );
    const deal = (await as(own, () => getPipeline(org))).deals.find(
      (d) => d.title === "Acme renewal",
    )!;
    expect(deal).toMatchObject({ company: "Acme Works", contact: "Rita Lane" });
    const joined = await pool.query(
      "SELECT c.name FROM crm_deals d JOIN crm_contact_rows c ON c.org_id=d.org_id AND c.id=d.company_id WHERE d.id=$1",
      [deal.id],
    );
    expect(joined.rows).toEqual([{ name: "Acme Works" }]);
    // Another workspace's company, or a person given as the company, is refused.
    await as(other, () =>
      updateContacts(org2, { action: "save", kind: "company", name: "Theirs" }),
    );
    const theirs = (await as(other, () => getContacts(org2))).contacts[0]!;
    for (const companyId of [theirs.id, person.id])
      await expect(
        as(editor, () =>
          updatePipeline(org, {
            action: "save",
            id: deal.id,
            revision: deal.revision,
            kind: "deal",
            title: "Acme renewal",
            value: 900,
            owner: "Rita",
            companyId,
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    await as(own, () =>
      updateContacts(org, { action: "delete", id: company.id, revision: company.revision }),
    );
    const after = (await as(own, () => getPipeline(org))).deals.find((d) => d.id === deal.id)!;
    expect(after).toMatchObject({ companyId: "", company: "", contact: "Rita Lane" });
    // A card form opened before the company went is now stale, so its save is refused plainly.
    expect(after.revision).toBe(deal.revision + 1);
    await expect(
      as(editor, () => updatePipeline(org, { ...deal, action: "save" })),
    ).rejects.toMatchObject({ status: 409 });
    const rita = (await as(own, () => getContacts(org))).contacts.find((c) => c.id === person.id)!;
    expect(rita.companyId).toBe("");
    expect(rita.history[0]?.text).toBe("Company link removed");
  });
  it("searches by name, email and company within the workspace only", async () => {
    await as(editor, () =>
      updateContacts(org, { action: "save", kind: "company", name: "Blue Fern" }),
    );
    const fern = (await as(own, () => getContacts(org, "blue fern"))).contacts[0]!;
    await as(editor, () =>
      updateContacts(org, {
        action: "save",
        kind: "person",
        name: "Omar Quill",
        email: "omar@quill.test",
        companyId: fern.id,
      }),
    );
    await as(other, () =>
      updateContacts(org2, { action: "save", kind: "person", name: "Omar Elsewhere" }),
    );
    const names = async (search: string) =>
      (await as(own, () => getContacts(org, search))).contacts.map((c) => c.name).sort();
    expect(await names("omar")).toEqual(["Omar Quill"]);
    expect(await names("QUILL.TEST")).toEqual(["Omar Quill"]);
    expect(await names("fern")).toEqual(["Blue Fern", "Omar Quill"]);
    expect(await names("nobody")).toEqual([]);
  });
});
