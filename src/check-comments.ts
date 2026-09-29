import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const DEFAULT_DIRECTIVES = [
	/^\/\/\/\s*<reference/,
	/^\/\/\s*@ts-(expect-error|ignore|nocheck)\b/,
	/^\/\/\s*@vitest-environment\b/,
	/^\/\*\s*@vite-ignore/,
	/^\/\/\s*#__PURE__/,
	/^\/\/\s*prettier-ignore\b/,
	/^\/\*\s*prettier-ignore/,
	/^<!--\s*prettier-ignore/,
	/^\/\/\s*biome-ignore\b/,
	/^\/\*\s*eslint-disable/,
	/^\/\/\s*eslint-disable/,
];

const MARKER = '<!-- check-comments -->';

export interface Found {
	pos: number;
	end: number;
	line: number;
	text: string;
	jsx?: { pos: number; end: number };
}

export interface Cut {
	pos: number;
	end: number;
}

export interface Suggestion {
	path: string;
	startLine: number;
	endLine: number;
	body: string;
}

function input(name: string): string {
	const key = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
	return (process.env[key] ?? '').trim();
}

function bool(name: string, fallback: boolean): boolean {
	const raw = input(name).toLowerCase();
	if (raw === '') return fallback;
	return raw === 'true' || raw === '1' || raw === 'yes';
}

function list(name: string): string[] {
	return input(name)
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function patterns(name: string): RegExp[] {
	return list(name).map((s) => {
		try {
			return new RegExp(s);
		} catch {
			throw new Error(`Input \`${name}\` holds an invalid regular expression: ${s}`);
		}
	});
}

export function tracked(globs: string[], ignored: RegExp[]): string[] {
	const out = execFileSync('git', ['ls-files', ...globs], { encoding: 'utf8' });
	return out
		.split('\n')
		.filter(Boolean)
		.filter(existsSync)
		.filter((f) => !ignored.some((re) => re.test(f)));
}

function findScriptComments(code: string, kind: ts.ScriptKind, offset: number): Found[] {
	const sf = ts.createSourceFile('x', code, ts.ScriptTarget.ESNext, true, kind);

	const ranges = new Map<string, ts.CommentRange>();
	const emptyJsx: { pos: number; end: number }[] = [];

	const add = (rs: ts.CommentRange[] | undefined) => {
		if (rs) for (const r of rs) ranges.set(`${r.pos}:${r.end}`, r);
	};

	const walk = (node: ts.Node): void => {
		if (ts.isJsxExpression(node) && node.expression === undefined) {
			emptyJsx.push({ pos: node.getFullStart() + offset, end: node.end + offset });
		}
		const kids = node.getChildren(sf);
		if (kids.length === 0) {
			add(ts.getLeadingCommentRanges(code, node.pos));
			add(ts.getTrailingCommentRanges(code, node.end));
		}
		for (const kid of kids) walk(kid);
	};
	walk(sf);

	return [...ranges.values()]
		.sort((a, b) => a.pos - b.pos)
		.map((r) => {
			const pos = r.pos + offset;
			const end = r.end + offset;
			return {
				pos,
				end,
				line: 0,
				text: code.slice(r.pos, r.end),
				jsx: emptyJsx.find((j) => pos >= j.pos && end <= j.end),
			};
		});
}

function findPattern(text: string, re: RegExp, offset: number): Found[] {
	const found: Found[] = [];
	for (const m of text.matchAll(re)) {
		found.push({
			pos: m.index + offset,
			end: m.index + m[0].length + offset,
			line: 0,
			text: m[0],
		});
	}
	return found;
}

export function findCssComments(text: string, offset: number): Found[] {
	const found: Found[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"' || c === "'") {
			i++;
			while (i < text.length && text[i] !== c) {
				if (text[i] === '\\') i++;
				i++;
			}
			i++;
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const start = i;
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i = Math.min(i + 2, text.length);
			found.push({ pos: start + offset, end: i + offset, line: 0, text: text.slice(start, i) });
			continue;
		}
		i++;
	}
	return found;
}

export function findMarkupComments(text: string, offset: number): Found[] {
	const found: Found[] = [];
	let i = 0;
	while (i < text.length) {
		if (text.startsWith('<!--', i)) {
			const start = i;
			const close = text.indexOf('-->', i + 4);
			i = close === -1 ? text.length : close + 3;
			found.push({ pos: start + offset, end: i + offset, line: 0, text: text.slice(start, i) });
			continue;
		}
		if (text[i] === '<') {
			i++;
			while (i < text.length && text[i] !== '>') {
				const q = text[i];
				if (q === '"' || q === "'") {
					i++;
					while (i < text.length && text[i] !== q) i++;
				}
				i++;
			}
			i++;
			continue;
		}
		i++;
	}
	return found;
}

