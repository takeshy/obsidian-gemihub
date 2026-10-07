import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

vi.mock("../src/core/googleDrive", async () => {
  const { createFakeDrive } = await import("./helpers/fakeDrive");
  return createFakeDrive();
});
vi.mock("../src/core/googleDriveAuth", () => ({
  getValidSessionTokens: vi.fn(async (tokens: unknown) => tokens),
}));

import * as drive from "../src/core/googleDrive";
import { DriveSyncManager } from "../src/core/driveSync";
import { getLocalMetaPath, type LocalDriveSyncMeta } from "../src/core/driveSyncMeta";
import { md5HashString } from "../src/core/driveSyncUtils";
import { FakeVault, createFakeApp } from "./helpers/fakeVault";
import type { createFakeDrive } from "./helpers/fakeDrive";

const fake = drive as unknown as ReturnType<typeof createFakeDrive>;

function setup(localPath?: string, content = "local edit") {
  const vault = new FakeVault();
  if (localPath) vault.setFile(localPath, content);
  const remote = fake.__put("notes/original.md", "Drive content", "file-1");
  remote.md5Checksum = md5HashString("Drive content");
  const meta: LocalDriveSyncMeta = {
    lastUpdatedAt: "", pathToId: { "notes/original.md": remote.id },
    files: { [remote.id]: { name: remote.name, md5Checksum: "old", modifiedTime: "" } },
  };
  vault.setFile(getLocalMetaPath(), JSON.stringify(meta));
  const plugin = { settings: { driveSync: { enabled: true, excludePatterns: [] } } };
  const manager = new DriveSyncManager(createFakeApp(vault) as unknown as App, plugin as never);
  (manager as unknown as { sessionTokens: unknown }).sessionTokens = { accessToken: "token", rootFolderId: "root" };
  vi.spyOn(manager, "refreshSyncCounts").mockResolvedValue();
  return { manager, vault, meta };
}

beforeEach(() => {
  fake.__state.files.clear();
  fake.__state.contents.clear();
  fake.__state.failFileIds.clear();
  fake.__state.reset();
});

describe("restore push-preview changes", () => {
  it.each(["modified", "deleted"] as const)("restores a %s file and its checksum", async type => {
    const { manager, vault } = setup(type === "modified" ? "notes/original.md" : undefined);
    await manager.restoreLocalChange({ id: "file-1", name: "notes/original.md", type });
    expect(vault.getFile("notes/original.md")).toBe("Drive content");
    const meta = JSON.parse(vault.getFile(getLocalMetaPath())!) as LocalDriveSyncMeta;
    expect(meta.files["file-1"].md5Checksum).toBe(md5HashString("Drive content"));
    expect(meta.files["file-1"].localMtime).toBeDefined();
    expect(fake.__state.countCalls("updateFile")).toBe(0);
  });

  it("restores a renamed file to the Drive path and clears stale mappings", async () => {
    const { manager, vault } = setup("notes/renamed.md");
    await manager.restoreLocalChange({ id: "file-1", name: "notes/renamed.md", oldName: "notes/original.md", type: "renamed" });
    expect(vault.has("notes/renamed.md")).toBe(false);
    expect(vault.getFile("notes/original.md")).toBe("Drive content");
    const meta = JSON.parse(vault.getFile(getLocalMetaPath())!) as LocalDriveSyncMeta;
    expect(meta.pathToId).toEqual({ "notes/original.md": "file-1" });
  });

  it("discards a new local file without deleting anything on Drive", async () => {
    const { manager, vault } = setup("notes/new.md");
    await manager.restoreLocalChange({ id: "notes/new.md", name: "notes/new.md", type: "new" });
    expect(vault.has("notes/new.md")).toBe(false);
    expect(vault.trashed).toEqual(["notes/new.md"]);
    expect(fake.__state.countCalls("deleteFile")).toBe(0);
  });

  it("retains a renamed file when the remote download fails", async () => {
    const { manager, vault } = setup("notes/renamed.md");
    fake.__state.failFileIds.add("file-1");
    await expect(manager.restoreLocalChange({ id: "file-1", name: "notes/renamed.md", type: "renamed" })).rejects.toThrow();
    expect(vault.getFile("notes/renamed.md")).toBe("local edit");
    fake.__state.failFileIds.clear();
    await manager.restoreLocalChange({ id: "file-1", name: "notes/renamed.md", type: "renamed" });
    expect(vault.getFile("notes/original.md")).toBe("Drive content");
  });

  it("refuses to overwrite an occupied rename target", async () => {
    const { manager, vault } = setup("notes/renamed.md");
    vault.setFile("notes/original.md", "another file");
    await expect(manager.restoreLocalChange({ id: "file-1", name: "notes/renamed.md", type: "renamed" })).rejects.toThrow("another local file");
    expect(vault.getFile("notes/original.md")).toBe("another file");
    expect(vault.has("notes/renamed.md")).toBe(true);
  });

  it("refuses to discard a new file that has appeared on Drive", async () => {
    const { manager, vault } = setup("notes/new.md");
    fake.__put("notes/new.md", "synced");
    await expect(manager.restoreLocalChange({ id: "notes/new.md", name: "notes/new.md", type: "new" })).rejects.toThrow("Refresh");
    expect(vault.has("notes/new.md")).toBe(true);
  });

  it("restores binary content", async () => {
    const { manager, vault } = setup("image.png");
    const remote = fake.__state.files.get("file-1")!;
    remote.name = "image.png";
    fake.__state.contents.set("file-1", new TextEncoder().encode("binary bytes").buffer);
    await manager.restoreLocalChange({ id: "file-1", name: "image.png", type: "modified" });
    expect(vault.getFile("image.png")).toBe("binary bytes");
    expect(fake.__state.countCalls("readFileRaw")).toBe(1);
  });
});
