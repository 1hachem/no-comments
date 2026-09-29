// a leading comment
export const a = 1;

/* a block comment */
export function b(): string {
	const url = 'https://example.com'; // a trailing comment
	return url;
}

// @ts-expect-error intentional
export const c: number = 'nope';

/// <reference types="node" />
export const d = '// not a comment';
