# Tape P0 Review Issues

**Status**: ISSUE 1-12 fixed. ISSUE 13 reclassified as not a bug. ISSUE 14 is a carry-forward of ISSUE 8-9 (now fixed).

## ISSUE-1: tape-file.ts — Incremental read uses string slice with byte offset

**File**: `src/tape/tape-file.ts` line 52
**Severity**: Bug
**Status**: ✅ Fixed
**Description**: `_readOffset` tracks bytes (`Buffer.byteLength`), but the incremental read does `content.slice(this._readOffset)` which slices by character index. For multi-byte UTF-8 characters this will corrupt data.
**Fix**: Use `readFileSync` returning a Buffer, then slice the Buffer by byte offset, then decode to string.

## ISSUE-2: tape-file.ts — Mutex is over-engineered and unnecessary

**File**: `src/tape/tape-file.ts` lines 205-248
**Severity**: Cleanup
**Status**: ✅ Fixed
**Description**: All file operations use synchronous `appendFileSync`/`readFileSync`, so the promise-chain mutex serves no purpose. The `_acquireMutex` implementation is also convoluted and hard to reason about. Remove the mutex entirely — synchronous I/O is inherently serialized in a single-threaded JS runtime.
**Fix**: Deleted `_mutex`, `_mutexResolve`, `_acquireMutex`. Removed mutex acquire/release calls from `_appendInternal` and `reset`.

## ISSUE-3: tape-file.ts — copyTo leaks private fields

**File**: `src/tape/tape-file.ts` lines 173-175
**Severity**: Bug / Encapsulation
**Status**: ✅ Fixed
**Description**: `copyTo` directly assigns `target._readEntries`, `target._readOffset`, `target._nextIdCache` — accessing private fields of another instance. While TypeScript allows this within the same class, it creates tight coupling and bypasses any validation.
**Fix**: After writing entries to the target file, call `target.read()` to let the target build its own internal state naturally.

## ISSUE-4: tape-store.ts — Unused import

**File**: `src/tape/tape-store.ts` line 3
**Severity**: Cleanup
**Status**: ✅ Fixed
**Description**: `basename` is imported from `node:path` but never used.
**Fix**: Removed the unused `basename` import.

## ISSUE-5: tape-store.ts — list() regex doesn't anchor to workspaceHash

**File**: `src/tape/tape-store.ts` line 47
**Severity**: Bug
**Status**: ✅ Fixed
**Description**: The regex `^[^_]+__([^.]+)\.tape\.jsonl$` matches any prefix before `__`, not specifically this store's `workspaceHash`. If multiple workspaces share the same tapesDir, tapes from other workspaces would be included.
**Fix**: Use the actual `workspaceHash` in the regex: `new RegExp(`^${this.workspaceHash}__(.+)\\.tape\\.jsonl$`)` and decode the captured group.

## ISSUE-6: tape-store.ts — list() regex rejects names containing dots

**File**: `src/tape/tape-store.ts` line 47
**Severity**: Bug
**Status**: ✅ Fixed
**Description**: The capture group `[^.]+` won't match tape names that contain dots after URL encoding. Since `encodeURIComponent` produces `%2E` for dots this is technically fine, but the regex also rejects encoded colons `%3A` etc. The capture should be more permissive — match everything between `__` and `.tape.jsonl`.
**Fix**: Use `(.+?)` as the capture group with the suffix anchored: `` `^${this.workspaceHash}__(.+)\\.tape\\.jsonl$` ``

## ISSUE-7: tape-file.test.ts — Uses require() instead of ESM import

**File**: `src/tape/tape-file.test.ts` line 90
**Severity**: Cleanup
**Status**: ✅ Fixed
**Description**: `const { appendFileSync } = require('node:fs')` uses CommonJS require in an ESM project.
**Fix**: Use `import { appendFileSync } from 'node:fs'` at the top of the file.

## ISSUE-8: tape-file.ts — `_isValidEntry` allows `meta: null`

**File**: `src/tape/tape-file.ts` `_isValidEntry` method
**Severity**: Low
**Status**: Fixed
**Description**: `typeof null === 'object'` in JS. The guard checks `typeof e.meta === 'object'` but doesn't exclude null (unlike `payload` which has `e.payload !== null`). A corrupted JSONL line with `"meta": null` would pass validation, violating the `Record<string, unknown>` type.
**Fix**: Add `&& e.meta !== null` to the meta check.

## ISSUE-9: tape-file.ts — Archive timestamp has only minute precision

**File**: `src/tape/tape-file.ts` `archive()` method
**Severity**: Low
**Status**: Fixed
**Description**: `now.toISOString().replace(/[:.]/g, '').slice(0, 15)` produces only minute precision (e.g. `20260227T0856Z`). Two archives within the same minute would silently overwrite each other.
**Fix**: Use `slice(0, 17)` to include seconds: `20260227T085650Z`.

---

# Tape P1 Review Issues

## ISSUE-10: tape-service.test.ts — Type error on appendToolResult call

**File**: `src/tape/tape-service.test.ts` line 136
**Severity**: TS Error (build-breaking)
**Status**: Fixed
**Description**: `service.appendToolResult(['result'])` passes `string[]` but `appendToolResult` expects `Record<string, unknown>[]`. The test also doesn't match the actual `tool_result` payload format where results should be objects or the function should accept `unknown[]`.
**Fix**: Either change `appendToolResult` signature to accept `unknown[]` (since results can be strings — bub does this), or change the test to pass `[{ output: 'result' }]`. Recommendation: change the `results` parameter type in both `createToolResult` and `appendToolResult` to `unknown[]`, since tool results can be strings (as also done in tape-context.ts line 60).

