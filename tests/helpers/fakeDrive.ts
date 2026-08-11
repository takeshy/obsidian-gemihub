// In-memory stand-in for src/core/googleDrive.
//
// Every call is recorded so tests can assert on the number and shape of Drive
// round trips — the thing bulk conflict resolution is supposed to minimise.

import type { DriveFile } from "../../src/core/googleDrive";

export interface DriveCallLog {
  fn: string;
  args: unknown[];
}

export interface FakeDriveState {
  /** fileId -> Drive file record. */
  files: Map<string, DriveFile>;
  /** fileId -> content. */
  contents: Map<string, string | ArrayBuffer>;
  /** Every call made, in order. */
  calls: DriveCallLog[];
  /** fileIds whose next read/update should throw, to simulate failures. */
  failFileIds: Set<string>;
  failUpdateFileIds: Set<string>;
  onReadFile?: (fileId: string, readCount: number) => void;
  /** Highest number of in-flight calls seen, to prove batching happens. */
  maxConcurrent: number;
  nextId: number;
  countCalls(fn: string): number;
  reset(): void;
}

function md5Placeholder(content: string | ArrayBuffer): string {
  // Tests that care about real checksums compute them with md5HashString and
  // seed them explicitly; this only needs to be stable and content-derived.
  const text = typeof content === "string" ? content : `bin:${content.byteLength}`;
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return `md5-${(hash >>> 0).toString(16)}`;
}

export function createFakeDrive() {
  const state: FakeDriveState = {
    files: new Map(),
    contents: new Map(),
    calls: [],
    failFileIds: new Set(),
    failUpdateFileIds: new Set(),
    maxConcurrent: 0,
    nextId: 1,
    countCalls: (fn: string) => state.calls.filter((c) => c.fn === fn).length,
    reset: () => {
      state.calls.length = 0;
      state.maxConcurrent = 0;
    },
  };

  let inFlight = 0;

  /** Wrap a fake so it records the call and observes real concurrency. */
  function track<A extends unknown[], R>(
    fn: string,
    impl: (...args: A) => R | Promise<R>
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      state.calls.push({ fn, args });
      inFlight++;
      state.maxConcurrent = Math.max(state.maxConcurrent, inFlight);
      try {
        // Yield twice so genuinely parallel callers overlap here.
        await Promise.resolve();
        await Promise.resolve();
        return await impl(...args);
      } finally {
        inFlight--;
      }
    };
  }

  function put(name: string, content: string | ArrayBuffer, id?: string): DriveFile {
    const fileId = id ?? `file-${state.nextId++}`;
    const file: DriveFile = {
      id: fileId,
      name,
      mimeType: "text/markdown",
      modifiedTime: new Date(2026, 0, 1).toISOString(),
      md5Checksum: md5Placeholder(content),
    };
    state.files.set(fileId, file);
    state.contents.set(fileId, content);
    return file;
  }

  function requireFile(fileId: string): DriveFile {
    if (state.failFileIds.has(fileId)) throw new Error(`Simulated Drive failure for ${fileId}`);
    const file = state.files.get(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    return file;
  }

  return {
    // Exposed to tests; not part of the real module's surface.
    __state: state,
    __put: put,

    ensureRootFolder: track("ensureRootFolder", () => "root"),
    ensureSubFolder: track("ensureSubFolder", (_t: string, _p: string, name: string) => `folder-${name}`),
    ensureFolderPath: track("ensureFolderPath", () => "folder-path"),
    listFiles: track("listFiles", () => [...state.files.values()]),
    listUserFiles: track("listUserFiles", () => [...state.files.values()]),

    readFile: track("readFile", (_t: string, fileId: string) => {
      const fileReadCount = state.calls.filter((call) => call.fn === "readFile" && call.args[1] === fileId).length;
      state.onReadFile?.(fileId, fileReadCount);
      requireFile(fileId);
      const content = state.contents.get(fileId);
      return typeof content === "string" ? content : new TextDecoder().decode(new Uint8Array(content!));
    }),

    readFileRaw: track("readFileRaw", (_t: string, fileId: string) => {
      requireFile(fileId);
      const content = state.contents.get(fileId);
      return typeof content === "string"
        ? (new TextEncoder().encode(content).buffer as ArrayBuffer)
        : content!;
    }),

    getFileMetadata: track("getFileMetadata", (_t: string, fileId: string) => requireFile(fileId)),

    createFile: track("createFile", (_t: string, name: string, content: string) => put(name, content)),
    createFileBinary: track("createFileBinary", (_t: string, name: string, content: ArrayBuffer) =>
      put(name, content)
    ),

    updateFile: track("updateFile", (_t: string, fileId: string, content: string) => {
      if (state.failUpdateFileIds.has(fileId)) throw new Error(`Simulated Drive update failure for ${fileId}`);
      const file = requireFile(fileId);
      state.contents.set(fileId, content);
      const updated: DriveFile = {
        ...file,
        md5Checksum: md5Placeholder(content),
        modifiedTime: new Date(2026, 5, 1).toISOString(),
      };
      state.files.set(fileId, updated);
      return updated;
    }),

    updateFileBinary: track("updateFileBinary", (_t: string, fileId: string, content: ArrayBuffer) => {
      const file = requireFile(fileId);
      state.contents.set(fileId, content);
      const updated: DriveFile = { ...file, md5Checksum: md5Placeholder(content) };
      state.files.set(fileId, updated);
      return updated;
    }),

    moveFile: track("moveFile", () => undefined),
    renameFile: track("renameFile", () => undefined),
    deleteFile: track("deleteFile", (_t: string, fileId: string) => {
      state.files.delete(fileId);
      state.contents.delete(fileId);
    }),

    findFileByExactName: track("findFileByExactName", (_t: string, name: string) => {
      for (const file of state.files.values()) if (file.name === name) return file;
      return null;
    }),

    listFolders: track("listFolders", () => []),
  };
}
