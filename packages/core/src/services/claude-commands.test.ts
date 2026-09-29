import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listClaudeSlashCommands } from './claude-commands';

let root: string;

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-commands-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listClaudeSlashCommands', () => {
  test('lists project, user and enabled plugin entries as the terminal names them', async () => {
    const cwd = join(root, 'project');
    const config = join(root, 'config');
    const plugin = join(root, 'plugin-install');
    write(
      join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Project deploy\n---\nbody'
    );
    write(
      join(config, 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Shadowed by the project\n---\n'
    );
    write(
      join(config, 'skills', 'caveman', 'SKILL.md'),
      '---\nname: caveman\ndescription: >\n  Terse mode\nargument-hint: "[lite|full]"\n---\n'
    );
    write(
      join(config, 'skills', 'internal', 'SKILL.md'),
      '---\nname: internal\ndescription: hidden\nuser-invocable: false\n---\n'
    );
    write(join(config, 'commands', 'old.md'), 'No frontmatter at all.');
    write(join(plugin, 'commands', 'review.md'), '---\ndescription: Review a PR\n---\n');
    write(
      join(config, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'code@market': true, 'off@market': false } })
    );
    write(
      join(config, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'code@market': [{ scope: 'user', installPath: plugin }],
          'off@market': [{ scope: 'user', installPath: plugin }],
        },
      })
    );

    const commands = await listClaudeSlashCommands(cwd, config);

    expect(commands.map(c => c.name)).toEqual(['caveman', 'code:review', 'deploy', 'old']);
    expect(commands.find(c => c.name === 'deploy')).toMatchObject({
      description: 'Project deploy',
      source: 'project',
    });
    expect(commands.find(c => c.name === 'caveman')).toMatchObject({
      description: 'Terse mode',
      argumentHint: '[lite|full]',
      source: 'user',
    });
    expect(commands.find(c => c.name === 'code:review')?.source).toBe('plugin');
  });

  test('a project with no skill roots at all lists nothing', async () => {
    expect(await listClaudeSlashCommands(join(root, 'none'), join(root, 'nothing'))).toEqual([]);
  });
});
