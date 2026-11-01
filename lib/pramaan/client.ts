"use client";
import { useCallback, useEffect, useState } from "react";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      typeof body.error === "string"
        ? body.error
        : (body.error?.message ?? body.message ?? "Please try again."),
    );
  return body;
}
export function useResource<T>(url: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void version; // Reload explicitly starts a fresh request.
    let active = true;
    setLoading(true);
    api<T>(url)
      .then(
        (value) => {
          if (active) {
            setData(value);
            setError(undefined);
          }
        },
        (e) => {
          if (active) setError(e);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [url, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading, reload };
}
