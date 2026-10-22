import { expect, test } from "vitest";

import {
  commitAiProfileTransaction,
  recoverAiProfileTransaction,
  type AiProfileTransaction,
  type AiProfileTransactionIo,
} from "../../src/main/ai-profile-transaction";
import {
  deleteAiProfile,
  emptyAiProfileCatalog,
  saveAiConnectionProfile,
} from "../../src/main/ai-profile-store";

const profileId = "ai_000000000000000000000001";

function createMemoryIo(options?: { failCatalogWrites?: number }) {
  let journal: string | null = null;
  let remainingCatalogFailures = options?.failCatalogWrites ?? 0;
  const state = {
    credential: "old-encrypted-credential" as string | null,
    catalog: emptyAiProfileCatalog(),
  };
  const io: AiProfileTransactionIo = {
    readJournal: () => journal,
    writeJournal: (contents) => { journal = contents; },
    writeCredential: (_id, encryptedCredentialBase64) => {
      state.credential = Buffer.from(encryptedCredentialBase64, "base64").toString("utf8");
    },
    deleteCredential: () => { state.credential = null; },
    writeCatalog: (catalog) => {
      if (remainingCatalogFailures > 0) {
        remainingCatalogFailures -= 1;
        throw new Error("simulated catalog disk failure");
      }
      state.catalog = catalog;
    },
    deleteJournal: () => { journal = null; },
  };
  return { io, state, getJournal: () => journal };
}

function catalogWithProfile() {
  return saveAiConnectionProfile(emptyAiProfileCatalog(), {
    id: profileId,
    name: "Test profile",
    apiFormat: "openai_chat",
    model: "test-model",
    baseUrl: "https://example.invalid/v1",
  });
}

test("save transaction recovers credential/catalog mismatch after a partial write", () => {
  const memory = createMemoryIo({ failCatalogWrites: 1 });
  const transaction: AiProfileTransaction = {
    version: 1,
    profileId,
    credential: {
      kind: "write",
      encryptedCredentialBase64: Buffer.from("new-encrypted-credential", "utf8").toString("base64"),
    },
    catalog: catalogWithProfile(),
  };

  // The initial catalog write fails. The transaction runner replays the journal
  // before returning; this is the same idempotent operation startup recovery uses.
  commitAiProfileTransaction(transaction, memory.io);

  expect(memory.state.credential).toBe("new-encrypted-credential");
  expect(memory.state.catalog.profiles.map((profile) => profile.id)).toContain(profileId);
  expect(memory.getJournal()).toBeNull();
});

test("startup recovery completes an interrupted profile update", () => {
  const memory = createMemoryIo();
  memory.state.catalog = catalogWithProfile();
  const nextCatalog = saveAiConnectionProfile(memory.state.catalog, {
    id: profileId,
    name: "Updated profile",
    apiFormat: "openai_chat",
    model: "updated-model",
    baseUrl: "https://example.invalid/v1",
  });
  const pending: AiProfileTransaction = {
    version: 1,
    profileId,
    credential: {
      kind: "write",
      encryptedCredentialBase64: Buffer.from("updated-encrypted-credential", "utf8").toString("base64"),
    },
    catalog: nextCatalog,
  };

  // Model a restart after the credential file changed but before catalog write.
  memory.io.writeJournal(JSON.stringify(pending));
  memory.io.writeCredential(profileId, pending.credential.kind === "write"
    ? pending.credential.encryptedCredentialBase64
    : "");

  expect(recoverAiProfileTransaction(memory.io)).toBe(true);
  expect(memory.state.credential).toBe("updated-encrypted-credential");
  expect(memory.state.catalog.profiles[0]).toMatchObject({
    id: profileId,
    name: "Updated profile",
    model: "updated-model",
  });
  expect(memory.getJournal()).toBeNull();
});

test("delete transaction recovery removes a credential and profile idempotently", () => {
  const memory = createMemoryIo();
  memory.state.catalog = catalogWithProfile();
  const nextCatalog = deleteAiProfile(memory.state.catalog, profileId);
  const pending: AiProfileTransaction = {
    version: 1,
    profileId,
    credential: { kind: "delete" },
    catalog: nextCatalog,
  };
  // Model a process crash after the durable journal and credential deletion,
  // but before the catalog update.
  memory.io.writeJournal(JSON.stringify(pending));
  memory.io.deleteCredential(profileId);

  expect(recoverAiProfileTransaction(memory.io)).toBe(true);
  expect(memory.state.credential).toBeNull();
  expect(memory.state.catalog.profiles).toEqual([]);
  expect(recoverAiProfileTransaction(memory.io)).toBe(false);
});

test("transaction journal rejects catalog/credential actions for a different profile state", () => {
  const memory = createMemoryIo();
  const malformed: AiProfileTransaction = {
    version: 1,
    profileId,
    credential: { kind: "preserve" },
    catalog: emptyAiProfileCatalog(),
  };
  memory.io.writeJournal(JSON.stringify(malformed));

  expect(() => recoverAiProfileTransaction(memory.io)).toThrow(/does not match its catalog mutation/u);
  expect(memory.getJournal()).not.toBeNull();
});


test("clearing a saved credential preserves the selected connection through recovery", () => {
  const memory = createMemoryIo({ failCatalogWrites: 1 });
  const catalog = { ...catalogWithProfile(), activeProfileId: profileId };
  commitAiProfileTransaction({
    version: 1, profileId, credential: { kind: "delete" }, catalog,
  }, memory.io);
  expect(memory.state.credential).toBeNull();
  expect(memory.state.catalog).toEqual(catalog);
  expect(memory.getJournal()).toBeNull();
});
