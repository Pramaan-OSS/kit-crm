import { notFound } from "next/navigation";
import { RecordsTable } from "./records-table";
export default async function Page({ params }: { params: Promise<{ entity: string }> }) {
  if ((await params).entity !== "note") notFound();
  return (
    <main className="workspace">
      <h1>Internal notes</h1>
      <p>Search, edit and export notes shared with your team.</p>
      <RecordsTable />
    </main>
  );
}
