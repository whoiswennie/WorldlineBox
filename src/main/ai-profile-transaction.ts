import {
  isAiProfileId,
  parseAiProfileCatalog,
  type AiProfileCatalog,
} from "./ai-profile-store";

export type AiProfileCredentialMutation =
  | { kind: "preserve" }
  | { kind: "write"; encryptedCredentialBase64: string }
  | { kind: "delete" };

export type AiProfileTransaction = {
  version: 1;
  profileId: string;
  credential: AiProfileCredentialMutation;
  catalog: AiProfileCatalog;
};

export type AiProfileTransactionIo = {
  readJournal(): string | null;
  writeJournal(contents: string): void;
  writeCredential(profileId: string, encryptedCredentialBase64: string): void;
  deleteCredential(profileId: string): void;
  writeCatalog(catalog: AiProfileCatalog): void;
  deleteJournal(): void;
};

export function commitAiProfileTransaction(
  transaction: AiProfileTransaction,
  io: AiProfileTransactionIo,
): void {
  const normalized = validateTransaction(transaction);
  io.writeJournal(JSON.stringify(normalized));
  try {
    applyTransaction(normalized, io);
    io.deleteJournal();
  } catch (error) {
    try {
      if (recoverAiProfileTransaction(io)) return;
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "AI profile transaction failed and will be retried on next startup.",
        { cause: recoveryError },
      );
    }
    throw error;
  }
}

/** Idempotently completes a prepared transaction after an interrupted write. */
export function recoverAiProfileTransaction(
  io: AiProfileTransactionIo,
): boolean {
  const journal = io.readJournal();
  if (journal === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(journal) as unknown;
  } catch (error) {
    throw new Error("AI profile transaction journal is not valid JSON.", {
      cause: error,
    });
  }
  const transaction = validateTransaction(parsed);
  applyTransaction(transaction, io);
  io.deleteJournal();
  return true;
}

function validateTransaction(input: unknown): AiProfileTransaction {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("AI profile transaction journal has an invalid structure.");
  }
  const value = input as Partial<AiProfileTransaction>;
  if (value.version !== 1 || typeof value.profileId !== "string" || !isAiProfileId(value.profileId)) {
    throw new Error("AI profile transaction journal has an invalid identity.");
  }
  const rawCredential = value.credential;
  if (!rawCredential || typeof rawCredential !== "object" || Array.isArray(rawCredential)) {
    throw new Error("AI profile transaction journal has an invalid credential action.");
  }
  let credential: AiProfileCredentialMutation;
  if (rawCredential.kind === "preserve" || rawCredential.kind === "delete") {
    credential = { kind: rawCredential.kind };
  } else if (
    rawCredential.kind === "write"
    && typeof rawCredential.encryptedCredentialBase64 === "string"
    && /^[A-Za-z0-9+/]+={0,2}$/u.test(rawCredential.encryptedCredentialBase64)
    && rawCredential.encryptedCredentialBase64.length % 4 === 0
  ) {
    credential = {
      kind: "write",
      encryptedCredentialBase64: rawCredential.encryptedCredentialBase64,
    };
  } else {
    throw new Error("AI profile transaction journal has an invalid credential action.");
  }
  const catalog = parseAiProfileCatalog(value.catalog);
  const profileIsPresent = catalog.profiles.some((profile) => profile.id === value.profileId);
  if (credential.kind !== "delete" && !profileIsPresent) {
    throw new Error("AI profile transaction does not match its catalog mutation.");
  }
  return {
    version: 1,
    profileId: value.profileId,
    credential,
    catalog,
  };
}

function applyTransaction(
  transaction: AiProfileTransaction,
  io: AiProfileTransactionIo,
): void {
  if (transaction.credential.kind === "write") {
    io.writeCredential(
      transaction.profileId,
      transaction.credential.encryptedCredentialBase64,
    );
  } else if (transaction.credential.kind === "delete") {
    io.deleteCredential(transaction.profileId);
  }
  io.writeCatalog(transaction.catalog);
}
