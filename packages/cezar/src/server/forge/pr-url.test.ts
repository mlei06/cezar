import { describe, expect, it } from 'vitest';
import { githubPrIdentity } from './pr-url.ts';

describe('githubPrIdentity', () => {
  it('names host, repository and number, case-insensitively', () => {
    expect(githubPrIdentity('https://GitHub.com/Acme/Demo/pull/41/')).toBe('github.com/acme/demo#41');
    expect(githubPrIdentity('https://ghe.example.internal/acme/demo/pull/41?x=1')).toBe('ghe.example.internal/acme/demo#41');
  });

  it('tells apart the same number in another repository or host', () => {
    const id = githubPrIdentity('https://github.com/acme/demo/pull/41');
    expect(githubPrIdentity('https://github.com/acme/other/pull/41')).not.toBe(id);
    expect(githubPrIdentity('https://ghe.example.internal/acme/demo/pull/41')).not.toBe(id);
  });

  it('is undefined for anything that is not a GitHub PR URL', () => {
    for (const url of [undefined, null, '', 'https://github.com/acme/demo/issues/41', 'https://dev.azure.com/o/p/_git/r/pullrequest/41']) {
      expect(githubPrIdentity(url)).toBeUndefined();
    }
  });
});
