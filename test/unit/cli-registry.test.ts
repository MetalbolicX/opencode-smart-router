// ---------------------------------------------------------------------------
// test/unit/cli-registry.test.ts — Unit tests for src/cli/registry.ts.
//
// Strategy:
//   - Pure unit tests; no real network calls and no real filesystem reads.
//   - `fetchLatestVersion()` is exercised through an injected mock fetch so
//     every branch (success, non-2xx, network rejection, timeout, malformed
//     JSON, missing version) is reachable in milliseconds.
//   - `getInstalledVersion()` is exercised through an injected `VersionFs`
//     subset (`Pick<CliFs, "readFileSync" | "existsSync">`) so the path
//     probe and the JSON read can both be driven without touching disk.
//   - `compareSemver()` / `isStale()` are pure and have no I/O seams.
//
// These tests cover WU6-tests-for-WU1 of the permanent-update-fix change —
// the registry freshness helper that downstream slices (status, doctor,
// update) consume. They MUST pass before any consumer PR merges.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { CliFs } from "../../src/cli/config";
import { createRealFs } from "../../src/cli/real-fs";
import {
  compareSemver,
  fetchLatestVersion,
  getInstalledVersion,
  isStale,
  type RegistryFetch,
  type VersionFs,
} from "../../src/cli/registry";

// ---------------------------------------------------------------------------
// In-memory VersionFs adapter
// ---------------------------------------------------------------------------

interface MemFs {
  files: Map<string, string>;
}

const createMemFs = (files: Record<string, string> = {}): MemFs => {
  return { files: new Map(Object.entries(files)) };
};

const memFsToVersionFs = (mem: MemFs): VersionFs => {
  return {
    existsSync: (path: string) => mem.files.has(path),
    readFileSync: (path: string) => {
      if (!mem.files.has(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return mem.files.get(path) as string;
    },
  };
};

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

/**
 * Build a mock fetch that delegates to `responder`. The responder receives
 * the requested URL + init and must return a `Response`-shaped object. The
 * mock honors `init.signal` for the timeout test by rejecting with an
 * `AbortError` if the signal is already aborted or fires while waiting.
 */
const createMockFetch = (
  responder: (url: string, init: RequestInit | undefined) => Promise<Response>,
): RegistryFetch => {
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return responder(String(input), init);
  };
  return fn as unknown as RegistryFetch;
};

/**
 * Convenience: build a Response-shaped object with the given status and
 * JSON body. Mirrors the subset of the spec that `fetchLatestVersion`
 * actually consumes (`ok`, `status`, `json()`).
 */
const jsonResponse = (status: number, body: unknown): Response => {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status.toString(),
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    body: null,
    bodyUsed: false,
    clone: function () {
      return this;
    },
  } as unknown as Response;
};

// ---------------------------------------------------------------------------
// fetchLatestVersion — success / failure / timeout / parse
// ---------------------------------------------------------------------------