const EMBEDDED = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const JSX_COMMENT = /\{\s*\/\*[\s\S]*?\*\/\s*\}/g;

function findAstroComments(text: string): Found[] {
	const found: Found[] = [];
	let templateAt = 0;

	if (/^---[^\n]*\n/.test(text)) {
		const open = text.indexOf('\n') + 1;
		const close = text.indexOf('\n---', open);
		if (close !== -1) {
			found.push(...findScriptComments(text.slice(open, close), ts.ScriptKind.TS, open));
			templateAt = text.indexOf('\n', close + 1) + 1 || text.length;
		}
	}

	const markup: { start: number; end: number }[] = [];
	let cursor = templateAt;
	for (const m of text.slice(templateAt).matchAll(EMBEDDED)) {
		const at = templateAt + m.index;
		const inner = at + m[0].indexOf('>') + 1;
		markup.push({ start: cursor, end: at });
		cursor = at + m[0].length;

		const attrs = m[2] ?? '';
		const body = m[3] ?? '';
		if (/\bis:raw\b/i.test(attrs)) continue;
		if (m[1]?.toLowerCase() === 'style') {
			found.push(...findCssComments(body, inner));
		} else if (!/type\s*=\s*['"][^'"]*json/i.test(attrs)) {
			found.push(...findScriptComments(body, ts.ScriptKind.TS, inner));
		}
	}
	markup.push({ start: cursor, end: text.length });

	for (const { start, end } of markup) {
		const slice = text.slice(start, end);
		found.push(...findMarkupComments(slice, start));
		found.push(...findPattern(slice, JSX_COMMENT, start));
	}

	return found.sort((a, b) => a.pos - b.pos);
}

export function findComments(text: string, fileName: string, allowed: RegExp[]): Found[] {
	const raw = fileName.endsWith('.astro')
		? findAstroComments(text)
		: fileName.endsWith('.css')
			? findCssComments(text, 0)
			: findScriptComments(
					text,
					fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
					0,
				);

	const seen = new Set<string>();
	return raw
		.filter((f) => !allowed.some((re) => re.test(f.text)))
		.filter((f) => {
			const key = `${f.pos}:${f.end}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((f) => ({
			...f,
			line: text.slice(0, f.pos).split('\n').length,
			text: f.text.split('\n')[0]?.trim() ?? '',
		}));
}

export function plan(text: string, found: Found[]): Cut[] {
	const cuts = found.map((f) => {
		const at = f.jsx ?? f;
		let start = at.pos;
		while (start > 0 && text[start - 1] !== '\n') start--;
		const aloneBefore = text.slice(start, at.pos).trim() === '';
		let stop = at.end;
		while (stop < text.length && text[stop] !== '\n') stop++;
		const aloneAfter = text.slice(at.end, stop).trim() === '';
		if (aloneBefore && aloneAfter) return { pos: start, end: Math.min(stop + 1, text.length) };
		if (aloneAfter) return { pos: at.pos, end: stop };
		return { pos: at.pos, end: at.end };
	});

	cuts.sort((a, b) => a.pos - b.pos);
	const merged: Cut[] = [];
	for (const c of cuts) {
		const last = merged[merged.length - 1];
		if (last && c.pos <= last.end) last.end = Math.max(last.end, c.end);
		else merged.push({ ...c });
	}
	return merged;
}

export function strip(text: string, found: Found[]): string {
	const merged = plan(text, found);
	let out = text;
	for (let i = merged.length - 1; i >= 0; i--) {
		const c = merged[i];
		if (c) out = out.slice(0, c.pos) + out.slice(c.end);
	}
	return out.replace(/[ \t]+$/gm, '');
}

export function suggestions(text: string, found: Found[], path: string): Suggestion[] {
	const merged = plan(text, found);
	if (merged.length === 0) return [];

	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
	const lineOf = (pos: number): number => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if ((starts[mid] as number) <= pos) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const endOfLine = (idx: number): number => {
		const next = starts[idx + 1];
		return next === undefined ? text.length : next - 1;
	};

	const groups: { from: number; to: number; cuts: Cut[] }[] = [];
	for (const c of merged) {
		const from = lineOf(c.pos);
		const to = lineOf(Math.max(c.pos, c.end - 1));
		const last = groups[groups.length - 1];
		if (last && from <= last.to) {
			last.to = Math.max(last.to, to);
			last.cuts.push(c);
		} else {
			groups.push({ from, to, cuts: [c] });
		}
	}

	return groups.map((g) => {
		const s = starts[g.from] as number;
		const e = endOfLine(g.to);
		let out = text.slice(s, e);
		for (let i = g.cuts.length - 1; i >= 0; i--) {
			const c = g.cuts[i] as Cut;
			const a = Math.max(c.pos, s) - s;
			const b = Math.min(c.end, e) - s;
			if (b > a) out = out.slice(0, a) + out.slice(b);
		}
		return {
			path,
			startLine: g.from + 1,
			endLine: g.to + 1,
			body: out.replace(/[ \t]+$/gm, ''),
		};
	});
}

function escapeData(s: string): string {
	return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProp(s: string): string {
	return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function annotate(file: string, line: number, message: string): void {
	const head = `::error file=${escapeProp(file)},line=${line},title=Comment`;
	process.stdout.write(`${head}::${escapeData(message)}\n`);
}

function setOutput(name: string, value: string | number): void {
	const target = process.env.GITHUB_OUTPUT;
	if (target) appendFileSync(target, `${name}<<__EOF__\n${value}\n__EOF__\n`);
}

function warn(message: string): void {
	process.stdout.write(`::warning::${escapeData(message)}\n`);
}

interface Pull {
	owner: string;
	repo: string;
	number: number;
	sha?: string;
}

function pullRequest(): Pull | undefined {
	const path = process.env.GITHUB_EVENT_PATH;
	const slug = process.env.GITHUB_REPOSITORY ?? '';
	if (!path || !existsSync(path) || !slug.includes('/')) return undefined;
	const payload = JSON.parse(readFileSync(path, 'utf8'));
	const pr = payload.pull_request;
	if (!pr?.number) return undefined;
	const [owner, repo] = slug.split('/') as [string, string];
	return { owner, repo, number: pr.number, sha: pr.head?.sha };
}

function apiBase(): string {
	return process.env.GITHUB_API_URL ?? 'https://api.github.com';
}

async function api(token: string, url: string, init?: RequestInit): Promise<Response> {
	return fetch(url.startsWith('http') ? url : `${apiBase()}${url}`, {
		...init,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'x-github-api-version': '2022-11-28',
			'content-type': 'application/json',
			...(init?.headers ?? {}),
		},
	});
}

async function paged(token: string, url: string): Promise<unknown[]> {
	const items: unknown[] = [];
	let next: string | undefined = `${url}?per_page=100`;
	while (next) {
		const res: Response = await api(token, next);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${next}`);
		items.push(...((await res.json()) as unknown[]));
		const link = res.headers.get('link') ?? '';
		next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
	}
	return items;
}

export function diffLines(patch: string): Set<number> {
	const lines = new Set<number>();
	let right = 0;
	for (const row of patch.split('\n')) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
		if (hunk) {
			right = Number(hunk[1]);
			continue;
		}
		if (right === 0) continue;
		if (row.startsWith('+') || row.startsWith(' ')) {
			lines.add(right);
			right++;
		}
	}
	return lines;
}

