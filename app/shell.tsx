import Link from "next/link";
import type { ReactNode } from "react";
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="border-b bg-white">
        <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-wrap gap-5 p-5">
          <Link href="/">Workspace</Link>
          <Link href="/contacts">Contacts</Link>
          <Link href="/board">Board</Link>
          <Link href="/team">Team</Link>
          <Link href="/records/note">Records</Link>
          <Link href="/owner">Owner settings</Link>
        </nav>
      </header>
      {children}
    </>
  );
}
