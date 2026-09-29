/**
 * The slash commands a project's terminal would offer: skills and legacy
 * commands from the project and the account's config dir, plus those of the
 * account's enabled plugins, named `plugin:name` as the terminal names them.
 * Read from disk so the list exists before the first turn; the SDK's own
 * supportedCommands() needs a live query.
 *
 * ponytail: rescans on every call (a few dozen small files); cache by mtime if
 * the composer ever asks often.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface ClaudeSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  source: 'project' | 'user' | 'plugin';
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESCRIPTION_MAX = 200;

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Frontmatter fields of a skill or command file, or null when unreadable or hidden. */
async function readEntry(
  path: string,
  fallbackName: string
): Promise<{ name: string; description: string; argumentHint?: string } | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let meta: Record<string, unknown> = {};
  const match = FRONTMATTER.exec(text);
  if (match?.[1] !== undefined) {
    try {
      const parsed: unknown = Bun.YAML.parse(match[1]);
      if (typeof parsed === 'object' && parsed !== null) meta = parsed as Record<string, unknown>;
    } catch {
      // Malformed frontmatter still names a runnable command; list it bare.
    }
  }
  if (meta['user-invocable'] === false) return null;
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  const hint = meta['argument-hint'];
  return {
    name: typeof meta.name === 'string' && meta.name ? meta.name : fallbackName,
    description:
      description.length > DESCRIPTION_MAX
        ? `${description.slice(0, DESCRIPTION_MAX)}...`
        : description,
    argumentHint: typeof hint === 'string' && hint ? hint : undefined,
  };
}

async function scanRoot(
  root: string,
  source: ClaudeSlashCommand['source'],
  prefix = ''
): Promise<ClaudeSlashCommand[]> {
  const out: ClaudeSlashCommand[] = [];
  const skills = await readdir(join(root, 'skills'), { withFileTypes: true }).catch(() => []);
  for (const dir of skills) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const entry = await readEntry(join(root, 'skills', dir.name, 'SKILL.md'), dir.name);
    if (entry !== null) out.push({ ...entry, name: prefix + entry.name, source });
  }
  const commands = await readdir(join(root, 'commands'), { withFileTypes: true }).catch(() => []);
  for (const file of commands) {
    if (!file.name.endsWith('.md')) continue;
    const entry = await readEntry(join(root, 'commands', file.name), basename(file.name, '.md'));
    if (entry !== null) out.push({ ...entry, name: prefix + entry.name, source });
  }
  return out;
}

/** Install paths of the plugins this config dir has enabled that apply to `cwd`. */
async function enabledPlugins(
  configDir: string,
  cwd: string
): Promise<{ name: string; path: string }[]> {
  const settings = await readJson(join(configDir, 'settings.json'));
  const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>;
  const installed = (await readJson(join(configDir, 'plugins', 'installed_plugins.json')))
    ?.plugins as Record<string, { scope?: string; projectPath?: string; installPath?: string }[]>;
  const out: { name: string; path: string }[] = [];
  for (const [id, installs] of Object.entries(installed ?? {})) {
    if (enabled[id] !== true || !Array.isArray(installs)) continue;
    const install =
      installs.find(i => i.scope === 'project' && i.projectPath === cwd) ??
      installs.find(i => i.scope === 'user');
    if (install?.installPath) out.push({ name: id.split('@')[0] ?? id, path: install.installPath });
  }
  return out;
}

export async function listClaudeSlashCommands(
  cwd: string,
  configDir: string
): Promise<ClaudeSlashCommand[]> {
  const groups = await Promise.all([
    scanRoot(join(cwd, '.claude'), 'project'),
    scanRoot(configDir, 'user'),
    enabledPlugins(configDir, cwd).then(async plugins =>
      (await Promise.all(plugins.map(p => scanRoot(p.path, 'plugin', `${p.name}:`)))).flat()
    ),
  ]);
  // Project entries shadow the account's of the same name, as in the terminal.
  const byName = new Map<string, ClaudeSlashCommand>();
  for (const command of groups.flat()) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
