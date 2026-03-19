// File search / RAG manager for Drive sync integration.
// Ported from current_master — uses @google/genai File Search API.

import { GoogleGenAI } from "@google/genai";
import type { TFile, App } from "obsidian";

// Supported file extensions for RAG upload
const SUPPORTED_EXTENSIONS = new Set([
  "md", "pdf", "doc", "docx", "xls", "xlsx", "pptx",
]);

function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    md: "text/markdown",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return mimeTypes[extension.toLowerCase()] || "application/octet-stream";
}

export function isSupportedFile(file: TFile): boolean {
  return SUPPORTED_EXTENSIONS.has(file.extension.toLowerCase());
}

export interface FilterConfig {
  includeFolders: string[];
  excludePatterns: string[];
}

export function shouldIncludeFile(filePath: string, config: FilterConfig): boolean {
  if (config.includeFolders.length > 0) {
    let isInIncludedFolder = false;
    for (const folder of config.includeFolders) {
      const normalizedFolder = folder.replace(/\/$/, "");
      if (
        filePath.startsWith(normalizedFolder + "/") ||
        filePath === normalizedFolder
      ) {
        isInIncludedFolder = true;
        break;
      }
    }
    if (!isInIncludedFolder) return false;
  }

  for (const pattern of config.excludePatterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    try {
      const regex = new RegExp(trimmed);
      if (regex.test(filePath)) return false;
    } catch {
      // Invalid regex pattern, skip
    }
  }

  return true;
}

// ========================================
// FileSearchManager
// ========================================

export class FileSearchManager {
  private ai: GoogleGenAI;
  private app: App;

  constructor(apiKey: string, app: App) {
    this.ai = new GoogleGenAI({ apiKey });
    this.app = app;
  }

  // ---- File I/O ----

  private isBinaryFile(file: TFile): boolean {
    const binaryExtensions = ["pdf", "doc", "docx", "xls", "xlsx", "pptx"];
    return binaryExtensions.includes(file.extension.toLowerCase());
  }

  async readFileContent(file: TFile): Promise<string | ArrayBuffer> {
    if (this.isBinaryFile(file)) {
      return await this.app.vault.readBinary(file);
    }
    return await this.app.vault.read(file);
  }

  // ---- Checksum ----

  private async calculateChecksum(content: string | ArrayBuffer): Promise<string> {
    let data: BufferSource;
    if (typeof content === "string") {
      data = new TextEncoder().encode(content);
    } else {
      data = content;
    }
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async getChecksumForFile(file: TFile): Promise<{ content: string | ArrayBuffer; checksum: string }> {
    const content = await this.readFileContent(file);
    const checksum = await this.calculateChecksum(content);
    return { content, checksum };
  }

  // ---- Upload / Delete (for specific store) ----

  async uploadFileToStore(file: TFile, storeId: string): Promise<string | null> {
    const content = await this.readFileContent(file);
    const mimeType = getMimeType(file.extension);
    const blob = new Blob([content], { type: mimeType });

    const operation = await this.ai.fileSearchStores.uploadToFileSearchStore({
      file: blob,
      fileSearchStoreName: storeId,
      config: {
        displayName: file.path,
      },
    });

    return operation?.name ?? null;
  }

  async deleteFileFromStoreById(displayName: string, storeId: string): Promise<void> {
    try {
      const pager = await this.ai.fileSearchStores.documents.list({
        parent: storeId,
        config: { pageSize: 20 },
      });

      for await (const doc of pager) {
        if (doc.displayName === displayName && doc.name) {
          await this.ai.fileSearchStores.documents.delete({
            name: doc.name,
            config: { force: true },
          });
          return;
        }
      }
    } catch {
      // File deletion might not be supported or file already deleted
    }
  }
}

// ========================================
// Singleton
// ========================================

let fileSearchManagerInstance: FileSearchManager | null = null;

export function getFileSearchManager(): FileSearchManager | null {
  return fileSearchManagerInstance;
}

export function initFileSearchManager(apiKey: string, app: App): FileSearchManager {
  fileSearchManagerInstance = new FileSearchManager(apiKey, app);
  return fileSearchManagerInstance;
}

export function resetFileSearchManager(): void {
  fileSearchManagerInstance = null;
}
