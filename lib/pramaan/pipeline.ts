import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { CrmProblem, checkRevision, text, withScope } from "./crm-data";
/** A workspace's stages live in crm_stages (0106), ordered by position; count and value are its visible cards. */
export type Stage = { id: string; name: string; position: number; count: number; value: number };
export type Deal = {
  id: string;
  revision: number;
  title: string;
  kind: "deal" | "task";
  stageId: string;
  value: number;
  owner: string;
  companyId: string;
  contactId: string;
  company: string;
  contact: string;
  /** YYYY-MM-DD, or "" when there is none. */
  renewalOn: string;
};
export type Choice = { id: string; name: string };
export type PipelineData = {
  stages: Stage[];
  deals: Deal[];
  companies: Choice[];
  people: Choice[];
  canEdit: boolean;
};
export const MAX_DEALS = 500;
export const MAX_STAGES = 20;
const uuid = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value) ? value : undefined;
// $2 is Access.only: in one-person mode a member's cards, their totals and the contacts they join to are their own.
const MINE = (alias: string) => `($2::uuid IS NULL OR ${alias}.owner_id=$2)`;
async function stages(tx: PoolClient, scope: string, only: string | null) {
  return (
    await tx.query<Stage>(
      `SELECT s.id,s.name,s.position,count(d.id)::int AS count,coalesce(sum(d.value),0)::float8 AS value
       FROM crm_stages s LEFT JOIN crm_deals d ON d.org_id=s.org_id AND d.stage_id=s.id AND ${MINE("d")}
       WHERE s.org_id=$1 GROUP BY s.id ORDER BY s.position,s.id`,
      [scope, only],
    )
  ).rows;
}
export function getPipeline(scope: string, filter: { stage?: string; sort?: string } = {}) {
  return withScope(scope, false, async (tx, access): Promise<PipelineData> => {
    const deals = await tx.query<Deal>(
      `SELECT d.id,d.revision,d.title,d.kind,d.stage_id AS "stageId",d.value::float8 AS value,d.owner,
         coalesce(co.id::text,'') AS "companyId",coalesce(co.name,'') AS company,
         coalesce(p.id::text,'') AS "contactId",coalesce(p.name,'') AS contact,
         coalesce(to_char(d.renewal_on,'YYYY-MM-DD'),'') AS "renewalOn"
       FROM crm_deals d
       LEFT JOIN crm_contact_rows co ON co.org_id=d.org_id AND co.id=d.company_id AND ${MINE("co")}
       LEFT JOIN crm_contact_rows p ON p.org_id=d.org_id AND p.id=d.contact_id AND ${MINE("p")}
       WHERE d.org_id=$1 AND ${MINE("d")} AND ($3::uuid IS NULL OR d.stage_id=$3)
       ORDER BY ${filter.sort === "renewal" ? "d.renewal_on NULLS LAST," : ""}d.seq`,
      [scope, access.only, uuid(filter.stage) ?? null],
    );
    const choices = await tx.query<Choice & { kind: string }>(
      `SELECT id,name,kind FROM crm_contact_rows d WHERE org_id=$1 AND ${MINE("d")} ORDER BY lower(name),seq`,
      [scope, access.only],
    );
    return {
      stages: await stages(tx, scope, access.only),
      deals: deals.rows,
      companies: choices.rows
        .filter((c) => c.kind === "company")
        .map(({ id, name }) => ({ id, name })),
      people: choices.rows.filter((c) => c.kind === "person").map(({ id, name }) => ({ id, name })),
      canEdit: access.role !== "viewer",
    };
  });
}
/** Adds, renames, reorders or removes a stage. A stage with cards is never removed and its cards never move. */
async function changeStage(
  tx: PoolClient,
  scope: string,
  only: string | null,
  body: Record<string, unknown>,
) {
  const list = await stages(tx, scope, only);
  const stage = list.find((s) => s.id === uuid(body.stageId));
  const named = () => {
    const name = text(body.name, "a stage name", 60);
    if (list.some((s) => s.id !== stage?.id && s.name.toLowerCase() === name.toLowerCase()))
      throw new CrmProblem(`There is already a stage called ${name}.`);
    return name;
  };
  if (body.action === "stage-add") {
    if (list.length >= MAX_STAGES)
      throw new CrmProblem(`A board can have up to ${MAX_STAGES} stages.`);
    await tx.query("INSERT INTO crm_stages(org_id,name,position) VALUES($1,$2,$3)", [
      scope,
      named(),
      list.length,
    ]);
    return { saved: true };
  }
  if (!stage) throw new CrmProblem("This stage is no longer on the board.", 404);
  if (body.action === "stage-rename") {
    await tx.query("UPDATE crm_stages SET name=$3 WHERE org_id=$1 AND id=$2", [
      scope,
      stage.id,
      named(),
    ]);
  } else if (body.action === "stage-move") {
    const from = list.indexOf(stage);
    const to = from + (body.direction === -1 ? -1 : body.direction === 1 ? 1 : 0);
    if (to === from) throw new CrmProblem("Choose up or down.");
    if (to < 0 || to >= list.length)
      throw new CrmProblem(`${stage.name} is already ${to < 0 ? "first" : "last"}.`);
    list.splice(to, 0, ...list.splice(from, 1));
    await tx.query(
      "UPDATE crm_stages s SET position=o.n-1 FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id,n) WHERE s.org_id=$1 AND s.id=o.id",
      [scope, list.map((s) => s.id)],
    );
  } else if (body.action === "stage-remove") {
    const cards = await tx.query("SELECT count(*) FROM crm_deals WHERE org_id=$1 AND stage_id=$2", [
      scope,
      stage.id,
    ]);
    const count = Number(cards.rows[0].count);
    // In one-person mode the count would include other people's cards, so it is not said.
    if (count)
      throw new CrmProblem(
        only
          ? `${stage.name} still has cards. Ask the workspace owner to move them first.`
          : `${stage.name} still has ${count} ${count === 1 ? "card" : "cards"}. Move ${count === 1 ? "it" : "them"} to another stage first.`,
      );
    if (list.length === 1) throw new CrmProblem("A board needs at least one stage.");
    await tx.query("DELETE FROM crm_stages WHERE org_id=$1 AND id=$2", [scope, stage.id]);
  } else throw new CrmProblem("Choose a stage change.");
  return { saved: true };
}
export function updatePipeline(scope: string, body: Record<string, unknown>) {
  return withScope(scope, true, async (tx, access) => {
    if (typeof body.action === "string" && body.action.startsWith("stage-"))
      return changeStage(tx, scope, access.only, body);
    const stageOf = async (id: unknown) =>
      (await stages(tx, scope, access.only)).find((s) => s.id === uuid(id));
    const existing = uuid(body.id)
      ? (
          await tx.query<{
            id: string;
            revision: number;
            stage_id: string;
            company_id: string | null;
            contact_id: string | null;
          }>(
            `SELECT id,revision,stage_id,company_id,contact_id FROM crm_deals d
             WHERE org_id=$1 AND ${MINE("d")} AND id=$3 FOR UPDATE`,
            [scope, access.only, body.id],
          )
        ).rows[0]
      : undefined;
    if (body.id && !existing) throw new CrmProblem("This card is no longer available.", 404);
    if (existing) checkRevision(existing, body.revision, "card");
    if (body.action === "delete") {
      if (!existing) throw new CrmProblem("Choose a card to remove.");
      await tx.query("DELETE FROM crm_deals WHERE org_id=$1 AND id=$2", [scope, existing.id]);
      return { saved: true };
    }
    if (body.action === "move") {
      if (!existing) throw new CrmProblem("Choose a card to move.");
      const stage = await stageOf(body.stageId);
      if (!stage) throw new CrmProblem("Choose a stage from the board.");
      if (existing.stage_id !== stage.id)
        await tx.query(
          "UPDATE crm_deals SET stage_id=$3,revision=revision+1 WHERE org_id=$1 AND id=$2",
          [scope, existing.id, stage.id],
        );
      return { saved: true };
    }
    if (body.action !== "save") throw new CrmProblem("Choose an action to continue.");
    const stage = existing ? undefined : await stageOf(body.stageId);
    if (!existing && !stage) throw new CrmProblem("Choose a stage from the board.");
    if (body.kind !== "deal" && body.kind !== "task") throw new CrmProblem("Choose deal or task.");
    if (
      typeof body.value !== "number" ||
      !Number.isFinite(body.value) ||
      body.value < 0 ||
      body.value > 1e12 ||
      Number(body.value.toFixed(2)) !== body.value
    )
      throw new CrmProblem("Enter a value of £0 or more, with up to two decimal places.");
    const visible = async (id: unknown, kind: "company" | "person") =>
      uuid(id)
        ? (
            await tx.query(
              `SELECT id FROM crm_contact_rows d WHERE org_id=$1 AND ${MINE("d")} AND id=$3 AND kind=$4`,
              [scope, access.only, id, kind],
            )
          ).rows[0]?.id
        : undefined;
    const link = async (
      id: unknown,
      kind: "company" | "person",
      label: string,
      current: string | null = null,
    ) => {
      // A link to a contact this person cannot see is kept, never cleared by a form that could not show it.
      if (id === undefined || id === "")
        return current && !(await visible(current, kind)) ? current : null;
      const row = await visible(id, kind);
      if (!row) throw new CrmProblem(`Choose ${label} from this workspace.`);
      return row as string;
    };
    const renewal = body.renewalOn ?? "";
    const date = typeof renewal === "string" ? new Date(`${renewal}T00:00:00Z`) : undefined;
    if (
      renewal !== "" &&
      (!date ||
        !/^\d{4}-\d{2}-\d{2}$/.test(renewal as string) ||
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== renewal)
    )
      throw new CrmProblem("Enter a renewal date, or leave it empty.");
    const fields = [
      text(body.title, "a title"),
      text(body.owner, "an owner"),
      Math.round(body.value * 100) / 100,
      body.kind,
      await link(body.companyId, "company", "a company", existing?.company_id),
      await link(body.contactId, "person", "a person", existing?.contact_id),
      renewal || null,
    ];
    if (existing) {
      await tx.query(
        "UPDATE crm_deals SET title=$3,owner=$4,value=$5,kind=$6,company_id=$7,contact_id=$8,renewal_on=$9,revision=revision+1 WHERE org_id=$1 AND id=$2",
        [scope, existing.id, ...fields],
      );
      return { saved: true };
    }
    const count = await tx.query("SELECT count(*) FROM crm_deals WHERE org_id=$1", [scope]);
    if (Number(count.rows[0].count) >= MAX_DEALS)
      throw new CrmProblem("This workspace is full. Remove some cards to add more.");
    await tx.query(
      "INSERT INTO crm_deals(id,org_id,owner_id,title,owner,value,kind,company_id,contact_id,renewal_on,stage_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [randomUUID(), scope, access.user, ...fields, stage?.id],
    );
    return { saved: true };
  });
}
