/**
 * HK-47 danger gate for deterministic subprocesses (fork-only, PERS-15 gap 1).
 *
 * `bash:` / `script:` node bodies and `until_bash` probes run through
 * `runSubprocess` with no Claude session, so the PreToolUse hook that stops
 * destructive commands in a `claude` run never sees them. This puts the same
 * gate in front of them.
 *
 * A workflow has no human to answer a matrix, so every call is judged as a
 * `dontAsk` session: anything the gate would stop is refused outright. The
 * session id is per run, so no approval Master gave elsewhere can carry over.
 *
 * Fails closed: a missing gate, a crash, a timeout, or any output at all is a
 * refusal. Only exit 0 with empty stdout (the gate's "no opinion") lets a
 * command run.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GATE_TIMEOUT_MS = 10_000;

function gatePath(): string {
  return process.env.HK47_GATE_PATH ?? join(homedir(), '.claude', 'hooks', 'hk47_danger_gate.py');
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Thrown when the gate refuses a command. No numeric `code`, so loop callers halt rather than re-iterate. */
export class DangerGateRefusal extends Error {
  constructor(reason: string) {
    super(`HK-47 danger gate refused this subprocess: ${reason}`);
    this.name = 'DangerGateRefusal';
  }
}

export async function assertDangerGatePasses(
  cmd: string,
  args: string[],
  cwd: string,
  workflowRunId: string
): Promise<void> {
  const gate = gatePath();
  if (!existsSync(gate)) {
    throw new DangerGateRefusal(`gate not found at ${gate} (set HK47_GATE_PATH)`);
  }
  const command = [cmd, ...args].map(shellQuote).join(' ');
  const event = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
    permission_mode: 'dontAsk',
    session_id: `archon-${workflowRunId}`,
  });

  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>(resolve => {
    const child = spawn('python3', [gate], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, GATE_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ code: null, stdout: out, stderr: String(e) });
    });
    child.on('close', c => {
      clearTimeout(timer);
      resolve({ code: c, stdout: out, stderr: err });
    });
    child.stdin.end(event);
  });

  if (code === 0 && stdout.trim() === '') return;

  let reason = stderr.trim() || `gate exited ${String(code)}`;
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecisionReason?: string };
    };
    reason = parsed.hookSpecificOutput?.permissionDecisionReason ?? reason;
  } catch {
    // not JSON: keep stderr or the exit code as the reason
  }
  throw new DangerGateRefusal(reason);
}
