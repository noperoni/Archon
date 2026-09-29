/**
 * HK-47 fork (PERS-24): Claude Code's transcripts, followed live across both
 * accounts. A recursive watch on each account's `projects/` tree tells the
 * console within a second when a session in any project moves, from a terminal
 * or from the console itself, and registers a project the first time a session
 * runs in a directory Archon does not know yet. Transcripts stay where Claude
 * Code writes them; nothing is copied or indexed (PERS-18).
 */
import { existsSync, watch, type FSWatcher } from 'fs';
import { realpath } from 'fs/promises';
import { homedir } from 'os';
import { basename, join, sep } from 'path';
import { createLogger } from '@archon/paths';
import { findRepoRoot } from '@archon/git';
import { registerFolder, registerRepository } from '@archon/core';
import * as codebaseDb from '@archon/core/db/codebases';
import * as envVarDb from '@archon/core/db/env-vars';
import { claudeProjectDir, transcriptCwd } from '@archon/core/services/claude-transcripts';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('transcript-watcher');
  return cachedLog;
}

/** The two Claude accounts, told apart by config dir name. */
export const ACCOUNT_CONFIG_DIRS = { personal: '.claude-personal', work: '.claude-work' } as const;
export type ClaudeAccount = keyof typeof ACCOUNT_CONFIG_DIRS;

export type RegisterResult = Awaited<ReturnType<typeof registerFolder>>;

/**
 * Register a local path the way the Add Project form does: a git repo root as a
 * repo project, anything else as a folder project. Returns null when git itself
 * failed on a path that exists, which must not register: it would permanently
 * misclassify a real repo as a folder.
 */
export async function registerLocalProject(localPath: string): Promise<RegisterResult | null> {
  // findRepoRoot throws both for a nonexistent path (benign: registerFolder's
  // own existence check produces the clean error) and for a genuine git failure.
  let repoRoot: string | null = null;
  try {
    repoRoot = await findRepoRoot(localPath);
  } catch (err) {
    getLog().warn({ err, path: localPath }, 'register_local.repo_detect_failed');
    if (existsSync(localPath)) return null;
  }
  if (!repoRoot) return await registerFolder(localPath);
  try {
    return await registerRepository(localPath);
  } catch (err) {
    // A subfolder of a repo that is already a project collides with that
    // project's workspace; it still runs in place as a folder project.
    if (localPath === repoRoot) throw err;
    getLog().info({ err, path: localPath, repoRoot }, 'register_local.subfolder_as_folder');
    return await registerFolder(localPath);
  }
}

export interface TranscriptEvent {
  type: 'claude_transcript' | 'projects_changed';
  codebaseId: string;
  sessionId?: string;
}

// `<encoded cwd>/<session uuid>.jsonl`; subagent transcripts nest deeper and are ignored.
const SESSION_FILE =
  /^([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
// A transcript being written changes many times a second; tell the console at
// most once a second per file.
const THROTTLE_MS = 1000;

/** Paths that are never projects: scratch dirs and Archon's own workspaces. */
function discoverable(cwd: string): boolean {
  if (cwd === '/tmp' || cwd.startsWith(`/tmp${sep}`)) return false;
  const archonHome = join(homedir(), '.archon');
  return cwd !== archonHome && !cwd.startsWith(archonHome + sep) && existsSync(cwd);
}

export class TranscriptWatcher {
  private watchers: FSWatcher[] = [];
  private listeners = new Set<(event: TranscriptEvent) => void>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Encoded project dir → the cwd its transcripts record. */
  private cwdOf = new Map<string, string>();
  /** Paths discovery already tried this run, registered or not. */
  private tried = new Set<string>();

  start(): void {
    if (this.watchers.length > 0) return;
    for (const [account, dir] of Object.entries(ACCOUNT_CONFIG_DIRS) as [ClaudeAccount, string][]) {
      const root = join(homedir(), dir, 'projects');
      if (!existsSync(root)) continue;
      try {
        this.watchers.push(
          watch(root, { recursive: true }, (_event, name) => {
            if (typeof name === 'string') this.onChange(account, root, name);
          })
        );
        getLog().info({ root }, 'transcript_watcher.started');
      } catch (err) {
        getLog().warn({ err, root }, 'transcript_watcher.watch_failed');
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  subscribe(listener: (event: TranscriptEvent) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  private onChange(account: ClaudeAccount, root: string, name: string): void {
    const match = SESSION_FILE.exec(name);
    if (!match) return;
    const path = join(root, name);
    if (this.pending.has(path)) return;
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path);
        void this.handle(account, join(root, match[1]), path, match[2]).catch((err: unknown) => {
          getLog().warn({ err, path }, 'transcript_watcher.handle_failed');
        });
      }, THROTTLE_MS)
    );
  }

  private async handle(
    account: ClaudeAccount,
    projectDir: string,
    path: string,
    sessionId: string
  ): Promise<void> {
    // A project's own transcript directory names it outright, whatever cwd its
    // lines recorded: a folder renamed and its history moved along keeps
    // lines that name the old path.
    const dirName = basename(projectDir);
    const owner = (await codebaseDb.listCodebases()).find(
      c => claudeProjectDir('', c.default_cwd) === join('projects', dirName)
    );
    if (owner) {
      this.emit({ type: 'claude_transcript', codebaseId: owner.id, sessionId });
      return;
    }

    let cwd = this.cwdOf.get(projectDir);
    if (cwd === undefined) {
      if (!existsSync(path)) return;
      const found = await transcriptCwd(path);
      if (found === null) return;
      // Projects are registered by real path; a session opened through a
      // symlink belongs to the project the link points at.
      cwd = await realpath(found).catch(() => found);
      this.cwdOf.set(projectDir, cwd);
    }

    const codebase = await codebaseDb.findCodebaseByDefaultCwd(cwd);
    if (codebase) {
      this.emit({ type: 'claude_transcript', codebaseId: codebase.id, sessionId });
      return;
    }
    // ponytail: a project removed from Archon comes back the next time a session
    // runs in it, which is the ruling (every path with history is a project); an
    // ignore list if one should stay removed.
    if (this.tried.has(cwd) || !discoverable(cwd)) return;
    this.tried.add(cwd);
    const result = await registerLocalProject(cwd);
    if (result === null) return;
    // The binding follows the account whose transcript found it, and is only
    // written for a new project: an existing one keeps the account it has.
    if (!result.alreadyExisted) {
      await envVarDb.setCodebaseEnvVar(
        result.codebaseId,
        'CLAUDE_CONFIG_DIR',
        join(homedir(), ACCOUNT_CONFIG_DIRS[account])
      );
    }
    getLog().info({ cwd, account, codebaseId: result.codebaseId }, 'transcript_watcher.discovered');
    this.emit({ type: 'projects_changed', codebaseId: result.codebaseId });
    this.emit({ type: 'claude_transcript', codebaseId: result.codebaseId, sessionId });
  }

  private emit(event: TranscriptEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** The server's one watcher; index.ts starts it, the stream route subscribes. */
export const transcriptWatcher = new TranscriptWatcher();
