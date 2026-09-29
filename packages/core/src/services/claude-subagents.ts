/**
 * HK-47 fork: the subagents a Claude session spawned, read from what Claude
 * Code writes beside the session's transcript:
 *   <projects dir>/<sessionId>/subagents/agent-<id>.jsonl  (the agent's own lines)
 *   <projects dir>/<sessionId>/subagents/agent-<id>.meta.json  (type, description)
 * Reading the files rather than the SDK stream covers terminal sessions and
 * agents that finished long ago in the same way.
 *
 * Finished is read from the parent transcript: a background agent reports
 * through a <task-notification> naming its id and status, a foreground one
 * through the tool_result of the Agent call that launched it.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ClaudeSubagent {
  agentId: string;
  sessionId: string;
  description: string;
  agentType: string;
  background: boolean;
  /** `stale`: no report and no write for STALE_MS; it died with its session, most likely. */
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'stale';
  startedAt: string;
  lastActivity: string;
  toolUses: number;
  lastTool: string | null;
}

const STALE_MS = 15 * 60_000;
const TAIL_BYTES = 64 * 1024;

async function tail(path: string, size: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function reportedStatus(
  parent: string,
  agentId: string,
  toolUseId: string | undefined,
  background: boolean
): ClaudeSubagent['status'] | null {
  if (background) {
    const m = new RegExp(
      `<task-id>${agentId}</task-id>[\\s\\S]{0,600}?<status>(\\w+)</status>`
    ).exec(parent);
    if (m?.[1] === 'completed' || m?.[1] === 'failed' || m?.[1] === 'stopped') return m[1];
    return null;
  }
  return toolUseId !== undefined && parent.includes(`"tool_use_id":"${toolUseId}"`)
    ? 'completed'
    : null;
}

/** Every subagent of one session, newest first; empty when it never spawned one. */
export async function listSessionSubagents(
  transcriptPath: string,
  sessionId: string,
  now = Date.now()
): Promise<ClaudeSubagent[]> {
  const dir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const ids = names
    .filter(n => n.startsWith('agent-') && n.endsWith('.jsonl'))
    .map(n => n.slice('agent-'.length, -'.jsonl'.length));
  if (ids.length === 0) return [];
  const parent = await readFile(transcriptPath, 'utf8').catch(() => '');

  const agents = await Promise.all(
    ids.map(async (agentId): Promise<ClaudeSubagent | null> => {
      const path = join(dir, `agent-${agentId}.jsonl`);
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(
          await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf8')
        ) as Record<string, unknown>;
      } catch {
        // An agent without its meta file still ran; list it by id.
      }
      let info;
      try {
        info = await stat(path);
      } catch {
        return null;
      }
      const text = await readFile(path, 'utf8');
      const first = /"timestamp":"([^"]+)"/.exec(text)?.[1] ?? info.mtime.toISOString();
      const toolNames = [
        ...(await tail(path, info.size)).matchAll(
          /"type":"tool_use","id":"[^"]+","name":"([^"]+)"/g
        ),
      ];
      const background = meta.requestShape === 'background';
      const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined;
      const reported = reportedStatus(parent, agentId, toolUseId, background);
      return {
        agentId,
        sessionId,
        description: typeof meta.description === 'string' ? meta.description : agentId,
        agentType: typeof meta.agentType === 'string' ? meta.agentType : 'agent',
        background,
        status: reported ?? (now - info.mtimeMs > STALE_MS ? 'stale' : 'running'),
        startedAt: first,
        lastActivity: info.mtime.toISOString(),
        toolUses: text.split('"type":"tool_use"').length - 1,
        lastTool: toolNames.at(-1)?.[1] ?? null,
      };
    })
  );
  return agents
    .filter((a): a is ClaudeSubagent => a !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
