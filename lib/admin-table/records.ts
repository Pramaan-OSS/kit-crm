import { randomUUID } from "node:crypto";
import { CrmProblem, changeData, readData, text } from "../pramaan/crm-data";
export type Row = { id: string; title: string; notes: string; revision: number };
const initial = { records: [] as Row[] };
export const listRecords = (scope: string) => readData("records", scope, initial);
export const saveRecord = (scope: string, body: Record<string, unknown>) =>
  changeData("records", scope, initial, (state) => {
    const record = state.records.find((r) => r.id === body.id);
    if (body.id && !record) throw new CrmProblem("This record is no longer here.", 404);
    if (record && record.revision !== body.revision)
      throw new CrmProblem("This record changed. Reload and try again.", 409);
    if (body.action === "delete") {
      if (!record) throw new CrmProblem("Choose a record.");
      state.records = state.records.filter((r) => r.id !== record.id);
      return;
    }
    if (body.action !== "save") throw new CrmProblem("Choose a record action.");
    const title = text(body.title, "a title");
    const notes = text(body.notes, "notes", 4000);
    if (record) Object.assign(record, { title, notes, revision: record.revision + 1 });
    else {
      if (state.records.length >= 500)
        throw new CrmProblem("This workspace has 500 records. Remove one before adding more.");
      state.records.push({ id: randomUUID(), title, notes, revision: 0 });
    }
  });
// Prevent spreadsheet formula execution, including leading whitespace.
export function csvCell(value: string) {
  return `"${(/^[\s]*[=+@-]/u.test(value) ? "'" : "") + value.replaceAll('"', '""')}"`;
}
