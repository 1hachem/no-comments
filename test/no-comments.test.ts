import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	diffLines,
	findComments,
	strip,
	suggestions,
	type Suggestion,
} from '../src/no-comments.ts';

const DIRECTIVES = [
	/^\/\/\/\s*<reference/,
	/^\/\/\s*@ts-(expect-error|ignore|nocheck)\b/,
	/^\/\*\s*prettier-ignore/,
];

const fixture = (name: string): string =>
	readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

const linesOf = (name: string): number[] => {
	const text = fixture(name);
	return findComments(text, name, DIRECTIVES).map((f) => f.line);
};

const apply = (text: string, found: Suggestion[]): string => {
	const lines = text.split('\n');
	const out: string[] = [];
	let i = 0;
	for (const s of [...found].sort((a, b) => a.startLine - b.startLine)) {
		while (i < s.startLine - 1) out.push(lines[i++] as string);
		if (s.body !== '') out.push(...s.body.split('\n'));
		i = s.endLine;
	}
	while (i < lines.length) out.push(lines[i++] as string);
	return out.join('\n');
};

test('typescript: finds comments and honours directives', () => {
	assert.deepEqual(linesOf('plain.ts'), [1, 4, 6]);
});

test('typescript: a comment marker inside a string is not a comment', () => {
	const found = findComments(fixture('plain.ts'), 'plain.ts', DIRECTIVES);
	assert.ok(found.every((f) => !f.text.includes('not a comment')));
});

test('tsx: an empty jsx expression wrapper is reported once', () => {
	assert.deepEqual(linesOf('widget.tsx'), [4]);
});

test('css: skips comment markers inside string literals', () => {
	assert.deepEqual(linesOf('styles.css'), [2, 5]);
});

test('astro: covers frontmatter, markup, style and script, but not is:raw or json', () => {
	assert.deepEqual(linesOf('page.astro'), [2, 3, 7, 9, 15, 20]);
});

test('astro: a comment inside an attribute value is not a comment', () => {
	const found = findComments(fixture('page.astro'), 'page.astro', DIRECTIVES);
	assert.ok(found.every((f) => !f.text.includes('not a comment')));
});

for (const name of ['plain.ts', 'widget.tsx', 'styles.css', 'page.astro']) {
	test(`suggest: applying every suggestion reproduces strip (${name})`, () => {
		const text = fixture(name);
		const found = findComments(text, name, DIRECTIVES);
		assert.equal(apply(text, suggestions(text, found, name)), strip(text, found));
	});
}

test('suggest: a comment alone on its line becomes an empty suggestion', () => {
	const text = fixture('plain.ts');
	const found = findComments(text, 'plain.ts', DIRECTIVES);
	const first = suggestions(text, found, 'plain.ts')[0] as Suggestion;
	assert.equal(first.startLine, 1);
	assert.equal(first.endLine, 1);
	assert.equal(first.body, '');
});

test('suggest: a trailing comment keeps the surviving code', () => {
	const text = fixture('styles.css');
	const found = findComments(text, 'styles.css', DIRECTIVES);
	const trailing = suggestions(text, found, 'styles.css').find((s) => s.startLine === 2);
	assert.equal(trailing?.body, '\tcolor: red;');
});

test('suggest: the jsx wrapper is removed whole, leaving no empty braces', () => {
	const text = fixture('widget.tsx');
	const found = findComments(text, 'widget.tsx', DIRECTIVES);
	assert.equal(strip(text, found).includes('{}'), false);
	assert.deepEqual(
		suggestions(text, found, 'widget.tsx').map((s) => s.body),
		[''],
	);
});

test('diffLines: maps a patch to its right-hand line numbers', () => {
	const patch = ['@@ -1,3 +1,4 @@', ' keep', '-gone', '+added', '+more', ' tail'].join('\n');
	assert.deepEqual([...diffLines(patch)], [1, 2, 3, 4]);
});

test('diffLines: handles several hunks', () => {
	const patch = ['@@ -1,1 +1,1 @@', ' a', '@@ -10,1 +20,2 @@', '+b', ' c'].join('\n');
	assert.deepEqual([...diffLines(patch)], [1, 20, 21]);
});
