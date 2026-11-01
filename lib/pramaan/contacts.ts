import { randomUUID } from "node:crypto";
import { CrmProblem, changeData, checkRevision, readData, text } from "./crm-data";
export type Contact = {
  id: string;
  revision: number;
  kind: "person" | "company";
  name: string;
  email: string;
  companyId: string;
  notes: { text: string; at: string }[];
  history: { text: string; at: string }[];
};
export type ContactsData = { contacts: Contact[] };
const initial: ContactsData = { contacts: [] };
export async function getContacts(scope: string) {
  const state = await readData("contacts", scope, initial);
  return {
    contacts: state.contacts.map((contact) => ({ ...contact, revision: contact.revision ?? 0 })),
  };
}
function recordHistory(contact: Contact, message: string, at: string) {
  contact.history.unshift({ text: message, at });
  contact.history.length = Math.min(contact.history.length, 50);
  contact.revision = (contact.revision ?? 0) + 1;
}
export function updateContacts(scope: string, body: Record<string, unknown>) {
  return changeData("contacts", scope, initial, (state) => {
    const at = new Date().toISOString();
    const existing = state.contacts.find((c) => c.id === body.id);
    if (body.id && !existing) throw new CrmProblem("This contact is no longer available.", 404);
    if (existing) {
      existing.revision ??= 0;
      checkRevision(existing, body.revision, "contact");
    }
    if (body.action === "delete") {
      if (!existing) throw new CrmProblem("Choose a contact to remove.");
      state.contacts = state.contacts.filter((c) => c.id !== existing.id);
      for (const person of state.contacts) {
        if (person.companyId === existing.id) {
          person.companyId = "";
          recordHistory(person, "Company link removed", at);
        }
      }
      return;
    }
    if (body.action === "note" || body.action === "delete-note") {
      if (!existing) throw new CrmProblem("Choose a contact for this note.");
      if (body.action === "note") {
        if (existing.notes.length >= 200)
          throw new CrmProblem("This contact has 200 notes. Remove a note to add another.");
        existing.notes.unshift({ text: text(body.note, "a note", 4000), at });
        recordHistory(existing, "Note added", at);
      } else {
        if (
          !Number.isInteger(body.noteIndex) ||
          (body.noteIndex as number) < 0 ||
          (body.noteIndex as number) >= existing.notes.length
        )
          throw new CrmProblem("This note is no longer available.", 404);
        existing.notes.splice(body.noteIndex as number, 1);
        recordHistory(existing, "Note removed", at);
      }
      return;
    }
    if (body.action !== "save") throw new CrmProblem("Choose an action to continue.");
    if (body.kind !== "person" && body.kind !== "company")
      throw new CrmProblem("Choose person or company.");
    const name = text(body.name, "a name");
    const email = text(body.email ?? "", "an email address", 254, false);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new CrmProblem("Enter a valid email address.");
    const companyId = text(body.companyId ?? "", "a company", 100, false);
    if (
      companyId &&
      (body.kind !== "person" ||
        !state.contacts.some((c) => c.id === companyId && c.kind === "company"))
    )
      throw new CrmProblem("Choose a company from this workspace.");
    if (existing && existing.kind !== body.kind)
      throw new CrmProblem("Keep the same contact type.");
    const fields = { name, email, companyId, kind: body.kind } as const;
    if (existing) {
      const linked = existing.companyId !== companyId;
      Object.assign(existing, fields);
      recordHistory(existing, linked ? "Company link changed" : "Contact updated", at);
    } else {
      if (state.contacts.length >= 2000)
        throw new CrmProblem("This workspace is full. Remove some contacts to add more.");
      state.contacts.push({
        ...fields,
        id: randomUUID(),
        revision: 0,
        notes: [],
        history: [{ text: "Contact added", at }],
      });
    }
  });
}
