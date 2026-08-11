// Behavioural tests for batch conflict resolution.
//
// The interesting properties are not just "the right bytes land on disk" but
// "how much work did it take" — resolving N conflicts used to cost ~7N Drive
// round trips and N full vault walks.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { App } from "obsidian";

vi.mock("../src/core/googleDrive", async () => {
  const { createFakeDrive } = await import("./helpers/fakeDrive");
  return createFakeDrive();
});

vi.mock("../src/core/googleDriveAuth", () => ({
  decodeBackupToken: vi.fn(),
  fetchEncryptedAuth: vi.fn(),
  decryptAuthData: vi.fn(),
  refreshAccessToken: vi.fn(),
  getValidSessionTokens: vi.fn(async (tokens: unknown) => tokens),
}));

import * as driveModule from "../src/core/googleDrive";
import { DriveSyncManager } from "../src/core/driveSync";
import {
  getConflictBackupFolder,
  getLocalMetaPath,
  type LocalDriveSyncMeta,
} from "../src/core/driveSyncMeta";
import { SYNC_META_FILE_NAME, type SyncMeta, type ConflictInfo } from "../src/core/syncDiff";
import { md5HashString } from "../src/core/driveSyncUtils";
import { FakeVault, createFakeApp } from "./helpers/fakeVault";
import type { FakeDriveState } from "./helpers/fakeDrive";

const fake = driveModule as unknown as {
  __state: FakeDriveState;
  __put: (name: string, content: string, id?: string) => { id: string };
};

const META_FILE_ID = "meta-file";

interface Fixture {
  manager: DriveSyncManager;
  vault: FakeVault;
  state: FakeDriveState;
}

interface ConflictSpec {
  path: string;
  local: string;
  remote: string;
  /** Remote side deleted the file: it stays out of the remote metadata. */
  editDelete?: boolean;
}

/**
 * Build a manager with `files` in conflict: each path exists locally with
 * `local` content and remotely with `remote` content, and the local metadata
 * records a checksum that matches neither, exactly as a real conflict does.
 */
function setup(files: ConflictSpec[]): Fixture {
  fake.__state.files.clear();
  fake.__state.contents.clear();
  fake.__state.failFileIds.clear();
  fake.__state.failUpdateFileIds.clear();
  fake.__state.onReadFile = undefined;
  fake.__state.reset();
  fake.__state.nextId = 1;

  const vault = new FakeVault();
  const remoteMeta: SyncMeta = { lastUpdatedAt: "2026-08-01T00:00:00.000Z", files: {} };
  const localMeta: LocalDriveSyncMeta = { lastUpdatedAt: "", files: {}, pathToId: {} };
  const conflicts: ConflictInfo[] = [];

  for (const { path, local, remote, editDelete } of files) {
    vault.setFile(path, local);
    const driveFile = fake.__put(path, remote);

    if (!editDelete) {
      remoteMeta.files[driveFile.id] = {
        name: path,
        mimeType: "text/markdown",
        md5Checksum: md5HashString(remote),
        modifiedTime: "2026-08-01T00:00:00.000Z",
      };
    }
    localMeta.pathToId[path] = driveFile.id;
    localMeta.files[driveFile.id] = {
      md5Checksum: md5HashString(`${local}-stale-base`),
      modifiedTime: "2026-07-01T00:00:00.000Z",
      name: path,
    };
    conflicts.push({
      fileId: driveFile.id,
      fileName: path,
      localChecksum: md5HashString(local),
      remoteChecksum: md5HashString(remote),
      localModifiedTime: "2026-08-02T00:00:00.000Z",
      remoteModifiedTime: "2026-08-01T00:00:00.000Z",
      isEditDelete: editDelete,
    });
  }

  vault.setFile(getLocalMetaPath(), JSON.stringify(localMeta));
  // The remote metadata document lives on Drive like any other file.
  fake.__state.files.set(META_FILE_ID, {
    id: META_FILE_ID,
    name: SYNC_META_FILE_NAME,
    mimeType: "application/json",
  });
  fake.__state.contents.set(META_FILE_ID, JSON.stringify(remoteMeta));

  const plugin = {
    settings: { driveSync: { enabled: true, excludePatterns: [], encryptedAuth: {} } },
    saveSettings: vi.fn(async () => undefined),
  };
  const manager = new DriveSyncManager(createFakeApp(vault) as unknown as App, plugin as never);
  manager.conflicts = conflicts;
  manager.syncStatus = "conflict";

  // Unlock without going through the password flow.
  (manager as unknown as { sessionTokens: unknown }).sessionTokens = {
    accessToken: "token",
    rootFolderId: "root",
  };
  // pull() re-syncs the whole vault; it is out of scope here and covered by its
  // own code path, so assert it was requested rather than running it.
  vi.spyOn(manager, "pull").mockResolvedValue(undefined);

  vault.resetCounters();
  fake.__state.reset();
  return { manager, vault, state: fake.__state };
}

