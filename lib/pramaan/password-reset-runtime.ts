import { accountRuntime } from "../runtime";
export async function handlePasswordReset(request: Request) {
  // The starter owns proof lifetime, verified address checks and session revocation.
  return accountRuntime().handle(request, "reset-request");
}