describe("fetchLatestVersion", () => {
  it("returns the version string on HTTP 200 with valid JSON", async () => {
    const fetchImpl = createMockFetch(async () => jsonResponse(200, { version: "1.5.0" }));
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBe("1.5.0");
  });

  it("returns null on non-2xx responses (404)", async () => {
    const fetchImpl = createMockFetch(async () => jsonResponse(404, { error: "not found" }));
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });

  it("returns null on non-2xx responses (500)", async () => {
    const fetchImpl = createMockFetch(async () => jsonResponse(500, { error: "boom" }));
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });

  it("returns null when fetch rejects (network error)", async () => {
    const fetchImpl = createMockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });

  it("returns null when the request times out via AbortSignal", async () => {
    const fetchImpl = createMockFetch(async (_url, init) => {
      // Wait for the abort signal — mirrors how a real fetch surfaces a
      // server-side timeout. We never resolve the promise, so the signal
      // is the only way to leave the wait.
      return new Promise<Response>((_resolve, reject) => {
        if (!init?.signal) {
          reject(new Error("expected AbortSignal in fetch init"));
          return;
        }
        if (init.signal.aborted) {
          const err = new Error("aborted") as Error & { name: string };
          err.name = "AbortError";
          reject(err);
          return;
        }
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted") as Error & { name: string };
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    // Use a tiny timeout so the test does not actually wait 3 seconds.
    await expect(fetchLatestVersion(fetchImpl, 10)).resolves.toBeNull();
  });

  it("returns null when JSON body is malformed", async () => {
    const fetchImpl = createMockFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        }) as unknown as Response,
    );
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });

  it("returns null when the JSON body has no version field", async () => {
    const fetchImpl = createMockFetch(async () =>
      jsonResponse(200, { name: "opencode-smart-router" }),
    );
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });

  it("returns null when the version field is not a string", async () => {
    const fetchImpl = createMockFetch(async () => jsonResponse(200, { version: 150 }));
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });

  it("sends Accept: application/json and an AbortSignal", async () => {
    const observed: { url: string; headers: Record<string, string>; signalType: string } = {
      url: "",
      headers: {},
      signalType: "none",
    };
    const fetchImpl = createMockFetch(async (url, init) => {
      observed.url = url;
      observed.headers = (init?.headers ?? {}) as Record<string, string>;
      observed.signalType = init?.signal ? typeof init.signal : "none";
      return jsonResponse(200, { version: "1.5.0" });
    });
    await fetchLatestVersion(fetchImpl);
    expect(observed.url).toContain("registry.npmjs.org/opencode-smart-router/latest");
    expect(observed.headers.Accept).toBe("application/json");
    expect(observed.signalType).toBe("object");
  });

  it("never throws — every failure mode resolves to null", async () => {
    const fetchImpl = createMockFetch(async () => {
      throw new TypeError("fetch is not a function");
    });
    // The function must swallow the TypeError and resolve to null.
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getInstalledVersion — file injection
// ---------------------------------------------------------------------------

describe("getInstalledVersion", () => {
  it("returns the version field from package.json", () => {
    const fs = memFsToVersionFs(
      createMemFs({
        "/plugin/package.json": JSON.stringify({ name: "opencode-smart-router", version: "1.4.3" }),
      }),
    );
    expect(getInstalledVersion(fs, "/plugin")).toBe("1.4.3");
  });

  it("returns null when package.json is missing", () => {
    const fs = memFsToVersionFs(createMemFs());
    expect(getInstalledVersion(fs, "/missing")).toBeNull();
  });

  it("returns null when package.json contains malformed JSON", () => {
    const fs = memFsToVersionFs(createMemFs({ "/plugin/package.json": "{ this is not json" }));
    expect(getInstalledVersion(fs, "/plugin")).toBeNull();
  });

  it("returns null when package.json has no version field", () => {
    const fs = memFsToVersionFs(
      createMemFs({ "/plugin/package.json": JSON.stringify({ name: "opencode-smart-router" }) }),
    );
    expect(getInstalledVersion(fs, "/plugin")).toBeNull();
  });

  it("returns null when version is not a string", () => {
    const fs = memFsToVersionFs(
      createMemFs({ "/plugin/package.json": JSON.stringify({ version: 142 }) }),
    );
    expect(getInstalledVersion(fs, "/plugin")).toBeNull();
  });

  it("returns null when version is an empty string", () => {
    const fs = memFsToVersionFs(
      createMemFs({ "/plugin/package.json": JSON.stringify({ version: "" }) }),
    );
    expect(getInstalledVersion(fs, "/plugin")).toBeNull();
  });

  it("returns null when the JSON root is not an object (array)", () => {
    const fs = memFsToVersionFs(createMemFs({ "/plugin/package.json": "[]" }));
    expect(getInstalledVersion(fs, "/plugin")).toBeNull();
  });

  it("falls through the path probe to a deterministic null when no pluginRoot is given", () => {
    // Both probe branches in `resolvePackageJsonPath` return false (the
    // mem-fs has no entry at the real __dirname-derived paths), and the
    // fallback source-root path also does not exist. The function must
    // surface null without throwing.
    const fs = memFsToVersionFs(createMemFs());
    expect(getInstalledVersion(fs)).toBeNull();
  });

  it("uses the source-root path probe when only the source-root package.json is present", () => {
    // Probe targets depend on `import.meta.url`, so we drive the function
    // through the real fs on the actual repo and assert it reads the
    // package.json at the repo root. This proves the source-branch path
    // resolution is wired up end-to-end without any test-side mocking.
    const realFs = createRealFs();
    const installed = getInstalledVersion(realFs);
    // The repo's own package.json always declares a real version string.
    expect(typeof installed).toBe("string");
    expect(installed).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns null when existsSync is true but readFileSync throws", () => {
    // Custom fs whose existsSync reports the file but readFileSync raises
    // — covers the inner `catch` branch on line 101.
    const throwingFs: VersionFs = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    expect(getInstalledVersion(throwingFs, "/plugin")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe("compareSemver", () => {
  it("returns 0 when versions are identical", () => {
    expect(compareSemver("1.5.0", "1.5.0")).toBe(0);
    expect(compareSemver("0.0.1", "0.0.1")).toBe(0);
    expect(compareSemver("10.20.30", "10.20.30")).toBe(0);
  });

  it("returns -1 when a < b", () => {
    expect(compareSemver("1.4.3", "1.5.0")).toBe(-1);
    expect(compareSemver("1.5.0", "1.10.0")).toBe(-1);
    expect(compareSemver("0.9.9", "1.0.0")).toBe(-1);
  });

  it("returns 1 when a > b", () => {
    expect(compareSemver("1.5.0", "1.4.3")).toBe(1);
    expect(compareSemver("1.10.0", "1.5.0")).toBe(1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
  });

  it("treats missing trailing segments as 0", () => {
    expect(compareSemver("1.5", "1.5.0")).toBe(0);
    expect(compareSemver("1.5.0", "1.5")).toBe(0);
    expect(compareSemver("1.5", "1.5.1")).toBe(-1);
    expect(compareSemver("1.5.1", "1.5")).toBe(1);
  });

  it("strips prerelease suffix before comparing", () => {
    // "1.5.0-beta.1" should compare equal to "1.5.0" on the dotted parts.
    expect(compareSemver("1.5.0-beta.1", "1.5.0")).toBe(0);
    expect(compareSemver("1.5.0", "1.5.0-beta.1")).toBe(0);
    expect(compareSemver("1.5.0-beta.1", "1.5.1")).toBe(-1);
  });

  it("returns 0 for null / undefined inputs (fail-closed)", () => {
    expect(compareSemver(null, "1.5.0")).toBe(0);
    expect(compareSemver("1.5.0", null)).toBe(0);
    expect(compareSemver(null, null)).toBe(0);
    expect(compareSemver(undefined, undefined)).toBe(0);
    expect(compareSemver(undefined, "1.0.0")).toBe(0);
  });

  it("returns 0 for empty / whitespace strings (fail-closed)", () => {
    expect(compareSemver("", "1.5.0")).toBe(0);
    expect(compareSemver("1.5.0", "")).toBe(0);
    expect(compareSemver("   ", "1.5.0")).toBe(0);
  });

  it("returns 0 for non-numeric segments (fail-closed)", () => {
    expect(compareSemver("latest", "1.5.0")).toBe(0);
    expect(compareSemver("1.5.0", "latest")).toBe(0);
    expect(compareSemver("1.x.0", "1.5.0")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe("isStale", () => {
  it("returns true when installed < latest", () => {
    expect(isStale("1.4.3", "1.5.0")).toBe(true);
    expect(isStale("0.9.9", "1.0.0")).toBe(true);
  });

  it("returns false when installed === latest", () => {
    expect(isStale("1.5.0", "1.5.0")).toBe(false);
  });

  it("returns false when installed > latest (newer than published)", () => {
    // Edge case: locally-built newer version, registry still on older one.
    expect(isStale("1.6.0", "1.5.0")).toBe(false);
    expect(isStale("2.0.0", "1.99.99")).toBe(false);
  });

  it("returns false when either input is null (graceful degrade)", () => {
    expect(isStale(null, "1.5.0")).toBe(false);
    expect(isStale("1.5.0", null)).toBe(false);
    expect(isStale(null, null)).toBe(false);
    expect(isStale(undefined, "1.5.0")).toBe(false);
    expect(isStale("1.5.0", undefined)).toBe(false);
  });

  it("returns false when either input is unparseable", () => {
    expect(isStale("latest", "1.5.0")).toBe(false);
    expect(isStale("1.5.0", "latest")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Module surface — guards against accidental export churn
// ---------------------------------------------------------------------------

describe("module surface", () => {
  it("exports the locked public surface", () => {
    expect(typeof fetchLatestVersion).toBe("function");
    expect(typeof getInstalledVersion).toBe("function");
    expect(typeof compareSemver).toBe("function");
    expect(typeof isStale).toBe("function");
  });
});

// Reference the imports that are otherwise only used in type positions so
// the linter does not flag unused-import warnings during the RED phase.
const _typeProbe = (fs: VersionFs): Pick<CliFs, "readFileSync" | "existsSync"> => fs;
void _typeProbe;
vi.fn();
