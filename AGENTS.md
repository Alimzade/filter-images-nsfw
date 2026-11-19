# Project Mandates

## Security & Privacy
- All AI inference MUST be performed locally in the browser using ONNX Runtime Web.
- No image data should ever be sent to external servers.

## Engineering Standards
- **Zero-Flash Policy:** All images MUST be blurred by default via manifest-level CSS injection at `document_start`. 
- Do not use JavaScript-based style injection for the initial blur, as it causes a "flash of unblurred content" (FOUC).
- Use `public/blur.css`, declared under `content_scripts` in `manifest.json`, for the global protection layer.
- The extension is plain Manifest V3 JavaScript with no build step or package manager. Do not add a bundler or framework without an ADR (see `docs/decisions/0001-migration-to-vanilla-mv3.md`).
- The development browser is Microsoft Edge: load the repo folder unpacked from `edge://extensions`.

## Output Standards
- **Clean Copy-Paste:** NEVER include line numbers in code blocks or terminal commands. All output must be directly copy-pasteable without modification.

## Speed & Action-First Workflow
- Apply requested code changes and bug fixes directly in the first response without multi-turn approval prompts.
- Only pause for explicit user approval when proposing changes that weaken a privacy or safety guarantee: sending any data off-device, adding permissions or host permissions, or changing the default blur and fail-safe behavior.
- For new, ambiguous, or open-ended feature requests where the intent could point in more than one direction, ask 1-2 targeted clarifying questions before implementing (grill-me style). Skip this for straightforward bug fixes, small edits, or requests that already name the exact change wanted.
- Consult documentation (`docs/`) and skills on-demand when needed for context or complex features, rather than reading full directories before simple edits.

## Skills
- If a local `.agent/skills` folder exists (it is gitignored and not part of the repo), use the skills in it whenever they fit the task.

## Documentation
Keep documentation synchronized with live code contracts on every completed task:
- If not exists, create as described here.
- Index Anchor: Consult `docs/README.md` to identify topic ownership before making updates.
- Features & Routes: Update `README.md` and the relevant domain file in `docs/` whenever adding or modifying endpoints, components, or user workflows.
- Technical Rigor: Ensure exact limits, test counts, model identifiers, and schema types in docs match the live codebase with zero stale placeholders.
- Architectural Decisions: Record significant technical choices as numbered ADRs in `docs/decisions/`, following the format of the existing records (or the `documentation-and-adrs` skill if available).
- Pre-Commit Synchronization: Verify documentation is updated before formulating git commits.

## Punctuation & Style
- Do NOT use em dashes (long dash character) anywhere in documentation, code, comments, commit messages, or responses.

## Communication
- Be direct, plain-spoken, and concise. No fluff, no boilerplate, no over-explaining.
- State the exact technical reason in 1-2 direct sentences.

## Git Commit & Push Workflow
- Only provide commit commands when explicitly asked by the user.
- MANDATORY STEP 1: Inspect repository state via a single `git status -s`. NEVER guess commit messages from memory. Do not run redundant diff or log commands.
- Execute git commands directly ONLY when explicitly instructed by the user (e.g. "do it", "commit now", "go", "commit"); otherwise provide them as copyable text.
- Automatically run `git push` immediately after committing when instructed to commit.
- Do NOT include `Co-Authored-By` lines.
- Do NOT use heredoc/EOF syntax.
- Use `git add`, `git commit`, and `git push` as separate commands.
- Format: `git commit -m "subject" -m "- bullet"`, with each further bullet on a new line inside the second quoted string. Git stores a typed `\n` as literal text, not a line break.
- Subject: imperative mood, lowercase start, no period.