## ISSUE-11: tape-service.test.ts — Unused `restore` variable

**File**: `src/tape/tape-service.test.ts` line 229
**Severity**: TS Warning
**Status**: Fixed
**Description**: `const { forkName, restore } = service.forkTape()` — `restore` is destructured but never used in the fork+merge test.
**Fix**: Use `const { forkName } = service.forkTape()` (omit `restore`).

## ISSUE-12: tape-context.test.ts — Unused TapeMessage import

**File**: `src/tape/tape-context.test.ts` line 2
**Severity**: TS Warning
**Status**: Fixed
**Description**: `type TapeMessage` is imported but never used in the test file.
**Fix**: Remove the `type TapeMessage` from the import: `import { selectMessages } from './tape-context.js';`

## ISSUE-13: tape-service.ts — betweenAnchors uses exclusive end boundary

**File**: `src/tape/tape-service.ts` line 105
**Severity**: Bug
**Status**: Open
**Description**: `e.id > startAnchor.id && e.id < endAnchor.id` uses strict less-than for the end boundary. This means entries at the exact same ID as the end anchor are excluded, but more importantly entries between the end anchor and the next entry after it could be missed. The bub reference uses `e.id <= endAnchor.id` (inclusive end). The current behavior means the end anchor entry itself and any entries with exactly its ID are excluded — this is inconsistent with `afterAnchor` which only excludes the anchor itself.
**Fix**: Change to `e.id < endAnchor.id` is actually fine for excluding the end anchor entry itself. But verify the test at line 154 expects this behavior — it does (2 entries between start and end, not including the anchors themselves). **No change needed**, the behavior is consistent. Reclassify as: **Not a bug**.

## ISSUE-14: tape-file.ts — P0 ISSUE-8 and ISSUE-9 still open

**File**: `src/tape/tape-file.ts`
**Severity**: Low
**Status**: Fixed (via ISSUE-8 and ISSUE-9)
**Description**: Carry-forward from P0 review — `_isValidEntry` allows `meta: null`, and archive timestamp has only minute precision.
**Fix**: Apply fixes from ISSUE-8 and ISSUE-9 in this batch.

---

# Exec Refactor Phase 1-2 Review Issues

## ISSUE-15: config.ts — createSandboxBoundary hardcodes workspaceDir

**File**: `src/runtime/sandbox/config.ts` line 257
**Severity**: Bug
**Status**: ✅ Fixed
**Description**: `createSandboxBoundary` always sets `workspaceDir: "/tmp/sandbox"` — a hardcoded default. But `workspaceDir` is the most security-critical field (`resolveCwd` uses it). `SandboxConfig` doesn't contain `workspaceDir`, so nothing overrides it. Callers would silently get a wrong boundary.
**Fix**: Make `workspaceDir` a required parameter: `createSandboxBoundary(workspaceDir: string, config?, allowlist?)`.

## ISSUE-16: config.ts — DEFAULT_SANDBOX_BOUNDARY is dangerous

**File**: `src/runtime/sandbox/config.ts` lines 267-272
**Severity**: Design
**Status**: ✅ Fixed
**Description**: A default constant with hardcoded `/tmp/sandbox` workspace path is misleading. Anyone using this default gets the wrong boundary without any error.
**Fix**: Remove `DEFAULT_SANDBOX_BOUNDARY` entirely. Boundaries must always be explicitly constructed with the correct `workspaceDir`.

## ISSUE-17: config.ts — buildSafeEnv blocked key comparison not fully case-insensitive

**File**: `src/runtime/sandbox/config.ts` line 80
**Severity**: Bug
**Status**: ✅ Fixed
**Description**: `blockedKeys.includes(upper)` uppercases the *override key* but not the *blockedEnvKeys entries*. If `blockedEnvKeys` contains lowercase values like `["path"]`, the comparison with `"PATH"` fails silently. Original `host-exec.ts` used a pre-uppercased `Set`.
**Fix**: Normalize blockedKeys: `const blockedKeys = (boundary.blockedEnvKeys ?? Array.from(BLOCKED_ENV_KEYS)).map(k => k.toUpperCase())`.

## ISSUE-18: supervisor.ts — waitForExit conflates stdout and stderr

**File**: `src/process/supervisor.ts` lines 161-168
**Severity**: Design
**Status**: ✅ Fixed
**Description**: `ProcessOutcomeWithOutput` has `stdout` and `stderr` fields, but the implementation puts ALL output into `stdout` and always returns `stderr: ""`. The supervisor merges both streams into one `outputBuffer`. For one-shot exec to replace `host-exec.ts` (which separates streams), it needs separate stdout/stderr tracking.
**Fix**: Track stdout and stderr in separate buffers in `spawnProcess`. In the non-PTY path, `childProcess.stdout` and `childProcess.stderr` already fire separate events — collect them separately. Return both in `ProcessOutcomeWithOutput`.

## ISSUE-19: supervisor.ts — waitForExit handle wrapping is fragile

**File**: `src/process/supervisor.ts` lines 143-172
**Severity**: Cleanup
**Status**: ✅ Fixed
**Description**: The `waitForExit` path creates a handle, overwrites its `promise` with a `.then()` chain, then casts `Promise<ProcessOutcomeWithOutput>` to `Promise<ProcessOutcome>`. This hides the actual return type and is fragile. Output collection should be handled at the `spawnProcess` level.
**Fix**: Move output collection into `spawnProcess` — when `waitForExit` is true, the promise should natively resolve to `ProcessOutcomeWithOutput`. Remove the wrapping/override in `start()`.
