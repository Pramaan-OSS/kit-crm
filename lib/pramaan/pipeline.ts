import { randomUUID } from "node:crypto";
import { CrmProblem, changeData, checkRevision, readData, text } from "./crm-data";
export const stages = ["New", "In progress", "Won"] as const;
export type Stage = (typeof stages)[number];
export type Deal = {
  id: string;
  revision: number;
  title: string;
  kind: "deal" | "task";
  stage: Stage;
  value: number;
  owner: string;
};
export type PipelineData = { deals: Deal[] };
const initial: PipelineData = { deals: [] };
export async function getPipeline(scope: string) {
  const state = await readData("pipeline", scope, initial);
  return { deals: state.deals.map((card) => ({ ...card, revision: card.revision ?? 0 })) };
}
export function updatePipeline(scope: string, body: Record<string, unknown>) {
  return changeData("pipeline", scope, initial, (state) => {
    const existing = state.deals.find((d) => d.id === body.id);
    if (body.id && !existing) throw new CrmProblem("This card is no longer available.", 404);
    if (existing) {
      existing.revision ??= 0;
      checkRevision(existing, body.revision, "card");
    }
    if (body.action === "delete") {
      if (!existing) throw new CrmProblem("Choose a card to remove.");
      state.deals = state.deals.filter((d) => d.id !== existing.id);
      return;
    }
    if (body.action === "move") {
      if (!existing) throw new CrmProblem("Choose a card to move.");
      if (!stages.includes(body.stage as Stage))
        throw new CrmProblem("Choose a stage from the board.");
      if (existing.stage !== body.stage) {
        existing.stage = body.stage as Stage;
        existing.revision++;
      }
      return;
    }
    if (body.action !== "save") throw new CrmProblem("Choose an action to continue.");
    if (!existing && !stages.includes(body.stage as Stage))
      throw new CrmProblem("Choose a stage from the board.");
    if (body.kind !== "deal" && body.kind !== "task") throw new CrmProblem("Choose deal or task.");
    if (
      typeof body.value !== "number" ||
      !Number.isFinite(body.value) ||
      body.value < 0 ||
      body.value > 1e12 ||
      Number(body.value.toFixed(2)) !== body.value
    )
      throw new CrmProblem("Enter a value of £0 or more, with up to two decimal places.");
    const fields = {
      title: text(body.title, "a title"),
      owner: text(body.owner, "an owner"),
      value: Math.round(body.value * 100) / 100,
      kind: body.kind,
    } as const;
    if (existing) {
      Object.assign(existing, fields);
      existing.revision++;
    } else {
      if (state.deals.length >= 500)
        throw new CrmProblem("This workspace is full. Remove some cards to add more.");
      state.deals.push({ ...fields, stage: body.stage as Stage, id: randomUUID(), revision: 0 });
    }
  });
}
