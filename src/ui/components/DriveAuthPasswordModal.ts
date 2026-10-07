// Password prompt modal for Google Drive sync session unlock.

import { Modal, App, Setting } from "obsidian";
import { t } from "src/i18n";

export interface DriveAuthPasswordResult {
  password: string;
  savePassword: boolean;
}

export class DriveAuthPasswordModal extends Modal {
  private password = "";
  private savePassword = true;
  private resolve: ((result: DriveAuthPasswordResult | null) => void) | null = null;

  constructor(app: App) {
    super(app);
  }

  /**
   * Open the modal and return the password and storage preference, or null if cancelled.
   */
  openAndWait(): Promise<DriveAuthPasswordResult | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: t("driveSync.unlockTitle") });
    contentEl.createEl("p", {
      text: t("driveSync.unlockDesc"),
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName(t("driveSync.password"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.placeholder = t("driveSync.passwordPlaceholder");
        text.onChange((value) => {
          this.password = value;
        });
        // Submit on Enter
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && this.password) {
            this.submit();
          }
        });
        // Focus the input
        setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .setName(t("driveSync.savePassword"))
      .setDesc(t("driveSync.savePasswordDesc"))
      .addToggle((toggle) => toggle
        .setValue(this.savePassword)
        .onChange((value) => { this.savePassword = value; }));

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(t("driveSync.unlock"))
          .setCta()
          .onClick(() => {
            this.submit();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("driveSync.skip"))
          .onClick(() => {
            const resolve = this.resolve;
            this.resolve = null;
            this.close();
            resolve?.(null);
          })
      );
  }

  private submit(): void {
    if (!this.password) return;
    const result = { password: this.password, savePassword: this.savePassword };
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(result);
  }

  onClose(): void {
    // If closed without resolving (e.g., clicking X), treat as skip
    if (this.resolve) {
      this.resolve(null);
      this.resolve = null;
    }
    this.password = "";
    this.contentEl.empty();
  }
}
