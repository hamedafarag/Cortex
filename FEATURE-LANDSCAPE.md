# Review Feature Landscape

*Snapshot: June 2026. Synthesized from a multi-agent web survey of code-review tooling — 8
research clusters (AI review bots, PR summaries/walkthroughs, GitHub-native affordances,
comment conventions, one-click fixes, static-analysis bots, coverage/security bots, workflow
ergonomics) cross-referenced against Cortex's current code (~10 agents, ~430k tokens).
**Time-sensitive** — GitHub ships PR-AI features monthly.*

Companion docs: [COMPETITORS.md](COMPETITORS.md) = market positioning / moat;
[PLAN.md](PLAN.md) = the roadmap decisions this analysis drove (Phase 3); this doc = the
feature-by-feature *why*.

## How to read this

- **Status** — ✅ have · 🟡 planned (Phase 4) · ⬜ gap
- **E / I** — Effort / Impact (L/M/H), scoped to *adding it to an in-page extension that
  already has a GitHub REST client + two streaming LLM providers*.

## Bottom line

Cortex is a well-architected human-in-the-loop reviewer copilot whose biggest opportunities
are **not net-new infrastructure but value already latent in its code**. Three structural
facts drive every recommendation below:

1. The background worker already owns a working GitHub REST client (head sha, per-file patch
   with hunk parsing, `createReviewComment`) and both streaming LLM providers.
2. `AskRequest.context` and `AskRequest.history` already exist but are **under-fed** — context
   is only the selected lines + one hunk (no PR title/body/intent), and `history` is plumbed
   through both providers yet never populated.
3. The flagged pain — the AI answer area and the post textarea are **separate**, forcing a
   retype — is fixable by reusing the existing post pipeline, not building anything new.

The highest-leverage moves cluster around **"apply fixes"** and **"orient"**: an
answer→comment bridge and committable `suggestion` blocks (both ride existing post code with
zero new API), PR-context injection (~20 lines over an API call already made), and the
now-shipped PR summary / whole-PR review / severity tags / specialist lenses / test-gap /
threaded follow-ups (all built on existing primitives).

## Top picks — impact-per-effort, ordered

1. **Answer → "Post as comment" bridge** — closes the single biggest friction loop; one
   button reusing `GH_POST_COMMENT → createReviewComment` + the remembered anchor.
2. **PR title/body context injection** — ~20 lines over the `GET /pulls/{n}` call already
   made for the head sha; makes *every* ask and the summary materially smarter.
3. **Conventional Comments picker** — cures "authors read every comment as blocking"; pure
   string composition over the canned-comment tray + insert path already shipped.
