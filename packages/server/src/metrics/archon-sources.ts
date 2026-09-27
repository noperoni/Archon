import { pool } from '@archon/core/db/connection';
import type { ArchonSources, WorkflowEventRow, WorkflowRunRow } from './metrics';

/** Archon's own tables, read only, through the dialect-neutral pool. */
export const archonSources: ArchonSources = {
  async consoleSessions(): Promise<Set<string>> {
    const ids = new Set<string>();
    const chats = await pool.query<{ id: string }>(
      'SELECT DISTINCT assistant_session_id AS id FROM remote_agent_sessions WHERE assistant_session_id IS NOT NULL'
    );
    // Workflow nodes run their own Claude sessions, and those are console work too.
    const nodes = await pool.query<{ id: string }>(
      `SELECT provider_session_id AS id FROM remote_agent_workflow_node_sessions WHERE provider = 'claude'
       UNION SELECT provider_session_id AS id FROM remote_agent_workflow_run_node_sessions WHERE provider = 'claude'`
    );
    for (const r of [...chats.rows, ...nodes.rows]) if (r.id) ids.add(r.id);
    return ids;
  },
  async workflowRuns(): Promise<WorkflowRunRow[]> {
    const result = await pool.query<WorkflowRunRow>(
      'SELECT id, workflow_name, status, started_at, completed_at FROM remote_agent_workflow_runs'
    );
    return [...result.rows];
  },
  async workflowEvents(): Promise<WorkflowEventRow[]> {
    const result = await pool.query<WorkflowEventRow>(
      "SELECT workflow_run_id, event_type, data FROM remote_agent_workflow_events WHERE event_type = 'node_completed'"
    );
    return [...result.rows];
  },
};
