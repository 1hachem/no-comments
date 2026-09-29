# No Comments

Fail CI on comments in TypeScript, TSX, Astro and CSS — and optionally post the fix as
review suggestions the author can click to accept.

Built for codebases that treat the code as the only source of truth: if a constraint is
real it belongs in a name, a type or a test, where it cannot drift out of date.

```yaml
- uses: actions/checkout@v4
- uses: 1hachem/no-comments@v1
```

## Why an AST and not a grep

`//` inside a string is not a comment. This action parses `.ts`/`.tsx` with the
TypeScript compiler and walks `.css` and Astro markup with real scanners, so none of
these are reported:

```ts
const d = '// not a comment';
```
```css
.b { content: "/* not a comment */"; }
```
```astro
<div title="<!-- not a comment -->">
```

## Modes

**Check** (default) — lists offenders as `path:line` and fails the step. With
`annotations` on, each one also shows up inline on the diff.

**Suggest** — computes the removal in memory and posts it as a single batched review of
```suggestion blocks. Nothing is committed; the author accepts or dismisses each one.

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v4
  - uses: 1hachem/no-comments@v1
    with:
      suggest: true
```

**Fix** — strips the comments in place. Useful in a scheduled cleanup job that opens its
own PR. Mutually exclusive with `suggest`. Run your formatter afterwards to reflow.

## Inputs

| Input | Default | Description |
|---|---|---|
| `extensions` | `*.ts *.tsx *.astro *.css` | Space separated git pathspecs to scan. |
| `ignore` | `''` | Newline or comma separated regexes; a tracked path matching any is skipped. |
| `allow` | `''` | Regexes matched against a comment; a hit is permitted. Added to the built-in directives. |
| `fix` | `false` | Strip comments in place. |
| `suggest` | `false` | Post review suggestions instead. Needs `pull-requests: write`. |
| `token` | `${{ github.token }}` | Token used to post suggestions. |
| `annotations` | `true` | Emit `::error` annotations. |
| `fail-on-violations` | `true` | Set `false` to adopt the check in warn-only mode. |
| `working-directory` | `.` | Directory to run from. |

## Outputs

| Output | Description |
|---|---|
| `violations` | Number of comments found. |
| `files` | Number of files scanned. |
| `suggestions` | Number of review suggestions posted. |

## Allowed by default

Tooling directives are not prose, so these pass untouched:

`/// <reference`, `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `@vitest-environment`,
`@vite-ignore`, `#__PURE__`, `prettier-ignore` (line, block and HTML), `biome-ignore`,
`eslint-disable`.

Add your own with `allow`:

```yaml
with:
  allow: |
    ^//\s*@boundaries-ignore\b
    ^//\s*oxlint-disable
```

## Notes on `suggest`

- **Only lines in the PR diff can carry a suggestion.** A comment in a file the PR does
  not touch still fails the step and still gets an annotation, but GitHub has nowhere to
  anchor a suggestion to it. The action warns with a count when that happens.
- **Re-runs do not duplicate.** Suggestions carry a marker and already-posted ones at the
  same path and line range are skipped.
- **Only `pull_request` events.** On anything else the action warns once and degrades to
  a plain check.
- **Posting failures are never fatal to the result.** A 403 or a rate limit logs a
  warning; the violation count still decides the exit code.
- **Forks.** A `pull_request` run from a fork gets a read-only token, so suggestions are
  skipped and only annotations appear. `pull_request_target` would supply a writable
  token, but it runs the workflow from the base branch while this action must read the
  PR's code — a privileged checkout of untrusted code. Prefer `pull_request` and accept
  annotations-only on fork PRs.
- **`GITHUB_TOKEN` is read-only in many orgs.** Set `permissions: pull-requests: write`
  explicitly, or the 403 is the first thing you will hit.

## Known limits

- Only tracked files are scanned — it runs `git ls-files`, so `actions/checkout` must run
  first.
- GitHub renders at most 10 annotations of a level per step. The full list is always in
  the step log.
- `.astro` markup is scanned with hand-written scanners rather than the Astro compiler.
  Frontmatter, `<script>` and `<style>` bodies go through real parsers; `is:raw` blocks
  and `type="*json*"` scripts are skipped.

## Licence

MIT
