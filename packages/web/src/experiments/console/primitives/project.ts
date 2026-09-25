/** The Claude account a project runs under; null when its config dir is neither. */
export type Account = 'personal' | 'work';

/** Project primitive. Canonical in-spike shape, normalized from server schema. */
export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  repositoryUrl: string | null;
  lastSyncedAt: string | null;
  /** 'folder' = non-git workspace running in place; 'repo' = git repository. */
  kind: 'repo' | 'folder';
  account: Account | null;
}

interface RawCodebase {
  id: string;
  name: string;
  default_cwd: string;
  default_branch?: string | null;
  repository_url: string | null;
  kind?: 'repo' | 'folder';
  account?: Account | null;
  updated_at: string;
  created_at: string;
}

export function toProject(raw: RawCodebase): Project {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.default_cwd,
    defaultBranch: raw.default_branch ?? 'main',
    repositoryUrl: raw.repository_url,
    lastSyncedAt: raw.updated_at,
    // Backfill to 'repo' for older payloads (pre-kind); never leaves it undefined.
    kind: raw.kind ?? 'repo',
    account: raw.account ?? null,
  };
}