const backups = (vault: FakeVault) => vault.pathsUnder(getConflictBackupFolder());
const readLocalMeta = (vault: FakeVault): LocalDriveSyncMeta =>
  JSON.parse(vault.getFile(getLocalMetaPath())!);
/** Writes of the Drive-side _sync-meta.json document. */
const remoteMetaWrites = (state: FakeDriveState) =>
  state.calls.filter((c) => c.fn === "updateFile" && c.args[1] === META_FILE_ID).length;

const manyFiles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    path: `notes/f${i}.md`,
    local: `local ${i}`,
    remote: `remote ${i}`,
  }));

describe("resolveConflicts — keep remote", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = setup(manyFiles(12));
  });

  it("downloads remote content and backs up the discarded local copy", async () => {
    const { manager, vault } = fixture;
    const result = await manager.resolveConflicts(
      manager.conflicts.map((c) => c.fileId),
      "remote"
    );

    expect(result).toEqual({ resolved: 12, failed: 0 });
    expect(vault.getFile("notes/f0.md")).toBe("remote 0");
    expect(vault.getFile("notes/f11.md")).toBe("remote 11");

    const saved = backups(vault);
    expect(saved).toHaveLength(12);
    expect(saved.map((p) => vault.getFile(p)).sort()).toEqual(
      manyFiles(12).map((f) => f.local).sort()
    );
  });

  it("never writes the remote metadata document, because it never mutates it", async () => {
    const { manager, state } = fixture;
    await manager.resolveConflicts(manager.conflicts.map((c) => c.fileId), "remote");

    expect(remoteMetaWrites(state)).toBe(0);
    // It is read exactly once for the whole batch, not once per file.
    expect(state.countCalls("findFileByExactName")).toBe(1);
    expect(state.calls.filter((c) => c.fn === "readFile" && c.args[1] === META_FILE_ID)).toHaveLength(1);
  });

  it("writes the local metadata once for the whole batch", async () => {
    const { manager, vault } = fixture;
    const metaPath = getLocalMetaPath();
    let metaWrites = 0;
    const realWrite = vault.adapter.write;
    vault.adapter.write = async (path: string, content: string) => {
      if (path === metaPath) metaWrites++;
      return realWrite(path, content);
    };

    await manager.resolveConflicts(manager.conflicts.map((c) => c.fileId), "remote");
    expect(metaWrites).toBe(1);
  });

  it("does not walk the whole vault — it stats only the paths it touched", async () => {
    const { manager, vault } = fixture;
    // A full walk would list every folder; 12 files means 12 touched paths.
    await manager.resolveConflicts(manager.conflicts.map((c) => c.fileId), "remote");

    expect(vault.counters.list).toBe(0);
    expect(vault.counters.stat).toBeLessThanOrEqual(12);
  });

  it("runs the per-item Drive work in parallel batches", async () => {
    const { manager, state } = fixture;
    await manager.resolveConflicts(manager.conflicts.map((c) => c.fileId), "remote");

    // CONCURRENCY is 5; serial execution would peak at 1.
    expect(state.maxConcurrent).toBeGreaterThan(1);
    expect(state.maxConcurrent).toBeLessThanOrEqual(5);
  });

  it("adopts the remote entry in local metadata", async () => {
    const { manager, vault } = fixture;
    const fileId = manager.conflicts[0].fileId;
    await manager.resolveConflicts(manager.conflicts.map((c) => c.fileId), "remote");

    const meta = readLocalMeta(vault);
    expect(meta.pathToId["notes/f0.md"]).toBe(fileId);
    expect(meta.files[fileId].md5Checksum).toBe(md5HashString("remote 0"));
    expect(meta.files[fileId].localMtime).toBeGreaterThan(0);
  });

  it("clears the conflict list and requests a pull once everything is resolved", async () => {
    const { manager } = fixture;
    await manager.resolveConflicts(manager.conflicts.map((c) => c.fileId), "remote");

    expect(manager.conflicts).toEqual([]);
    expect(manager.pull).toHaveBeenCalledTimes(1);
  });
});

