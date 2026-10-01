import { describe, it, expect } from 'bun:test';
import { setEnvVarBodySchema } from './codebase.schemas';

// HK-47 fork (PERS-34): PUT /env shares the unsafe-name rule with repo config.
describe('setEnvVarBodySchema', () => {
  it('refuses names that load code or redirect credentials', () => {
    for (const key of [
      'BASH_ENV',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_SHELL_PREFIX',
      'XDG_CONFIG_HOME',
    ]) {
      expect(setEnvVarBodySchema.safeParse({ key, value: 'x' }).success).toBe(false);
    }
  });

  it('admits ordinary names and leaves CLAUDE_CONFIG_DIR to the route', () => {
    for (const key of ['DATABASE_URL', 'CLAUDE_CONFIG_DIR']) {
      expect(setEnvVarBodySchema.safeParse({ key, value: 'x' }).success).toBe(true);
    }
  });
});
