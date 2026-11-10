import { ContactsPanel } from "../../components/pramaan/contacts/contacts-panel";
export default function Page() {
  return (
    <main className="workspace">
      <h1>People and companies</h1>
      <p>
        Keep people, company links, notes and their history together.{" "}
        <a href="/api/pramaan/contacts/export">Export contacts as a spreadsheet</a>
      </p>
      <ContactsPanel />
    </main>
  );
}
