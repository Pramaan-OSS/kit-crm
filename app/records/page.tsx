import Link from "next/link";
export default function Page() {
  return (
    <main className="workspace">
      <h1>Internal records</h1>
      <Link href="/records/note">Open shared notes</Link>
    </main>
  );
}
