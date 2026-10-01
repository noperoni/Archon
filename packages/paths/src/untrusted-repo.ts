/**
 * HK-47 fork (PERS-34): a repository Archon cloned from a URL is untrusted.
 *
 * Claude runs with settingSources 'project', and Archon reads a project's own
 * `.archon/` for config, workflows, commands and scripts. Any of the paths
 * below in a cloned repo would let that repo run its own code on the first
 * turn, outside the danger gate: hooks, MCP servers, agents and skills under
 * `.claude/`, `.mcp.json`, and env, binary paths and bash nodes under
 * `.archon/`. Repos added by path are folders Master already works in and are
 * not checked.
 */
import { lstat } from 'fs/promises';
import { join, relative, isAbsolute, sep } from 'path';
import { getArchonWorkspacesPath } from './archon-paths';

export const CODE_BEARING_PATHS = ['.claude', '.mcp.json', '.archon'] as const;

/** Thrown when a cloned repo carries a code-bearing path; its message is user guidance. */
export class UntrustedRepoError extends Error {
  constructor(readonly found: string[]) {
    super(
      `Refused: this cloned repository ships ${found.join(', ')}, which could run its own ` +
        'hooks, tools or scripts. Clone it in a terminal, review those files, then add the ' +
        'folder by path.'
    );
    this.name = 'UntrustedRepoError';
  }
}

/**
 * True when a codebase's default_cwd is an Archon-managed clone: lexically under
 * the workspaces root. Path-registered repos keep their own path as default_cwd
 * (the workspaces entry is only a symlink to it), and folder projects never get
 * one, so neither is matched.
 */
export function isManagedClone(defaultCwd: string): boolean {
  const rel = relative(getArchonWorkspacesPath(), defaultCwd);
  return (
    rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`_folder${sep}`)
  );
}

/** The code-bearing paths present at `root`. lstat, so a symlink counts too. */
export async function findCodeBearingPaths(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const p of CODE_BEARING_PATHS) {
    try {
      await lstat(join(root, p));
      found.push(p);
    } catch {
      // absent
    }
  }
  return found;
}

/**
 * Throw UntrustedRepoError if `defaultCwd` is a managed clone and any of `roots`
 * (its source, and the worktree a turn or run will use) carries a code-bearing
 * path. Run after every sync: the clone-time check alone is beaten by a later
 * upstream commit.
 */
export async function assertTrustedRepo(defaultCwd: string, roots: string[]): Promise<void> {
  if (!isManagedClone(defaultCwd)) return;
  const found = new Set<string>();
  for (const root of new Set(roots)) {
    for (const p of await findCodeBearingPaths(root)) found.add(p);
  }
  if (found.size > 0) throw new UntrustedRepoError([...found]);
}

/**
 * Env names whose value can load code, redirect the toolchain, or send
 * prompts and credentials elsewhere. Refused from PUT /api/codebases/:id/env
 * and dropped from a repo's `.archon/config.yaml` `env:`, since both reach
 * every agent and workflow subprocess.
 */
const UNSAFE_ENV_NAME =
  /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|PATH|HOME|SHELL|ZDOTDIR|IFS|PROMPT_COMMAND|INPUTRC|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|BUN_OPTIONS|BUN_CONFIG_.*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|EDITOR|VISUAL|PAGER|LESSOPEN|LESSCLOSE|SSH_ASKPASS|SUDO_ASKPASS|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|NPM_CONFIG_.*|XDG_.*|OTEL_.*|CLAUDE_CONFIG_DIR|CLAUDE_BIN_PATH|CLAUDE_CODE_.*|ANTHROPIC_.*|ARCHON_.*|LD_.*|DYLD_.*|GIT_.*|.*_PROXY)$/i;

export function isUnsafeEnvName(name: string): boolean {
  return UNSAFE_ENV_NAME.test(name);
}
