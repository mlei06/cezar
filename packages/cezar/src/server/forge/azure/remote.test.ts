import { describe, expect, it } from 'vitest';
import { azureProjectRoot, azureWebRoot, parseAzureRemote } from './remote.ts';

const want = { host: 'dev.azure.com', org: 'acme', project: 'Shop App', repo: 'web' };

describe('parseAzureRemote (spec 2026-11-24-azure-repos-forge-driver)', () => {
  it.each([
    'https://dev.azure.com/acme/Shop%20App/_git/web',
    'https://acme@dev.azure.com/acme/Shop%20App/_git/web',
    'https://user:secret@dev.azure.com/acme/Shop%20App/_git/web/',
    'https://dev.azure.com/acme/Shop%20App/_git/web.git',
    'git@ssh.dev.azure.com:v3/acme/Shop%20App/web',
    'ssh://git@ssh.dev.azure.com/v3/acme/Shop%20App/web',
    'https://acme.visualstudio.com/Shop%20App/_git/web',
    'https://acme.visualstudio.com/DefaultCollection/Shop%20App/_git/web',
    'acme@vs-ssh.visualstudio.com:v3/acme/Shop%20App/web',
  ])('reads %s', (remote) => {
    expect(parseAzureRemote(remote)).toEqual(want);
  });

  it.each([
    'https://github.com/acme/web.git',
    'git@github.com:acme/web.git',
    'https://gitlab.com/acme/web.git',
    'https://tfs.example.test/tfs/Collection/Project/_git/web', // Azure DevOps Server: out of scope
    '/home/me/web',
    '',
    undefined,
  ])('leaves %s alone', (remote) => {
    expect(parseAzureRemote(remote)).toBeNull();
  });

  it('rebuilds web roots from the parts, so a credential in the remote never leaks', () => {
    const parsed = parseAzureRemote('https://user:secret@dev.azure.com/acme/Shop%20App/_git/web')!;
    expect(azureWebRoot(parsed)).toBe('https://dev.azure.com/acme/Shop%20App/_git/web');
    expect(azureProjectRoot(parsed)).toBe('https://dev.azure.com/acme/Shop%20App');
  });
});