describe("resolveConflicts — keep local", () => {
  it("uploads local content, backs up the remote copy, and writes remote meta once", async () => {
    const { manager, vault, state } = setup(manyFiles(8));
    const ids = manager.conflicts.map((c) => c.fileId);
    const result = await manager.resolveConflicts(ids, "local");

    expect(result).toEqual({ resolved: 8, failed: 0 });
    expect(state.contents.get(ids[0])).toBe("local 0");
    expect(state.contents.get(ids[7])).toBe("local 7");
    // One content upload per file, on top of the single metadata write.
    expect(state.countCalls("updateFile") - remoteMetaWrites(state)).toBe(8);

    // The discarded remote content is what gets backed up here.
    expect(backups(vault).map((p) => vault.getFile(p)).sort()).toEqual(
      manyFiles(8).map((f) => f.remote).sort()
    );

    // remoteMeta *is* mutated in this direction, but written only at the end.
    expect(remoteMetaWrites(state)).toBe(1);
  });
});

describe("resolveConflicts — identical content shortcut", () => {
  it("skips the backup and the transfer when the file already matches remote", async () => {
    // Same bytes on both sides: a false conflict from stale metadata.
    const { manager, vault, state } = setup([
      { path: "notes/same.md", local: "identical", remote: "identical" },
    ]);

    const fileId = manager.conflicts[0].fileId;
    const result = await manager.resolveConflicts([fileId], "remote");

    expect(result).toEqual({ resolved: 1, failed: 0 });
    expect(backups(vault)).toHaveLength(0);
    expect(state.countCalls("readFile")).toBe(1); // the metadata document only
    expect(state.countCalls("readFileRaw")).toBe(0);
    expect(remoteMetaWrites(state)).toBe(0);

    // Metadata still adopts the remote entry, so it stops looking like a conflict.
    const meta = readLocalMeta(vault);
    expect(meta.files[fileId].md5Checksum).toBe(md5HashString("identical"));
  });

  it("applies to the keep-local direction too", async () => {
    const { manager, state } = setup([
      { path: "notes/same.md", local: "identical", remote: "identical" },
    ]);

    await manager.resolveConflicts([manager.conflicts[0].fileId], "local");
    expect(state.countCalls("updateFile") - remoteMetaWrites(state)).toBe(0);
    expect(remoteMetaWrites(state)).toBe(0);
  });
});

describe("resolveConflicts — edit/delete conflicts", () => {
  const deleted = { path: "notes/gone.md", local: "local edit", remote: "", editDelete: true };

  it("accepting the delete backs the file up before trashing it", async () => {
    const { manager, vault, state } = setup([deleted]);
    const fileId = manager.conflicts[0].fileId;

    const result = await manager.resolveConflicts([fileId], "remote");

    expect(result).toEqual({ resolved: 1, failed: 0 });
    expect(vault.has("notes/gone.md")).toBe(false);
    expect(vault.trashed).toContain("notes/gone.md");
    expect(backups(vault).map((p) => vault.getFile(p))).toEqual(["local edit"]);

    const meta = readLocalMeta(vault);
    expect(meta.pathToId["notes/gone.md"]).toBeUndefined();
    expect(meta.files[fileId]).toBeUndefined();

    // This direction does mutate remote meta, so it is written exactly once.
    expect(remoteMetaWrites(state)).toBe(1);
  });

  it("keeping the local file re-uploads it under a new Drive id", async () => {
    const { manager, vault, state } = setup([deleted]);
    const oldId = manager.conflicts[0].fileId;

    await manager.resolveConflicts([oldId], "local");

    expect(state.countCalls("createFile")).toBe(1);
    const meta = readLocalMeta(vault);
    const newId = meta.pathToId["notes/gone.md"];
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    expect(vault.getFile("notes/gone.md")).toBe("local edit");
  });

  it("resolves a mixed batch of edit/delete and normal conflicts", async () => {
    const { manager, vault, state } = setup([
      ...manyFiles(3),
      deleted,
      { path: "notes/also-gone.md", local: "another edit", remote: "", editDelete: true },
    ]);

    const result = await manager.resolveConflicts(
      manager.conflicts.map((c) => c.fileId),
      "remote"
    );

    expect(result).toEqual({ resolved: 5, failed: 0 });

    // Normal conflicts took the remote content...
    expect(vault.getFile("notes/f0.md")).toBe("remote 0");
    expect(vault.getFile("notes/f2.md")).toBe("remote 2");
    // ...and the remotely-deleted ones are gone locally, but backed up first.
    expect(vault.has("notes/gone.md")).toBe(false);
    expect(vault.has("notes/also-gone.md")).toBe(false);
    expect(backups(vault).map((p) => vault.getFile(p)).sort()).toEqual(
      ["another edit", "local 0", "local 1", "local 2", "local edit"]
    );

    // Two edit/delete items dirtied the remote meta, so it is written — once.
    expect(remoteMetaWrites(state)).toBe(1);

    const meta = readLocalMeta(vault);
    expect(meta.pathToId["notes/gone.md"]).toBeUndefined();
    expect(meta.pathToId["notes/f0.md"]).toBeDefined();
  });
});

