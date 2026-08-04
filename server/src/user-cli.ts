/**
 * Operator commands. This is the ONLY way an account comes into existence —
 * invite-only is structural, not a missing feature (spec, threat model).
 *
 * Returns its output as a string rather than printing, so the behaviour is
 * testable and the process wrapper stays trivial.
 */
import type { DatabaseSync } from "node:sqlite";
import { generatePassword, hashPassword } from "./passwords.ts";
import { revokeAllSessionsForUser } from "./sessions.ts";
import {
  createUser, findUserByEmail, listUsers, setDisabled, setPasswordHash, setSpendCap,
} from "./users.ts";

const COMMANDS = ["create", "disable", "enable", "reset-password", "set-cap", "list"] as const;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requireEmail(argv: string[]): string {
  const email = flag(argv, "email");
  if (email === undefined) throw new Error("--email is required");
  return email;
}

function requireExisting(db: DatabaseSync, email: string) {
  const user = findUserByEmail(db, email);
  if (user === null) throw new Error(`no user with email ${email}`);
  return user;
}

export async function runUserCommand(db: DatabaseSync, argv: string[]): Promise<string> {
  const command = argv[0];

  if (command === "create") {
    // Refused, not ignored: a password on the command line lands in shell
    // history and the process table.
    if (argv.includes("--password")) {
      throw new Error("passwords cannot be supplied; one is generated and printed once");
    }
    const email = requireEmail(argv);
    if (findUserByEmail(db, email) !== null) throw new Error(`a user with email ${email} already exists`);
    const password = generatePassword();
    createUser(db, email, await hashPassword(password));
    return `created ${email}\n  password: ${password}\n  (shown once — it is not stored in plaintext)`;
  }

  if (command === "disable" || command === "enable") {
    const email = requireEmail(argv);
    const user = requireExisting(db, email);
    const disabling = command === "disable";
    setDisabled(db, user.id, disabling);
    if (disabling) revokeAllSessionsForUser(db, user.id);
    return disabling ? `disabled ${email} and revoked its sessions` : `enabled ${email}`;
  }

  if (command === "reset-password") {
    const email = requireEmail(argv);
    const user = requireExisting(db, email);
    const password = generatePassword();
    setPasswordHash(db, user.id, await hashPassword(password));
    // A reset usually means the old password is compromised or lost; leaving
    // live sessions running would defeat it.
    revokeAllSessionsForUser(db, user.id);
    return `reset ${email}\n  password: ${password}\n  (existing sessions revoked)`;
  }

  if (command === "set-cap") {
    const email = requireEmail(argv);
    const user = requireExisting(db, email);
    const raw = flag(argv, "usd");
    const usd = Number(raw);
    if (raw === undefined || !Number.isFinite(usd) || usd < 0) {
      throw new Error("--usd must be a non-negative number");
    }
    setSpendCap(db, user.id, usd);
    return `set ${email} spend cap to $${usd} per rolling 24h`;
  }

  if (command === "list") {
    const users = listUsers(db);
    if (users.length === 0) return "no users";
    // Never the hash.
    return users
      .map((u) => `${u.email}  cap=$${u.spendCapUsd}  ${u.disabledAt === null ? "active" : "disabled"}`)
      .join("\n");
  }

  throw new Error(`unknown command ${String(command)}; expected one of: ${COMMANDS.join(", ")}`);
}
