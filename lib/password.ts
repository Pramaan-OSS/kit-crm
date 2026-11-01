import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Password helpers adapted from the MIT password-reset block; see NOTICE.md.
type ResetAccount = { id: string; email: string; passwordHash: string };
type ResetStore = { change(id: string, oldHash: string, passwordHash: string): Promise<boolean> };
export class PasswordResetError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let passwordWork = 0;
const SCRYPT = { N: 131072, r: 8, p: 1 };
async function derive(password: string, salt: string, parameters = SCRYPT): Promise<Buffer> {
  if (passwordWork >= 4) throw new PasswordResetError(429, "Please wait a moment and try again.");
  passwordWork++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(password, salt, 64, { ...parameters, maxmem: 256 * 1024 * 1024 }, (error, key) =>
        error ? reject(error) : resolve(key),
      ),
    );
  } finally {
    passwordWork--;
  }
}
export async function hashResetPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyResetPassword(password: string, encoded: string) {
  const legacy = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded);
  const modern =
    /^scrypt\$N=(\d{1,6}),r=(\d{1,2}),p=(\d{1,2})\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  const salt = legacy?.[1] ?? modern?.[4];
  const key = legacy?.[2] ?? modern?.[5];
  if (!salt || !key) return false;
  const parameters = legacy
    ? { N: 16384, r: 8, p: 1 }
    : { N: Number(modern?.[1]), r: Number(modern?.[2]), p: Number(modern?.[3]) };
  // Read older costs, but never let a corrupt row select unbounded work or memory.
  if (
    ![16384, 32768, 65536, 131072].includes(parameters.N) ||
    parameters.r !== 8 ||
    parameters.p < 1 ||
    parameters.N * parameters.p > 131072
  )
    return false;
  return timingSafeEqual(await derive(password, salt, parameters), Buffer.from(key, "hex"));
}

/** Hosts can upgrade a successfully verified password on the next sign-in. Changes always upgrade. */
export const resetPasswordNeedsUpgrade = (encoded: string) =>
  !encoded.startsWith("scrypt$N=131072,r=8,p=1$");

/** Sign-in integration: verify first, then replace an older hash with a compare-and-set. */
export async function verifyAndUpgradeResetPassword(
  store: Pick<ResetStore, "change">,
  account: ResetAccount,
  password: string,
) {
  if (!(await verifyResetPassword(password, account.passwordHash))) return false;
  return (
    !resetPasswordNeedsUpgrade(account.passwordHash) ||
    store.change(account.id, account.passwordHash, await hashResetPassword(password))
  );
}