describe("resolveConflicts — failure handling", () => {
  it("keeps conflicts unresolved when metadata persistence fails", async () => {
    const { manager, state } = setup(manyFiles(2));
    const ids = manager.conflicts.map((c) => c.fileId);
    state.failUpdateFileIds.add(META_FILE_ID);

    const result = await manager.resolveConflicts(ids, "local");

    expect(result).toEqual({ resolved: 0, failed: 2 });
    expect(manager.conflicts.map((c) => c.fileId)).toEqual(ids);
    expect(manager.pull).not.toHaveBeenCalled();
  });

  it("merges a concurrent metadata entry before saving the batch", async () => {
    const { manager, state } = setup(manyFiles(1));
    state.onReadFile = (fileId, readCount) => {
      if (fileId !== META_FILE_ID || readCount !== 2) return;
      const meta = JSON.parse(state.contents.get(META_FILE_ID) as string) as SyncMeta;
      meta.files.concurrent = {
        name: "notes/concurrent.md", mimeType: "text/markdown",
        md5Checksum: "external", modifiedTime: "2026-08-11T00:00:00.000Z",
      };
      state.contents.set(META_FILE_ID, JSON.stringify(meta));
    };

    await manager.resolveConflicts(manager.conflicts.map((c) => c.fileId), "local");

    const written = JSON.parse(state.contents.get(META_FILE_ID) as string) as SyncMeta;
    expect(written.files.concurrent?.name).toBe("notes/concurrent.md");
  });

  it("persists the items that succeeded when one file fails", async () => {
    const { manager, vault, state } = setup(manyFiles(6));
    const ids = manager.conflicts.map((c) => c.fileId);
    const doomed = ids[2];
    state.failFileIds.add(doomed);

    const result = await manager.resolveConflicts(ids, "remote");

    expect(result).toEqual({ resolved: 5, failed: 1 });

    // The failed item is the only one still listed, and no pull was triggered.
    expect(manager.conflicts.map((c) => c.fileId)).toEqual([doomed]);
    expect(manager.pull).not.toHaveBeenCalled();

    // Everything that did succeed is on disk *and* recorded in metadata.
    const meta = readLocalMeta(vault);
    for (const id of ids.filter((i) => i !== doomed)) {
      expect(meta.files[id].md5Checksum).toBe(
        md5HashString(state.contents.get(id) as string)
      );
    }
  });

  it("reports unknown file ids as failures without throwing", async () => {
    const { manager } = setup(manyFiles(2));
    const result = await manager.resolveConflicts(
      [...manager.conflicts.map((c) => c.fileId), "does-not-exist"],
      "remote"
    );

    expect(result).toEqual({ resolved: 2, failed: 1 });
  });

  it("refuses to start while another sync holds the lock", async () => {
    const { manager } = setup(manyFiles(2));
    (manager as unknown as { syncLock: boolean }).syncLock = true;

    const result = await manager.resolveConflicts(
      manager.conflicts.map((c) => c.fileId),
      "remote"
    );

    expect(result).toEqual({ resolved: 0, failed: 2 });
    expect(manager.conflicts).toHaveLength(2);
  });

  it("returns immediately for an empty batch", async () => {
    const { manager, state } = setup(manyFiles(2));
    const result = await manager.resolveConflicts([], "remote");

    expect(result).toEqual({ resolved: 0, failed: 0 });
    expect(state.calls).toHaveLength(0);
  });
});

describe("resolveConflicts — cost scales with batch size, not per file", () => {
  it("reads and writes metadata a fixed number of times regardless of N", async () => {
    const counts: number[] = [];
    for (const n of [2, 20]) {
      const { manager, state } = setup(manyFiles(n));
      await manager.resolveConflicts(manager.conflicts.map((c) => c.fileId), "remote");
      counts.push(state.countCalls("findFileByExactName"));
    }

    // One metadata lookup per batch, whether it is 2 files or 20.
    expect(counts).toEqual([1, 1]);
  });
});
