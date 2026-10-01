import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isManagedClone,
  findCodeBearingPaths,
  assertTrustedRepo,
  isUnsafeEnvName,
  UntrustedRepoError,
} from './untrusted-repo';

describe('untrusted-repo', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'archon-untrusted-'));
    prevHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('treats only paths under workspaces, outside _folder, as managed clones', () => {
    expect(isManagedClone(join(home, 'workspaces', 'acme', 'tool', 'source'))).toBe(true);
    expect(isManagedClone(join(home, 'workspaces'))).toBe(false);
    expect(isManagedClone(join(home, 'workspaces', '_folder', 'notes'))).toBe(false);
    expect(isManagedClone('/srv/my-own-repo')).toBe(false);
    expect(isManagedClone(join(home, 'workspaces-evil', 'x'))).toBe(false);
  });

  it('finds .claude, .mcp.json and .archon, symlinks included', async () => {
    const root = join(home, 'repo');
    await mkdir(join(root, '.claude', 'agents'), { recursive: true });
    await writeFile(join(root, '.mcp.json'), '{}');
    await symlink('/nonexistent', join(root, '.archon'));
    expect((await findCodeBearingPaths(root)).sort()).toEqual(['.archon', '.claude', '.mcp.json']);
  });

  it('refuses a managed clone that carries a code-bearing path in any root', async () => {
    const source = join(home, 'workspaces', 'acme', 'tool', 'source');
    const worktree = join(home, 'workspaces', 'acme', 'tool', 'worktrees', 'w1');
    await mkdir(source, { recursive: true });
    await mkdir(join(worktree, '.archon', 'workflows'), { recursive: true });
    await assertTrustedRepo(source, [source]);
    const err = await assertTrustedRepo(source, [source, worktree]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UntrustedRepoError);
    expect((err as UntrustedRepoError).found).toEqual(['.archon']);
  });

  it('never checks a repo added by path', async () => {
    const own = join(home, 'own');
    await mkdir(join(own, '.claude'), { recursive: true });
    await assertTrustedRepo(own, [own]);
  });

  it('flags env names that load code or redirect credentials', () => {
    for (const k of [
      'BASH_ENV',
      'NODE_OPTIONS',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_SHELL_PREFIX',
      'ANTHROPIC_BASE_URL',
      'XDG_CONFIG_HOME',
      'npm_config_script_shell',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'GIT_SSH_COMMAND',
      'https_proxy',
      'LD_PRELOAD',
    ]) {
      expect(isUnsafeEnvName(k)).toBe(true);
    }
    for (const k of ['DATABASE_URL', 'API_TOKEN', 'MY_FLAG', 'PATHFINDER']) {
      expect(isUnsafeEnvName(k)).toBe(false);
    }
  });
});