async function postSuggestions(token: string, pr: Pull, all: Suggestion[]): Promise<number> {
	const files = (await paged(token, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files`)) as {
		filename: string;
		patch?: string;
	}[];
	const touched = new Map<string, Set<number>>();
	for (const f of files) if (f.patch) touched.set(f.filename, diffLines(f.patch));

	const existing = (await paged(
		token,
		`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`,
	)) as { path: string; line?: number; start_line?: number; body: string }[];
	const already = new Set(
		existing
			.filter((c) => c.body.includes(MARKER))
			.map((c) => `${c.path}:${c.start_line ?? c.line}:${c.line}`),
	);

	const comments: Record<string, unknown>[] = [];
	let unreachable = 0;
	for (const s of all) {
		const lines = touched.get(s.path);
		let postable = lines !== undefined;
		if (lines) {
			for (let l = s.startLine; l <= s.endLine; l++) if (!lines.has(l)) postable = false;
		}
		if (!postable) {
			unreachable++;
			continue;
		}
		if (already.has(`${s.path}:${s.startLine}:${s.endLine}`)) continue;

		const fence = `\`\`\`suggestion\n${s.body === '' ? '' : `${s.body}\n`}\`\`\``;
		const comment: Record<string, unknown> = {
			path: s.path,
			line: s.endLine,
			side: 'RIGHT',
			body: `${MARKER}\n${fence}`,
		};
		if (s.startLine !== s.endLine) {
			comment.start_line = s.startLine;
			comment.start_side = 'RIGHT';
		}
		comments.push(comment);
	}

	if (unreachable > 0) {
		const subject = unreachable === 1 ? '1 comment sits' : `${unreachable} comments sit`;
		warn(
			`${subject} outside this pull request's diff, so no suggestion could be attached. Reported as annotations instead.`,
		);
	}
	if (comments.length === 0) return 0;

	const res = await api(token, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, {
		method: 'POST',
		body: JSON.stringify({
			...(pr.sha ? { commit_id: pr.sha } : {}),
			event: 'COMMENT',
			body: 'This repository keeps no comments in its code. Each suggestion below removes one.',
			comments,
		}),
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
	return comments.length;
}

async function main(): Promise<void> {
	const dir = input('working-directory');
	if (dir && dir !== '.') process.chdir(dir);

	const globs = (input('extensions') || '*.ts *.tsx *.astro *.css').split(/\s+/).filter(Boolean);
	const ignored = patterns('ignore');
	const allowed = [...DEFAULT_DIRECTIVES, ...patterns('allow')];
	const fix = bool('fix', false);
	const wantSuggest = bool('suggest', false);
	const annotations = bool('annotations', true);
	const failOnViolations = bool('fail-on-violations', true);
	const token = input('token');

	if (fix && wantSuggest) {
		process.stderr.write('Inputs `fix` and `suggest` are mutually exclusive; pick one.\n');
		process.exit(2);
	}

	const pr = pullRequest();
	let suggest = wantSuggest;
	if (suggest && !pr) {
		warn('`suggest` only works on pull_request events; falling back to a plain check.');
		suggest = false;
	}
	if (suggest && !token) {
		warn('`suggest` needs a token with `pull-requests: write`; falling back to a plain check.');
		suggest = false;
	}

	const files = tracked(globs, ignored);
	const offenders: { file: string; found: Found[] }[] = [];
	const proposed: Suggestion[] = [];

	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		const found = findComments(text, file, allowed);
		if (found.length === 0) continue;
		offenders.push({ file, found });
		if (fix) writeFileSync(file, strip(text, found));
		if (suggest) proposed.push(...suggestions(text, found, file));
	}

	const total = offenders.reduce((n, o) => n + o.found.length, 0);
	setOutput('files', files.length);
	setOutput('violations', total);
	setOutput('suggestions', 0);

	if (total === 0) {
		process.stdout.write(`No comments in ${files.length} files.\n`);
		return;
	}

	if (fix) {
		process.stdout.write(`Removed ${total} comments from ${offenders.length} files.\n`);
		process.stdout.write('Run your formatter to reflow, then review the diff.\n');
		return;
	}

	for (const { file, found } of offenders) {
		for (const f of found) {
			const excerpt = f.text.length > 70 ? `${f.text.slice(0, 70)}…` : f.text;
			process.stderr.write(`${file}:${f.line}  ${excerpt}\n`);
			if (annotations) annotate(file, f.line, excerpt);
		}
	}

	if (suggest && pr) {
		try {
			const posted = await postSuggestions(token, pr, proposed);
			setOutput('suggestions', posted);
			process.stdout.write(`Posted ${posted} suggestion${posted === 1 ? '' : 's'}.\n`);
		} catch (err) {
			warn(`Could not post suggestions: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const plural = total === 1 ? '' : 's';
	const filePlural = offenders.length === 1 ? '' : 's';
	process.stderr.write('\n');
	process.stderr.write(`${total} comment${plural} in ${offenders.length} file${filePlural}.\n`);
	process.stderr.write('\n');
	process.stderr.write("This repo's code carries no comments, and keeps no design notes\n");
	process.stderr.write('to move one to. If one of these states a real constraint, put it in\n');
	process.stderr.write('a name, a type or a test; otherwise re-run this action with\n');
	process.stderr.write('`fix: true` to strip them, or `suggest: true` to review them inline.\n');

	if (failOnViolations) process.exit(1);
}

if (process.env.CHECK_COMMENTS_LIB !== '1') {
	main().catch((err) => {
		process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
		process.exit(2);
	});
}
