import type { GemiHubPlugin } from "src/plugin";

export interface SettingsContext {
  plugin: GemiHubPlugin;
  display: () => void;
}