4. **Committable `suggestion` blocks** — one-click author fixes via GitHub's native apply, no
   new API (it's just markdown in a line-anchored comment); reuses the selection anchor.
5. **AI PR summary** — the flagship "orient" feature every competitor ships; buildable on
   `listPullFiles` patches + the streaming markdown dock.
6. **Threaded follow-ups** — turns one-shot Q&A into conversation for almost no work;
   `history` already exists and both providers forward it.

## Quick wins (low effort, real value)

- **PR title/body context injection** — `GET /pulls/{n}` is already called; read `pr.title` /
  `pr.body` into the existing `context` + system prompt. No new permission/endpoint/message.
- **Answer → "Post as comment" button** — post pipeline + remembered anchor already exist; the
  dock already holds the rendered answer. One button over the working path.
- **Conventional Comments / Nit-Optional-FYI prefix chips** — canned comments + `insertComment()`
  already exist; label/decoration chips that compose a prefix are pure templating.
- **Review-effort score + severity tags** — extra instructions in the summary/review prompt,
  rendered with the existing icon+label (color-blind-safe) pattern. Near-zero marginal cost.
- **Specialist-lens scoped reviews** — preset buttons that prepend a scoped instruction to the
  system prompt for one turn. Prompt templating over the existing ask path.
- **Conversation-history wiring** — `AskRequest.history` is defined and forwarded; only the
  dock (accumulate turns) and content script (populate on submit) are missing.

---

## The catalog — by reviewer job

### 🧭 Orient — understand the PR before reading the diff

| Feature | Exemplar tools | Status | E/I |
|---|---|---|---|
| AI PR summary / TL;DR (whole-PR walkthrough) | CodeRabbit, Copilot, Qodo `/describe`, Graphite, What The Diff | ✅ | M / High |
| Per-file change map / churn (blast-radius) | CodeRabbit, Qodo `/describe`, GitHub diffstat | ✅ | L / M |
| Impact-by-module rollup (scope at a glance) | CodeRabbit, Graphite | ✅ | L / M |
| LLM dependency / changed-component diagram | CodeBoarding, Graphite | 🟡 | M / M |
| Estimated review-effort score (1–5) | CodeRabbit, Qodo | ✅ | L / M |
| PR title/body/commit context injection | CodeRabbit, Qodo, Greptile, Korbit | ✅ | L / High |

- **AI PR summary** — "Summarize PR" button: fetch all file patches (`listPullFiles`),
  concatenate with budgeting for big PRs, stream a summary into the answer area. No new
  permission or wire protocol. Feed PR title/body in too to ground the "why".
- **Per-file change map / churn (Phase 4a)** — ✅ **shipped:** an **Overview** button renders a
  **deterministic, no-LLM** "PR at a glance" — files changed + additions/deletions/net per file,
  each with a churn bar so the reviewer sees *where the weight is* before reading a line. Built on
  the `listPullFiles` diffstat already fetched; zero tokens, no new dependency.
- **Impact-by-module rollup (Phase 4b)** — ✅ **shipped:** folded into Overview — a multi-module PR
  leads with a **By module** rollup (changed paths grouped by their first up-to-2 directory
  segments) before the per-file detail, so scope reads top-down. Path-only, no LLM, no repo fetch.
- **LLM changed-component diagram (Phase 4c, planned)** — an LLM-emitted **Mermaid** diagram of the
  *changed components* (lazy-loaded, labeled approximate — diff-only grounding can invent edges).
  Adjacent to [CodeBoarding](https://github.com/CodeBoarding/CodeBoarding) (whole-repo architecture
  diagrams): prefer *consuming* its `.codeboarding/` output over reproducing whole-repo analysis
  in-browser.
- **Review-effort score** — bundle into the summary prompt; render a 1–5 badge (icon+label,
  color-blind-safe). Near-zero marginal cost.
- **PR context injection** — the cheapest high-leverage fix in the catalog. `GET /pulls/{n}`
  already returns title + body (called today for the head sha); add `prTitle`/`prBody` to the
  existing `AskRequest.context` + system prompt so the AI can judge *"does this do what the PR
  says?"*, not just local correctness.

### 🐛 Find problems — surface bugs, risks, and gaps

| Feature | Exemplar tools | Status | E/I |
|---|---|---|---|
| Whole-file / whole-PR review (issues across files, not just selection) | CodeRabbit, Greptile, Sourcery, Qodo | ✅ | M / High |
| Severity / priority tags on findings | CodeRabbit, Greptile, Korbit, Qodo, Sourcery | ✅ | L / M |
| Specialist-angle review (security / perf / error-handling) | Sourcery, Bito, Qodo, Ellipsis | ✅ | L / M |
| Test-gap call-out ("this changed code lacks tests") | Qodo, Coveralls, CodeRabbit | ✅ | M / M |

- **Whole-file review** — feed the whole file's patch (not one hunk) and return a findings
  list; the UX win is rendering each finding so it's promotable to a comment in one click
  (see *Apply fixes*). On-demand, not autonomous — where Cortex's identity shines.
- **Severity tags** — structured output from the review/summary prompt: prefix each finding
  with a severity label; render as icon+label badges. Pairs with the review/selection flow.
- **Specialist lenses** — a small row of preset lenses (Security / Performance / Error
  handling / Readability) that prepend a scoped instruction to the system prompt for that
  turn. No new plumbing.
- **Test-gap call-out** — can't compute real coverage in-browser, but the LLM can do a
  heuristic pass: "which changed source files have no matching test-file changes?" (tests
  detected by path: `*.test.*`, `*_test.*`, `spec/`, `__tests__/`). Surface as a summary
  section. An approximation — don't oversell it as coverage.

### 💬 Communicate — write clear, well-labeled comments

| Feature | Exemplar tools | Status | E/I |
|---|---|---|---|
| Conventional Comments label picker (praise/nit/issue/… + blocking/non-blocking) | conventionalcomments.org, Graphite | ✅ | L / High |
| Severity/courtesy prefixes (Nit: / Optional: / Consider: / FYI:) | Google eng-practices | ✅ partial | L / M |
| Code-review emoji legend prefixes (CREG) | Code Review Emoji Guide | ⬜ | L / L |
| Editable/templated canned comments with variables | GitHub saved replies, Graphite | ⬜ | M / M |

- **Conventional Comments picker** — upgrade the tray to a two-axis picker: label chip
  (praise/nit/suggestion/issue/question/thought/chore) + decoration (blocking/non-blocking/
  if-minor) that composes a `label [decoration]:` prefix onto a canned body or the reviewer's
  own text. Highest impact-per-effort communication feature; directly fixes "authors treat
  every comment as blocking".
- **Severity/courtesy prefixes** — `Nit:` already exists as a chip; round out the set with
  `Optional:` / `Consider:` / `FYI:` quick-prefix buttons. A lighter standard for teams that
  find Conventional Comments too heavy.
- **CREG emoji prefixes** — optional toggle that prepends the intent emoji for the chosen
  label (👍 praise, 🔧 needs change, ❓ question, ⛏ nitpick). Emoji = icon+text, on-brand for
  the color-blind-safe ethos. Bundle with the Conventional Comments work.
- **Editable canned comments** — move the hard-coded 10 to `chrome.storage.local` + a small
  options-page editor so reviewers add/edit/reorder their own snippets (GitHub "saved replies",
  but in-page and GitHub-aware). Scales the surface without curating it.

### 🔧 Apply fixes — turn feedback into committed code, minimal round-trips

| Feature | Exemplar tools | Status | E/I |
|---|---|---|---|
| AI answer → posted review comment bridge (one-click promote) | Graphite Chat, CodeRabbit, Qodo | ✅ | L / High |
| GitHub committable `suggestion` blocks | GitHub, CodeRabbit, Qodo, Reviewdog | ✅ | L / High |
| Batch / pending review (accumulate, submit once) | GitHub Reviews API | ⬜ | H / M |
| Review verdict (Approve / Request changes / Comment) | GitHub native | ⬜ | M / L |

- **Answer → comment bridge** — *the* structural gap: answer area and post box are separate,
  so you can't post an answer without retyping. `createReviewComment` is wired end-to-end and
  the last anchor is in memory. Add a "Post as comment" button under the answer that sends the
  rendered text down the existing `GH_POST_COMMENT` path. Almost no new code.
- **Committable `suggestion` blocks** — GitHub renders any triple-backtick `suggestion` block
  in a line-anchored comment as committable; it's just markdown body content, so **no new
  API**. Add a "Suggest a fix" action that asks the model for the replacement lines only,
  wraps them in the fence, and posts via the existing path. Must anchor to the exact lines it
  replaces — reuse the selection anchor already captured.
- **Batch / pending review** — Cortex posts ONE standalone comment today. Batches require the
  Reviews API (`POST /pulls/{n}/reviews` with a `comments[]` array), a pending set in the dock,
  and a submit step. Real value for high-volume reviewers but the heaviest item — defer.
- **Review verdict** — only meaningful once batch/pending exists (the submit takes an
  `event`: APPROVE/REQUEST_CHANGES/COMMENT). Low standalone value for a copilot; treat as a
  rider on batch work, and gate behind explicit user action (it's a real public write).

### 📋 Track coverage & progress — know what's reviewed and what's risky

| Feature | Exemplar tools | Status | E/I |
|---|---|---|---|
| Per-selection threaded follow-ups (conversation history) | CodeRabbit chat, Greptile, Korbit | ✅ | L / High |
| Persist conversation / findings per PR | Reviewable, CodeStream | ✅ | M / M |
| Review-progress / mark-as-viewed tracking | GitHub "Viewed", Gerrit, Reviewable | ⬜ | M / L |
| Export review as markdown / save findings | What The Diff | ⬜ | L / L |

- **Threaded follow-ups** — nearly free: `AskRequest.history` already exists and both
  providers pass it to the model. Only the dock (accumulate turns) and content script
  (populate `history` on submit) are missing.
- **Persist per PR** — ✅ **shipped (3c):** `shared/persistence.ts` stores a per-PR record keyed by
  `repo#prNumber` in `chrome.storage.local` (conversation turns + draft, LRU-capped) and restores
  on mount / PR change. Prerequisite for any future batch-review draft persistence.
- **Mark-as-viewed tracking** — **skip.** GitHub ships per-file "Viewed" with a progress bar
  natively; reimplementing fights GitHub's DOM for low marginal value. The only Cortex-specific
  angle (marking which files *Cortex* AI-reviewed) is better folded into the per-file table.
- **Export as markdown** — once persistence exists, a "Copy/Export markdown" button on the
  answer/summary is trivial. Low impact; bundle with the persistence work.

### 🛡️ Trust & control — keep the reviewer in command, protect sensitive code

| Feature | Exemplar tools | Status | E/I |
|---|---|---|---|
| Sensitive-code / secret redaction before sending to LLM | Bito, Snyk, general DLP | ✅ | M / M |
| Slash / quick commands in the dock (`/summarize`, `/review`, `/security`) | Sourcery, Qodo, Bito, CodeRabbit | ⬜ | L / M |
| Undo / confirm before posting a public write | GitHub pending-review batching | ✅ | L / M |

- **Secret redaction** — ✅ **shipped (3c):** `shared/redact.ts` masks likely secrets in the
  background before the request goes out, across the selection / diff hunk / whole-PR patches,
  with a dock notice when something was redacted. Strengthens the "your key, no third-party SaaS"
  trust story. Scoped to obvious-secret patterns + a conservative high-entropy backstop; not full DLP.
- **Slash commands** — as the dock grows summary/review/lens actions, a lightweight `/`-command
  parser in the existing input unifies buttons and typing. Route prefixes to the same handlers
  as the buttons — no new infra.
- **Confirm / undo before posting** — ✅ **shipped (3c):** *Post to line* now shows a confirm bar
  with the exact target, then a 10s "Undo" that deletes the just-created comment
  (`DELETE /pulls/comments/{id}`) — plus a Refresh, since GitHub's SPA won't render an API-posted
  comment inline. Serves the human-in-the-loop identity and guards against misfires. (See Safety in CLAUDE.md.)

---

## Cortex today — have / planned / not present

> **Updated 2026-06-11 — Phase 3a shipped:** the answer→comment bridge, PR-intent grounding,
> committable `suggestion` blocks (+ multi-line anchoring), the Conventional Comments picker,
> and threaded follow-ups are now **implemented** and verified (see [PLAN.md](PLAN.md) ·
> [CHANGELOG.md](CHANGELOG.md)). The "Top picks" / "Quick wins" above were written before that
> and list these as to-build; the lists below reflect current state. **Phase 3a (#1–5) is
> complete.**

**Already has:** highlight-and-ask (streamed markdown via Anthropic API or Claude Code CLI);
dock with answer area, input, canned-comment tray, file:line chip; 10 canned snippets;
line-anchored comment posting via PAT (single- or multi-line); GitHub API client (head sha,
PR title/body, file/patch list, hunk parser); selection capture (file/line/side/code/language);
options page (provider, key, model, PAT); both backends; streaming + abort; adaptive light/dark
theming; actionable error states; loading states; color-blind-safe UI; `install.sh`; docs.
**Phase 3a:** answer→**Use as comment** / Copy bridge; PR-intent (title/body) grounding;
committable `suggestion` blocks via **Suggest a fix**; Conventional Comments label + decoration
picker; threaded follow-ups (conversation `history` + **New thread**); dock collapses to a
launcher button → full-width panel.

**Phase 3b:** AI PR summary (TL;DR · key changes · per-file gloss · review-effort 1–5);
whole-PR **review** (severity-tagged findings list); **specialist lenses** (security / perf /
errors / readability); deterministic **test-gap** check.

**Phase 3c (persistence & trust):** persist conversation + draft per PR (`repo#prNumber`,
`chrome.storage.local`, LRU-capped); confirm + 10s Undo before posting (+ a Refresh, since
GitHub's SPA won't render an API-posted comment inline); secret redaction before the request
leaves the browser. *(Later: GitLab/Bitbucket, Web Store packaging, Windows native-host script.)*

**Not present:** batch/pending review; review verdict; slash commands; export markdown;
comment threading/replies; editable templates.

## What we deliberately won't build

- **Autonomous auto-review (bot mode)** — against Cortex's human-in-the-loop identity.
- **Mark-as-viewed / file-progress tracking** — GitHub owns this natively; don't fight its DOM.
- **Batch/pending review + verdict** — *not* a "won't", but deferred: it needs the Reviews API
  migration and should wait until the single-post and answer→comment flows are solid.

## Methodology

Eight parallel research agents each surveyed one cluster of the code-review tooling space with
live web search/fetch (real product docs, not memory); one agent grounded the findings against
Cortex's actual source (`dock-panel.ts`, `comments.ts`, `selection.ts`, `github/api.ts`,
`PLAN.md`, `DESIGN.md`, `COMPETITORS.md`); a synthesis agent mapped every feature to the
reviewer job it serves, Cortex's status, and an effort/impact read. Like
[COMPETITORS.md](COMPETITORS.md), this is **time-sensitive** — GitHub's overlap widens monthly;
re-verify before acting on anything dated.
