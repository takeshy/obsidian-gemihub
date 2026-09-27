import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GemiHubPlugin } from "../src/plugin";
import { DriveSyncUIManager } from "../src/plugin/driveSyncUI";

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock("../src/ui/components/DriveAuthPasswordModal", () => ({
  DriveAuthPasswordModal: class {
    openAndWait = prompt;
  },
}));

function setup(secretId = "gemihub-password") {
  const mgr = {
    isConfigured: true,
    isUnlocked: false,
    unlockWithPassword: vi.fn(async (_password: string) => { mgr.isUnlocked = true; }),
    lock: vi.fn(() => { mgr.isUnlocked = false; }),
  };
  const getSecret = vi.fn<() => string | null>(() => "saved-password");
  const plugin = {
    app: { secretStorage: { getSecret } },
    settings: { driveSync: { passwordSecretId: secretId } },
    driveSyncManager: mgr,
  } as unknown as GemiHubPlugin;
  return { mgr, getSecret, ui: new DriveSyncUIManager(plugin) };
}

beforeEach(() => {
  prompt.mockReset().mockResolvedValue(null);
});

describe("Drive sync Secret Storage unlock", () => {
  it("unlocks with the selected secret without prompting", async () => {
    const { ui, mgr, getSecret } = setup();
    await ui.promptDriveSyncUnlock();
    expect(getSecret).toHaveBeenCalledWith("gemihub-password");
    expect(mgr.unlockWithPassword).toHaveBeenCalledWith("saved-password");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("uses manual entry when no secret is selected", async () => {
    const { ui, mgr, getSecret } = setup("");
    prompt.mockResolvedValueOnce("manual-password");
    await ui.promptDriveSyncUnlock();
    expect(getSecret).not.toHaveBeenCalled();
    expect(mgr.unlockWithPassword).toHaveBeenCalledWith("manual-password");
  });

  it("prompts when the selected secret is missing and allows cancellation", async () => {
    const { ui, mgr, getSecret } = setup();
    getSecret.mockReturnValue(null);
    await ui.promptDriveSyncUnlock();
    expect(prompt).toHaveBeenCalledOnce();
    expect(mgr.unlockWithPassword).not.toHaveBeenCalled();
  });

  it("falls back to manual entry after a failed automatic unlock", async () => {
    const { ui, mgr } = setup();
    mgr.unlockWithPassword.mockImplementationOnce(async () => {
      mgr.isUnlocked = true;
      throw new Error("Unlock failed after obtaining tokens");
    });
    prompt.mockResolvedValueOnce("corrected-password");
    await ui.promptDriveSyncUnlock();
    expect(mgr.lock).toHaveBeenCalledOnce();
    expect(mgr.unlockWithPassword.mock.calls).toEqual([["saved-password"], ["corrected-password"]]);
    expect(mgr.isUnlocked).toBe(true);
  });

  it("falls back if Secret Storage cannot be read", async () => {
    const { ui, getSecret } = setup();
    getSecret.mockImplementation(() => { throw new Error("Storage unavailable"); });
    await ui.promptDriveSyncUnlock();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("shares an in-progress unlock between concurrent callers", async () => {
    const { ui, mgr } = setup();
    await Promise.all([ui.promptDriveSyncUnlock(), ui.promptDriveSyncUnlock()]);
    expect(mgr.unlockWithPassword).toHaveBeenCalledOnce();
  });

  it("does not read credentials while disabled or already unlocked", async () => {
    const { ui, mgr, getSecret } = setup();
    mgr.isConfigured = false;
    await ui.promptDriveSyncUnlock();
    mgr.isConfigured = true;
    mgr.isUnlocked = true;
    await ui.promptDriveSyncUnlock();
    expect(getSecret).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});
