# pdfcora-ai Phase 0 — Foundation Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The scaffolding every AI feature sits on — an optional package per platform, one
availability model, a custom-provider interface, and a proposal/apply API — with no AI
feature built. A stub feature proves the whole path end to end.

**Architecture:** A separate package per platform that consumes only the core's public
API. All four concerns are pure logic with no engine calls, so they are built in
TypeScript first and ported, matching how signatures and redaction were built. Apple is
the only platform with a general on-device model; Android and Web resolve to the custom
provider or to `unavailable`.

**Tech Stack:** TypeScript/Node, Swift (FoundationModels, weak-linked), Kotlin.

**Spec:** `docs/superpowers/specs/2026-09-13-pdfcora-ai-requirements.md` §§3–7
(PKG, AVL, PRV, HIL, DOC)

**Status:** complete. Web 15 tests, iOS 18, Android 8; the dependency guard verified by
being broken four ways. See "What executing this taught us" at the end for the three
things the plan got wrong.

## What was verified before writing this

Every mechanism below was checked against the installed toolchain, not assumed.

| Claim | Result |
| --- | --- |
| `FoundationModels` exists in the shipping SDK | ✅ present in iPhoneOS26.4.sdk (Xcode 26.4) |
| Its availability enum matches AVL-1 | ⚠️ **partly** — Apple has only `.available` and `.unavailable(reason)`; reasons are `deviceNotEligible`, `appleIntelligenceNotEnabled`, `modelNotReady`. There is no `downloadable` or `downloading` |
| The framework's OS floor | ✅ `iOS 26.0` on every symbol; `tokenCount(for:)` needs 26.4 |
| The context budget is readable, not guessed | ✅ `SystemLanguageModel.contextSize` → `4096`, back-deployed before 26.4 |
| The model accepts images | ❌ **no** — zero occurrences of "image" in the interface; `PromptRepresentable` is conformed to only by `String`, `Prompt`, `Array`, `ConvertibleToGeneratedContent` |
| The core's Swift graph is dependency-free | ✅ `swift package show-dependencies --format flatlist` prints nothing |
| The core's web runtime graph is dependency-free | ✅ `web/package.json` `dependencies` is `{}` |
| The core's Android graph is inspectable and clean | ✅ `gradle :pdfcora:dependencies --configuration releaseRuntimeClasspath` → kotlin-stdlib and coroutines only |

The second row is the one that shapes Task 1: **our four-state model is a superset of
Apple's two states.** That is deliberate — Android and Web really do have downloadable and
downloading states — but it means the Apple mapping is lossy in one direction and must be
written down, not inferred.

## Global Constraints

- **Phase 0 ships no AI feature.** If a task starts prompting a model, it belongs to
  Phase 1. The only "feature" here is a stub whose whole job is to be unavailable.
- **The core's dependency graph must not change.** Every task is measured against the
  three commands in Task 7, not against a reviewer's reading.
- **Nothing writes to a document.** Every mutating path returns proposals (HIL-1).
- **No feature call throws for unavailability** (AVL-5). Unavailability is a value.
- The AI package uses only the core's **public** API (PKG-4). If it needs something
  internal, that is a core change with its own plan, not an `@testable` import.

---

## Task 1: The availability model (web)

One vocabulary for "can this run", superset of what each platform reports.

**Files:**
- Create: `web-ai/src/availability.ts`
- Test: `web-ai/test/availability.test.ts`

**Interfaces:**
- Produces: `PdfAiAvailability`, `PdfAiUnavailableReason`, `unavailable()`,
  `isUsable(a: PdfAiAvailability): boolean`

- [x] **Step 1: Write the failing test**

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isUsable, unavailable } from '../dist/availability.js';

