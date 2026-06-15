export const meta = {
  name: 'regression-suite',
  description: 'Author + adversarially verify a heavy regression test suite, module by module',
  phases: [
    { title: 'Author', detail: 'one agent per module writes & runs co-located Vitest tests' },
    { title: 'Verify', detail: 'adversarial reviewer re-runs each suite and critiques it' },
  ],
}

// ── Harness contract handed to every agent ────────────────────────────────────
const HARNESS = `
TEST HARNESS (already set up — DO NOT modify it):
- Runner: Vitest 2 with environment 'jsdom'. Config: vitest.config.ts. Globals are ON, so
  describe/it/expect/vi/beforeEach are available WITHOUT import (you may import from 'vitest'
  too if you prefer).
- Global setup: test/setup.ts runs before every test. It installs a fresh in-memory stub of
  chrome.* on globalThis and RESETS it before each test. It models:
    * chrome.storage.local.get/set/remove/clear  -> promise-based, backed by an in-memory Map
    * chrome.storage.onChanged.addListener/removeListener
    * chrome.runtime.connect/connectNative/sendMessage/onConnect/onMessage/getURL/id/lastError
    * chrome.tabs.create
  You can import helpers: from a test at src/<area>/x.test.ts use
    import { chromeStore, emitStorageChange, makeChrome } from '<relativePath>/test/setup'
  (e.g. src/shared/foo.test.ts -> '../../test/setup'; src/background/github/x.test.ts ->
   '../../../test/setup'). chromeStore is the backing Map; emitStorageChange(changes,'local')
  fires onChanged listeners.
- Anything chrome.* doesn't model, or network/SDK/native ports, you stub yourself with vi.fn()
  / vi.mock(). NEVER hit the real network, filesystem, or spawn processes. Tests must be
  deterministic and fast (use vi.useFakeTimers() if timing is involved).

RULES:
- Co-locate your test next to the source: <module>.test.ts (e.g. src/shared/redact.test.ts).
- Run ONLY your file: \`npx vitest run <your-test-path>\`. Iterate until it is GREEN.
- Do NOT edit vitest.config.ts, test/setup.ts, package.json, tsconfig.json, or ANY source
  file under src/ other than creating your own *.test.ts. The source is the system under test.
- The committed suite must be GREEN against CURRENT source behavior. If you discover behavior
  you believe is a real BUG, do BOTH: (a) add an \`it.skip('BUG: ...', ...)\` documenting the
  CORRECT expected behavior with a // BUG: comment, and (b) report it in bugsFound with exact
  file:line and why. Do not silently encode buggy behavior as "correct".
- Write MEANINGFUL tests: real assertions on observable behavior and edge cases, not
  tautologies, not "expect(mock).toHaveBeenCalled" as the only check, not over-mocking the
  unit under test. Cover happy path + boundaries + error paths.
- Read the source file (and its imports) before writing. Match the real exported API exactly.
`

const AUTHOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['module', 'testFile', 'testsWritten', 'passing', 'command', 'bugsFound', 'notes'],
  properties: {
    module: { type: 'string' },
    testFile: { type: 'string', description: 'path to the test file created' },
    testsWritten: { type: 'number' },
    passing: { type: 'boolean', description: 'true only if your vitest run was fully green' },
    command: { type: 'string', description: 'the exact vitest command you ran last' },
    bugsFound: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'severity', 'description'],
        properties: {
          location: { type: 'string', description: 'file:line' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          description: { type: 'string' },
        },
      },
    },
    notes: { type: 'string', description: 'coverage summary + anything the verifier should know' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['module', 'verdict', 'reran', 'passing', 'weakTests', 'confirmedBugs', 'recommendation'],
  properties: {
    module: { type: 'string' },
    verdict: { type: 'string', enum: ['solid', 'adequate', 'weak', 'broken'] },
    reran: { type: 'boolean' },
    passing: { type: 'boolean' },
    weakTests: { type: 'array', items: { type: 'string' }, description: 'tautological/over-mocked/brittle tests by name' },
    confirmedBugs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'real', 'description'],
        properties: {
          location: { type: 'string' },
          real: { type: 'boolean' },
          description: { type: 'string' },
        },
      },
    },
    recommendation: { type: 'string' },
  },
}

