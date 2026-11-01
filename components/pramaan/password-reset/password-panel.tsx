"use client";
import { useState } from "react";
import { api } from "../../../lib/pramaan/client";
import { RESET_ANSWER, RESET_UNAVAILABLE } from "../../../lib/pramaan/password-reset";
export function PasswordPanel() {
  const [message, setMessage] = useState(RESET_UNAVAILABLE);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/api/account/reset-request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: new FormData(e.currentTarget).get("email") }),
          });
          setMessage(RESET_ANSWER);
        } catch {
          setMessage("Please try again later.");
        }
      }}
    >
      <label>
        Email
        <input name="email" type="email" required />
      </label>
      <button type="submit">Request reset link</button>
      <p role="status">{message}</p>
    </form>
  );
}