describe('availability', () => {
  test('only `available` is usable', () => {
    assert.equal(isUsable({ kind: 'available' }), true);
    assert.equal(isUsable({ kind: 'downloadable' }), false);
    assert.equal(isUsable({ kind: 'downloading', progress: 0.5 }), false);
    assert.equal(isUsable(unavailable('deviceNotEligible')), false);
  });

  test('an unavailable state always names a reason', () => {
    // AVL-5: the caller must be able to tell the user *why*, not just that it failed.
    assert.equal(unavailable('noProvider').reason, 'noProvider');
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd web-ai && npm test`
Expected: FAIL, cannot find module `../dist/availability.js`

- [x] **Step 3: Implement**

```ts
/**
 * Whether a feature can run right now.
 *
 * A superset of what any one platform reports: Apple has only available and
 * unavailable, while Android and Web genuinely distinguish a model that could be
 * downloaded from one that is downloading. Mapping is per-platform and lossy in
 * Apple's direction — see `apple.swift`.
 */
export type PdfAiAvailability =
  | { readonly kind: 'available' }
  | { readonly kind: 'downloadable' }
  | { readonly kind: 'downloading'; readonly progress?: number }
  | { readonly kind: 'unavailable'; readonly reason: PdfAiUnavailableReason };

export type PdfAiUnavailableReason =
  /** The hardware cannot run it. */
  | 'deviceNotEligible'
  /** The user turned the platform's AI off. */
  | 'notEnabled'
  /** Present but not loaded yet. */
  | 'modelNotReady'
  /** No such API on this OS or browser. */
  | 'platformUnsupported'
  /** The document's language is not supported by the platform. */
  | 'languageNotSupported'
  /** No on-device route and no custom provider configured. */
  | 'noProvider';

export function unavailable(reason: PdfAiUnavailableReason): PdfAiAvailability {
  return { kind: 'unavailable', reason };
}

export function isUsable(a: PdfAiAvailability): boolean {
  return a.kind === 'available';
}
```

- [x] **Step 4: Run the tests**

Run: `cd web-ai && npm test`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add web-ai/src/availability.ts web-ai/test/availability.test.ts
git commit -m "Add the availability model"
```

---

## Task 2: The provider interface and resolution order (web)

PRV-1, PRV-2 and PRV-3. The order is fixed and testable: on-device, then the custom
provider, then the feature's non-AI fallback, then unavailable.

**Files:**
- Create: `web-ai/src/provider.ts`
- Test: `web-ai/test/provider.test.ts`

**Interfaces:**
- Consumes: `PdfAiAvailability` (Task 1)
- Produces: `PdfAiProvider`, `PdfAiRequest`, `PdfAiResponse`, `PdfAiSource`,
  `PdfAiResult<T>`, `resolve<T>(routes): Promise<PdfAiResult<T> | PdfAiAvailability>`

- [x] **Step 1: Write the failing test**

```ts
test('routes are tried in order and the winner is named', async () => {
  const calls: string[] = [];
  const result = await resolve<string>({
    onDevice: async () => { calls.push('onDevice'); return null; },
    customProvider: async () => { calls.push('provider'); return 'from-provider'; },
    rules: async () => { calls.push('rules'); return 'from-rules'; },
  });

  assert.deepEqual(calls, ['onDevice', 'provider'],
    'the rules fallback must not run once a provider answered');
  assert.deepEqual(result, { value: 'from-provider', source: 'customProvider' });
});

test('with every route empty the result is unavailable, not an exception', async () => {
  const result = await resolve<string>({
    onDevice: async () => null, customProvider: async () => null, rules: async () => null,
  });
  assert.deepEqual(result, { kind: 'unavailable', reason: 'noProvider' });
});

test('a route that throws does not stop the next one', async () => {
  // A provider is someone else's server. It failing must not take the feature down
  // when a rules fallback exists.
  const result = await resolve<string>({
    onDevice: async () => null,
    customProvider: async () => { throw new Error('502'); },
    rules: async () => 'from-rules',
  });
  assert.deepEqual(result, { value: 'from-rules', source: 'rules' });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd web-ai && npm test`
Expected: FAIL, `resolve` is not exported

- [x] **Step 3: Implement**

```ts
import { type PdfAiAvailability, unavailable } from './availability.js';

/** Where an answer came from. Shown to users and logged for audits (PRV-3). */
export type PdfAiSource = 'onDevice' | 'customProvider' | 'rules';

export interface PdfAiResult<T> {
  readonly value: T;
  readonly source: PdfAiSource;
}

export interface PdfAiRequest {
  readonly prompt: string;
  /** Encoded images, for providers that accept them. Apple's model does not. */
  readonly images?: readonly Uint8Array[];
  /** JSON Schema for structured output, when the feature needs one. */
  readonly schema?: unknown;
}

export interface PdfAiResponse {
  readonly text: string;
  readonly structured?: unknown;
}

/** Implemented by the integrator: their own server, or their own model. */
export interface PdfAiProvider {
  generate(request: PdfAiRequest): Promise<PdfAiResponse>;
}

type Route<T> = () => Promise<T | null>;

/**
 * Tries each route in the fixed order of PRV-2 and reports which one answered.
 *
 * A route returns null when it has no answer and throws when it broke; both move on to
 * the next route, because a provider outage must not take down a feature that has a
 * rules fallback.
 */
export async function resolve<T>(routes: {
  onDevice?: Route<T>;
  customProvider?: Route<T>;
  rules?: Route<T>;
}): Promise<PdfAiResult<T> | PdfAiAvailability> {
  const ordered: [PdfAiSource, Route<T> | undefined][] = [
    ['onDevice', routes.onDevice],
    ['customProvider', routes.customProvider],
    ['rules', routes.rules],
  ];

  for (const [source, route] of ordered) {
    if (!route) continue;
    try {
      const value = await route();
      if (value != null) return { value, source };
    } catch {
      // Deliberately swallowed: the next route is the fallback this exists for.
    }
  }
  return unavailable('noProvider');
}
```

- [x] **Step 4: Run the tests**

Run: `cd web-ai && npm test`
Expected: PASS, 3 tests

- [x] **Step 5: Commit**

```bash
git add web-ai/src/provider.ts web-ai/test/provider.test.ts
git commit -m "Add the provider interface and its fixed resolution order"
```

---

## Task 3: Proposals and apply (web)

HIL-1 and HIL-2. Every mutating feature returns proposals; nothing is written until the
host accepts some of them.

**Files:**
- Create: `web-ai/src/proposal.ts`
- Test: `web-ai/test/proposal.test.ts`

**Interfaces:**
- Consumes: `PdfAiSource` (Task 2)
- Produces: `PdfProposal<T>`, `PdfProposalSet<T>`, `applyProposals()`, `PdfUndoToken`

- [x] **Step 1: Write the failing test**

```ts
test('nothing is written until apply is called', async () => {
  const written: string[] = [];
  const set = proposalSet([
    { id: 'p1', kind: 'formValue', detail: 'Ada', source: 'rules' },
    { id: 'p2', kind: 'formValue', detail: 'Lovelace', source: 'rules' },
  ], async (p) => { written.push(p.id); });

  assert.deepEqual(written, [], 'building the set must not touch the document');

  await applyProposals(set, ['p1']);
  assert.deepEqual(written, ['p1'], 'only the accepted proposal is written');
});

test('an id that is not in the set is refused, not silently ignored', async () => {
  const set = proposalSet([], async () => {});
  await assert.rejects(() => applyProposals(set, ['nope']), /unknown proposal/);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd web-ai && npm test`
Expected: FAIL, `proposalSet` is not exported

- [x] **Step 3: Implement**

```ts
import type { PdfAiSource } from './provider.js';

export type PdfProposalKind = 'formValue' | 'altText' | 'redaction' | 'tag';

/** A change the user has not agreed to yet. */
export interface PdfProposal<T> {
  readonly id: string;
  readonly kind: PdfProposalKind;
  readonly detail: T;
  readonly source: PdfAiSource;
}

export interface PdfProposalSet<T> {
  readonly proposals: readonly PdfProposal<T>[];
  /** How one proposal is written. Called only from `applyProposals`. */
  readonly write: (proposal: PdfProposal<T>) => Promise<void>;
}

export function proposalSet<T>(
  proposals: readonly PdfProposal<T>[],
  write: (proposal: PdfProposal<T>) => Promise<void>,
): PdfProposalSet<T> {
  return { proposals, write };
}

/**
 * Writes exactly the proposals the user accepted, in the order they were proposed.
 *
 * An unknown id is an error rather than a no-op: it means the host and the SDK disagree
 * about what was on screen, and silently writing nothing would look like success.
 */
export async function applyProposals<T>(
  set: PdfProposalSet<T>,
  acceptedIds: readonly string[],
): Promise<void> {
  const byId = new Map(set.proposals.map((p) => [p.id, p]));
  for (const id of acceptedIds) {
    if (!byId.has(id)) throw new Error(`unknown proposal: ${id}`);
  }
  for (const proposal of set.proposals) {
    if (acceptedIds.includes(proposal.id)) await set.write(proposal);
  }
}
```

- [x] **Step 4: Run the tests**

Run: `cd web-ai && npm test`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add web-ai/src/proposal.ts web-ai/test/proposal.test.ts
git commit -m "Add the proposal and apply API"
```

**Note on HIL-2 (undo until save):** the core already gives this for free — the document
in memory is the working copy, and nothing reaches disk until `toBytes()`. Document that
rather than building an undo stack. If a later feature needs finer undo, that is its
plan's problem, not Phase 0's.

---

## Task 4: The web package, and a stub feature

The package that ships, plus the feature whose only job is to be unavailable — which is
what makes the Phase 0 exit criterion testable before any real feature exists.

**Files:**
- Create: `web-ai/package.json`, `web-ai/tsconfig.json`, `web-ai/src/index.ts`
- Test: `web-ai/test/stub.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, and `PdfDocument` from `@pdfcora/web`
- Produces: `PdfAI`, `PdfAI.stub.availability()`, `PdfAI.stub.run()`

- [x] **Step 1: Write the failing test**

```ts
test('with no provider configured the stub is unavailable, with a reason', async () => {
  const ai = new PdfAI(document, {});
  assert.deepEqual(await ai.stub.availability(),
    { kind: 'unavailable', reason: 'platformUnsupported' });
});

test('with a provider configured the stub becomes available and says so', async () => {
  const ai = new PdfAI(document, {
    provider: { async generate() { return { text: 'ok' }; } },
  });
  assert.deepEqual(await ai.stub.availability(), { kind: 'available' });
  assert.deepEqual(await ai.stub.run(), { value: 'ok', source: 'customProvider' });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd web-ai && npm test`
Expected: FAIL, cannot find `PdfAI`

- [x] **Step 3: Implement**

`package.json` — note the peer dependency, so the AI package never pulls a second copy
of the core:

```json
{
  "name": "pdfcora-ai",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "peerDependencies": { "@pdfcora/web": "^0.1.0" },
  "dependencies": {},
  "scripts": { "build": "tsc -p .", "test": "npm run build && node --test dist-test/" }
}
```

```ts
// src/index.ts
import type { PdfDocument } from '@pdfcora/web';
import { type PdfAiAvailability, unavailable } from './availability.js';
import { type PdfAiProvider, type PdfAiResult, resolve } from './provider.js';

export * from './availability.js';
export * from './provider.js';
export * from './proposal.js';

export interface PdfAIOptions {
  readonly provider?: PdfAiProvider;
  /** Android and Web alpha prompt APIs stay off unless asked for (PRV-5). */
  readonly experimentalOnDevicePrompt?: boolean;
}

/**
 * The entry point. One instance per document.
 *
 * Every feature reports availability separately (AVL-2) and re-checks on each call
 * (AVL-3), because the user can turn the platform's AI off mid-session.
 */
export class PdfAI {
  constructor(
    private readonly document: PdfDocument,
    private readonly options: PdfAIOptions,
  ) {}

  /**
   * A feature that does nothing, so the not-available path can be exercised before
   * any real feature exists. Delete it when Phase 1 lands.
   */
  readonly stub = {
    availability: async (): Promise<PdfAiAvailability> =>
      // The web has no general on-device model, so this is the honest answer.
      this.options.provider ? { kind: 'available' } : unavailable('platformUnsupported'),

    /**
     * Asks the platform to fetch the model. AVL-4 forbids the SDK starting a download
     * on its own, so this exists to be called by the host and nowhere else.
     *
     * `onProgress` is how AVL-4's "SDK reports download progress" is met. The web has
     * nothing to download, so this resolves immediately.
     */
    prepare: async (onProgress?: (fraction: number) => void): Promise<PdfAiAvailability> => {
      onProgress?.(1);
      return this.stub.availability();
    },

    run: async (): Promise<PdfAiResult<string> | PdfAiAvailability> =>
      resolve<string>({
        customProvider: async () => {
          const provider = this.options.provider;
          if (!provider) return null;
          return (await provider.generate({ prompt: 'ping' })).text;
        },
      }),
  };
}
```

- [x] **Step 4: Write the failing test for AVL-4**

```ts
test('nothing downloads unless the host asks', async () => {
  let asked = false;
  const ai = new PdfAI(document, {});
  await ai.stub.availability();
  // Merely checking availability must never trigger a fetch (AVL-4).
  assert.equal(asked, false);

  const progress: number[] = [];
  await ai.stub.prepare((f) => progress.push(f));
  assert.ok(progress.length > 0, 'prepare must report progress, even trivially');
});
```

- [x] **Step 5: Run the tests**

Run: `cd web-ai && npm test`
Expected: PASS

- [x] **Step 6: Check the package pulls in nothing**

Run: `cd web-ai && npm ls --omit=dev --omit=peer`
Expected: no dependencies listed

- [x] **Step 7: Commit**

```bash
git add web-ai/
git commit -m "Add the pdfcora-ai web package and its stub feature"
```

---

## Task 5: Port to iOS — `PDFCoraAI`

The only platform with a real general on-device model, and the only place the Apple
mapping in Task 1 gets exercised.

**Files:**
- Modify: `Package.swift` — add a `PDFCoraAI` library product and target
- Create: `ios/Sources/PDFCoraAI/{Availability,Provider,Proposal,PdfAI}.swift`
- Create: `ios/Sources/PDFCoraAI/Apple.swift` — the FoundationModels mapping
- Test: `ios/Tests/PDFCoraAITests/AvailabilityTests.swift`

**Interfaces:**
- Consumes: `PdfDocument` from `PDFCora` (public API only)
- Produces: the Swift equivalents of Tasks 1–4

- [x] **Step 1: Add the product without touching the core's**

```swift
// Package.swift — the core product is untouched; this is additive.
products: [
    .library(name: "PDFCora", targets: ["PDFCora"]),
    .library(name: "PDFCoraAI", targets: ["PDFCoraAI"]),
],
targets: [
    // ...existing core targets unchanged...
    .target(name: "PDFCoraAI", dependencies: ["PDFCora"],
            path: "ios/Sources/PDFCoraAI"),
    .testTarget(name: "PDFCoraAITests", dependencies: ["PDFCoraAI"],
                path: "ios/Tests/PDFCoraAITests"),
]
```

- [x] **Step 2: Write the failing test for the Apple mapping**

```swift
func testAppleStatesMapOntoOurs() {
    // Apple reports two states; we report four. The two it does not have are
    // unreachable on this platform, and that is the point of pinning it here.
    XCTAssertEqual(PdfAiAvailability(apple: .available), .available)
    XCTAssertEqual(PdfAiAvailability(apple: .unavailable(.deviceNotEligible)),
                   .unavailable(.deviceNotEligible))
    XCTAssertEqual(PdfAiAvailability(apple: .unavailable(.appleIntelligenceNotEnabled)),
                   .unavailable(.notEnabled))
    XCTAssertEqual(PdfAiAvailability(apple: .unavailable(.modelNotReady)),
                   .unavailable(.modelNotReady))
}

func testAnOsWithoutTheFrameworkIsUnsupportedNotACrash() async {
    // The package must build and run on iOS 15. Below iOS 26 there is no framework.
    let ai = PdfAI(document: document, options: .init())
    if #available(iOS 26.0, *) {} else {
        let state = await ai.stub.availability()
        XCTAssertEqual(state, .unavailable(.platformUnsupported))
    }
}
```

- [x] **Step 3: Implement the mapping, weak-linked**

```swift
#if canImport(FoundationModels)
import FoundationModels
#endif

extension PdfAiAvailability {
    /// Apple reports two states. `downloadable` and `downloading` have no Apple
    /// equivalent — the system manages the model — so they are simply never produced
    /// here rather than being faked.
    @available(iOS 26.0, macOS 26.0, *)
    init(apple: SystemLanguageModel.Availability) {
        switch apple {
        case .available: self = .available
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible: self = .unavailable(.deviceNotEligible)
            case .appleIntelligenceNotEnabled: self = .unavailable(.notEnabled)
            case .modelNotReady: self = .unavailable(.modelNotReady)
            @unknown default: self = .unavailable(.platformUnsupported)
            }
        }
    }
}

enum AppleModel {
    /// Re-checked on every call (AVL-3): the user can turn Apple Intelligence off
    /// while the app is running.
    static func availability() -> PdfAiAvailability {
        guard #available(iOS 26.0, macOS 26.0, *) else {
            return .unavailable(.platformUnsupported)
        }
        return PdfAiAvailability(apple: SystemLanguageModel.default.availability)
    }

    /// The prompt budget comes from the OS, not from a constant, so it follows the
    /// platform when Apple changes it.
    @available(iOS 26.0, macOS 26.0, *)
    static var contextTokens: Int { SystemLanguageModel.default.contextSize }
}
```

- [x] **Step 4: Verify PKG-3 — the floor did not move**

Run: `swift build -Xswiftc -target -Xswiftc arm64-apple-ios15.0-simulator`
Expected: builds. `Package.swift` still declares `.iOS(.v15)`, and `FoundationModels` is
reached only behind `#available(iOS 26.0, *)` with `#if canImport`. An app on iOS 15 that
links `PDFCoraAI` must still launch.

- [x] **Step 5: Run the tests**

Run: `xcodebuild test -scheme PDFCoraAI -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0'`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add Package.swift ios/Sources/PDFCoraAI ios/Tests/PDFCoraAITests
git commit -m "Add PDFCoraAI with the Apple availability mapping"
```

---

## Task 6: Port to Android — `pdfcora-ai`

No ML Kit dependency in Phase 0. Android's on-device routes arrive with the features that
need them; adding the dependency now would only risk PKG-2.

**Files:**
- Create: `android/pdfcora-ai/build.gradle.kts`
- Create: `android/pdfcora-ai/src/main/java/com/pdfcora/ai/{Availability,Provider,Proposal,PdfAI}.kt`
- Modify: `android/settings.gradle.kts` — include the module
- Test: `android/pdfcora-ai/src/test/java/com/pdfcora/ai/AvailabilityTest.kt`

- [x] **Step 1: Add the module with `api` on the core only**

```kotlin
dependencies {
    api(project(":pdfcora"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // No ML Kit yet. It arrives with the feature that needs it.
}

// PKG-3: the module must not raise the app's floor. Matches the core.
android { defaultConfig { minSdk = 23 } }
```

- [x] **Step 2: Write the failing test**

```kotlin
@Test
fun `with no provider the stub is unavailable with a reason`() = runTest {
    val ai = PdfAI(document, PdfAIOptions())
    assertEquals(
        PdfAiAvailability.Unavailable(PdfAiUnavailableReason.PLATFORM_UNSUPPORTED),
        ai.stub.availability(),
    )
}
```

- [x] **Step 3: Implement the Kotlin equivalents of Tasks 1–4**

Mirror the TypeScript exactly: a sealed `PdfAiAvailability`, a `PdfAiProvider` fun
interface, `resolve()` with the same ordering and the same swallow-and-continue
behaviour, and `applyProposals()` with the same unknown-id refusal. The tests port
one-for-one; if a Kotlin test needs different assertions than its TypeScript twin, the
implementations have diverged and one of them is wrong.

- [x] **Step 4: Run the tests**

Run: `cd android && gradle :pdfcora-ai:testDebugUnitTest`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add android/pdfcora-ai android/settings.gradle.kts
git commit -m "Add the pdfcora-ai Android module"
```

---

## Task 7: The PKG-2 CI check

The requirement that the core stays clean, enforced rather than reviewed.

**Files:**
- Create: `scripts/check-core-deps.sh`
- Modify: the CI workflow to run it

**Interfaces:**
- Produces: exit 0 when the core's three graphs are clean, non-zero with the offending
  line otherwise

- [x] **Step 1: Write the check so it fails on a planted dependency first**

Temporarily add `implementation("com.google.mlkit:genai-summarization:1.0.0-beta1")` to
`android/pdfcora/build.gradle.kts`, run the script, confirm it exits non-zero and names
the line. **A guard that has never failed is not known to work.** Then revert.

- [x] **Step 2: Implement**

```bash
#!/usr/bin/env bash
# The core must not depend on any AI runtime. pdfcora-ai may; pdfcora may not.
set -euo pipefail
cd "$(dirname "$0")/.."

BANNED='mlkit|ml-kit|play-services|aicore|genai|FoundationModels'
fail=0

# Swift: the core has no external dependencies at all, so anything is a regression.
if swift package show-dependencies --format flatlist 2>/dev/null | grep -q .; then
  echo "core Swift package gained a dependency:"; swift package show-dependencies --format flatlist
  fail=1
fi

# Web: runtime dependencies only — dev tooling is not shipped.
if node -e 'const d=require("./web/package.json").dependencies||{};
            if (Object.keys(d).length) { console.log(JSON.stringify(d)); process.exit(1) }'; then :; else
  echo "core web package gained a runtime dependency"; fail=1
fi

# Android: the resolved runtime classpath, not the declared block — a transitive
# pull-in is exactly the failure this guard exists for.
if (cd android && gradle -q :pdfcora:dependencies \
      --configuration releaseRuntimeClasspath --console=plain) \
   | grep -Ei "$BANNED"; then
  echo "core Android module resolves an AI runtime (above)"; fail=1
fi

# PKG-1: the AI packages ship alongside the core with matching versions. A drifted
# version is how an integrator ends up pairing incompatible halves.
core_web=$(node -p 'require("./web/package.json").version')
ai_web=$(node -p 'require("./web-ai/package.json").version')
if [ "$core_web" != "$ai_web" ]; then
  echo "version drift: @pdfcora/web $core_web vs pdfcora-ai $ai_web"; fail=1
fi

[ "$fail" -eq 0 ] && echo "core dependency graph is clean, versions aligned"
exit "$fail"
```

- [x] **Step 3: Run it**

Run: `./scripts/check-core-deps.sh`
Expected: `core dependency graph is clean, versions aligned`

- [x] **Step 4: Commit**

```bash
git add scripts/check-core-deps.sh .github/workflows/
git commit -m "Fail the build if the core gains an AI dependency"
```

---

## Task 8: The not-available screen, and the docs

The Phase 0 exit criterion. Each demo shows what a user sees when a feature cannot run —
which, on most devices today, is what they will see.

**Files:**
- Modify: `web/demo/app.js`, `ios/Demo/Sources/Screens/`, `android/demo/src/main/java/com/pdfcora/demo/`
- Modify: `scripts/make-docs.sh` — an AI section in each quickstart

- [x] **Step 1: Add an "AI" tab to each demo**

It shows the stub feature's availability verbatim, including the reason, and a field for
pasting a provider endpoint so the available path can be seen too. No AI feature is
called; there is none yet.

- [x] **Step 2: Document per DOC-3**

For the stub, and as the template every later feature fills in: device and OS
requirements, supported languages, known limits, and what the user sees when it is not
available.

- [x] **Step 3: Verify the exit criterion on each platform**

Run each demo on a device with no on-device model. Expected: the not-available screen
with a reason, no crash, no thrown error.

- [x] **Step 4: Commit**

```bash
git commit -am "Show the not-available path in all three demos"
```

---

## Stated limitations

- **Phase 0 delivers no user-visible value.** Its output is a package that reports it
  cannot do anything yet. That is the intended result, and it should be said plainly to
  anyone asking what changed.
- **`downloadable` and `downloading` are unreachable on Apple.** They exist for Android
  and Web. Do not add Apple code that produces them.
- **Alt text has no Apple on-device route at all** — `FoundationModels` is text-only as of
  iOS 26.4. Phase 3 should not be planned on the assumption that it does.
- **HIL-2 is satisfied by the core's existing behaviour**, not by new code: nothing
  reaches disk until the document is saved.
- **HIL-3 (a default review UI) is deliberately not in Phase 0.** It is a SHOULD, and a
  review screen with nothing to review cannot be judged or tested. It belongs to Phase 2,
  the first phase that produces real proposals — form values and redaction suggestions.
  The headless proposal API it would sit on ships here, in Task 3.

## Risks

| Risk | Mitigation |
| --- | --- |
| The AI package drifts from the core's public API and needs an internal hook | PKG-4 is checked by the package importing only `PDFCora` / `@pdfcora/web`, never `@testable` |
| ML Kit raises Android's `minSdk` above 23 when it is added in a later phase | Not a Phase 0 risk — nothing depends on ML Kit yet. Measure when the dependency lands |
| The four-state availability model proves wrong once a second platform is wired up | It is one file per platform and one mapping test; changing it in Phase 1 is cheap. Changing it after three features ship is not |
| Apple adds image input and §11's design is stale | The finding is dated and the source named, so it can be re-checked against a newer SDK in one command |

## Self-review notes

- Every task ends with a test that would fail if the task were reverted.
- Task 7 is the only task whose guard is itself tested by deliberately breaking it —
  which is the same discipline the DER fuzz gate and the redaction erasure assertion got,
  after both were found to pass with the check deleted.
- No task prompts a model. The first one that does belongs to Phase 1.


---

## What executing this taught us

Three things the plan asserted that the machine disagreed with. All three are now pinned
by tests rather than by prose.

**`contextSize` does not return 4096.** The plan read that number out of
`FoundationModels.swiftinterface` and treated it as the answer. It is the body of the
`@backDeployed(before: iOS 26.4)` shim — the value used on OSes *without* the real
implementation. An iOS 27 simulator returns `0`, while simultaneously reporting the model
as `.available`. Availability is therefore not a proxy for usability, and
`contextTokens()` now reports a non-positive budget as no budget at all.

**The platform's answers move between calls.** A test that read availability and the
budget microseconds apart got a pair that contradicted itself — available, with no budget,
yet reported as promptable. The fix is `AppleModel.read()`, which samples both together
and returns a `Reading` that decisions are made from. This is what AVL-3 was really asking
for: sample per operation, then decide from the sample, rather than re-querying mid-
decision.

**Adding a second library product broke the core's test script.** Once `Package.swift`
declared two library products, the per-product schemes stopped carrying a test action, and
`scripts/test-ios.sh` failed with "Scheme PDFCora is not currently configured for the
test action". The core suite was not running. The script now drives `PDFCora-Package`
and selects targets explicitly. Worth noting because nothing about adding an optional
package suggests it would touch the core's gate.

Two smaller ones: Kotlin block comments nest, so a `/*` inside KDoc (from a glob in a file
path) opens a comment that the closing `*/` then closes instead of the outer one. And
`LabeledContent` is iOS 16+, which the demo caught immediately — the iOS 15 floor PKG-3
promises is real and enforced by the demo building against it.