// ── Modules under test ────────────────────────────────────────────────────────
const MODULES = [
  { key: 'redact', path: 'src/shared/redact.ts', focus:
    'redactSecrets: every PATTERN shape (AWS AKIA, GitHub ghp_/github_pat_, Anthropic sk-ant, OpenAI sk-/sk-proj, Google AIza, Slack xox, Stripe live, JWT, PRIVATE KEY block); ASSIGNMENT masks the value but keeps key+quotes; TOKEN entropy gate (a random mixed-charset 32+ token IS masked; a hex SHA, a UUID, an all-lowercase identifier, a camelCase identifier are NOT masked); count is accurate; empty string -> {text, count:0}; ordinary code is left untouched (no false positives).' },
  { key: 'prompt', path: 'src/shared/prompt.ts', focus:
    'buildUserContent(req): includes the selected code, file path, line/side, the user question, and diff-grounding/history when present; gracefully omits optional fields when absent; output ordering/sections are stable. Read AskRequest in src/shared/types.ts for the exact shape.' },
  { key: 'persistence', path: 'src/shared/persistence.ts', focus:
    'threadKey(repo,prNumber) format (repo#prNumber); saveThread then loadThread round-trips turns+draft; loadThread returns null/empty for an unknown key; clearThread removes it; any TTL/expiry logic; keys are isolated per repo#pr. Drive chrome.storage via the stub; inspect chromeStore.' },
  { key: 'storage', path: 'src/shared/storage.ts', focus:
    'getSettings merges DEFAULT_SETTINGS under the stored partial (missing fields fall back; stored fields win); setSettings merges a patch, persists, and returns the merged result; onSettingsChanged fires on a local "settings" change, ignores other areas/keys, and the returned unsubscribe removes the listener. Use emitStorageChange for the change event.' },
  { key: 'messages', path: 'src/shared/messages.ts', focus:
    'Test whatever real logic exists (type guards, discriminant constants, message builders/parsers, port name constants). If the file is purely type declarations with no runtime logic, write minimal structural/constant assertions and say so in notes — do not invent behavior.' },
  { key: 'selection', path: 'src/content/selection.ts', focus:
    'Build jsdom fixtures mirroring BOTH GitHub diff DOMs. Legacy /files: table rows with line-number cells + code. New /changes: file path from aria-label="Diff for: <path>", line numbers in data-line-number with data-diff-side. Verify the exported parser returns {file,line,side,code} for a single line; reviewTarget for a multi-line selection (start/end, side-aware); ignores user-select:none gutter/hunk-header cells; returns null when nothing diff-related is selected. Mock window.getSelection() with ranges over your fixture.' },
  { key: 'comments', path: 'src/content/comments.ts', focus:
    'The canned-comment catalog and Conventional Comments labels/decorations are well-formed (non-empty, unique ids, expected fields). insert/prepend into a focused jsdom <textarea>: inserts at caret / prepends, preserves existing text, sets focus/selection; no-ops or signals when no comment box is focused. Use tagName/activeElement-style checks as the source does.' },
  { key: 'dock-panel', path: 'src/content/dock/dock-panel.ts', focus:
    'THE REGRESSION CROWN JEWEL. Instantiate DockPanel in jsdom and assert on its open shadow root. MUST include a test that FAILS if inputEl is ever rebound away from the .composer textarea: type into the composer textarea, click .btn.ask, and assert onSubmit receives that exact text (this is the bug we just fixed — guard it). Also: submit() ignores empty/whitespace and ignores clicks while streaming; Post (.btn.post) and Add-to-review (.btn.addreview) read the COMPOSER value and call onPost/onAddToReview; Cmd/Ctrl+Enter submits; each button (suggest/summarize/review/testgaps/overview) invokes its callback and is gated by streaming; startAnswer->appendText->finishAnswer commits a turn and renders markdown; showError renders the message; severity words (Blocker/Major/Minor/Nit/Praise) at the start of a finding become chips; setSelection toggles the chip; getThread/restoreThread (or getState) round-trips draft+turns; collapse/launcher toggles the collapsed attribute. Wire the on* callbacks with vi.fn().' },
  { key: 'content-index', path: 'src/content/index.ts', focus:
    'Best-effort integration. Mock chrome.runtime.connect to return a fake port (postMessage + onMessage.addListener) and a fake DockPanel (or the real one). Verify: an ASK streams CHUNK->appendText, DONE->finishAnswer, ERROR->showError; a lost connection shows an error; guards show the right message when there is no PR or no selection. Prefer a few high-value behavioral tests over brittle deep mocks; note what you could not isolate.' },
  { key: 'github-api', path: 'src/background/github/api.ts', focus:
    'Stub global.fetch with vi.fn returning Response-like objects. Cover: the PURE path-based test-gap heuristic thoroughly (source files with/without matching test changes, various extensions/paths); head sha, PR title/body, files+patch parsing; post single-line AND multi-line comment (correct body/side/line/start_line); delete comment; submit review (batches comments + verdict). Assert request URL/method/headers (PAT auth)/body, and error handling on non-2xx responses. Never hit the network.' },
  { key: 'registry', path: 'src/background/providers/registry.ts', focus:
    'ProviderRegistry: registering providers; picking the provider named in settings; falling back to an available provider when the preferred one is unavailable; throwing NoProviderAvailableError when none can serve. Stub provider objects implementing the LlmProvider interface (see src/background/providers/types.ts) with controllable isAvailable/availability.' },
  { key: 'anthropic-provider', path: 'src/background/providers/anthropic.ts', focus:
    "Mock the @anthropic-ai/sdk module with vi.mock so no real client is constructed. Feed a fake streaming iterator of SDK events and assert the provider yields text chunks in order, ignores non-text events, surfaces errors, and reports availability based on the API key. Read the file to see the exact SDK surface it uses." },
  { key: 'claudecode-provider', path: 'src/background/providers/claudeCode.ts', focus:
    'Stub chrome.runtime.connectNative to return a fake port. Drive the native stream-json protocol: stream_event -> content_block_delta -> text_delta yields text; thinking_delta is ignored; result with is_error=false ends OK, is_error=true surfaces an error; a port disconnect surfaces an error. Assert availability detection.' },
  { key: 'background-index', path: 'src/background/index.ts', focus:
    'Best-effort. Simulate chrome.runtime.onConnect with a fake port and assert the ASK router streams CHUNK/DONE/ERROR back via port.postMessage using a stubbed provider/registry; simulate the one-shot GitHub message handler routing to the api layer (mock it). Prefer few high-value tests; note anything not isolable.' },
]

phase('Author')
const results = await pipeline(
  MODULES,
  (m) =>
    agent(
      `You are writing a thorough regression test suite for ONE module of the Cortex browser-extension repo.

MODULE: ${m.path}
TEST FILE TO CREATE: ${m.path.replace(/\.ts$/, '.test.ts')}

FOCUS:
${m.focus}

${HARNESS}

Steps: (1) Read ${m.path} and the types/imports it uses. (2) Write the test file. (3) Run \`npx vitest run ${m.path.replace(/\.ts$/, '.test.ts')}\` and iterate until GREEN. (4) Return the structured result. Be rigorous — this suite is the regression net for a shipping extension.`,
      { label: `author:${m.key}`, phase: 'Author', schema: AUTHOR_SCHEMA },
    ).then((r) => ({ m, author: r })),
  ({ m, author }) =>
    agent(
      `You are an ADVERSARIAL test reviewer. Another agent wrote a regression suite for ${m.path}.
Its self-report: ${JSON.stringify(author)}

Your job:
1. Read the test file (${m.path.replace(/\.ts$/, '.test.ts')}) AND the source ${m.path}.
2. Re-run it: \`npx vitest run ${m.path.replace(/\.ts$/, '.test.ts')}\`. Record whether it is actually green.
3. Critique HARD: flag tautological assertions, tests that only check a mock was called, over-mocking that tests the mock instead of the unit, missing edge/error cases, and brittle DOM/string coupling. List weak tests by name.
4. For each reported bug, independently judge whether it is REAL (read the source; a test passing against buggy behavior is NOT a real bug unless the behavior is genuinely wrong).
5. You MAY add or tighten tests in the file to close important gaps you found (keep it green; same harness rules — do not edit source or shared config). If you change the file, re-run it.

${HARNESS}

Return the structured verdict.`,
      { label: `verify:${m.key}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((verify) => ({ module: m.key, path: m.path, author, verify })),
)

return results.filter(Boolean)
