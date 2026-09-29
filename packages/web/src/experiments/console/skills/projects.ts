import { requestJson } from '../lib/http';
import { toProject, type Account, type Project } from '../primitives/project';

export async function listProjects(): Promise<Project[]> {
  const raw = await requestJson<Parameters<typeof toProject>[0][]>('/api/codebases');
  return raw.map(toProject);
}

export async function getProject(id: string): Promise<Project> {
  const raw = await requestJson<Parameters<typeof toProject>[0]>(
    `/api/codebases/${encodeURIComponent(id)}`
  );
  return toProject(raw);
}

export async function addProjectByUrl(url: string, account: Account): Promise<Project> {
  const raw = await requestJson<Parameters<typeof toProject>[0]>('/api/codebases', {
    method: 'POST',
    body: JSON.stringify({ url, account }),
  });
  return toProject(raw);
}

export async function addProjectByPath(path: string, account: Account): Promise<Project> {
  const raw = await requestJson<Parameters<typeof toProject>[0]>('/api/codebases', {
    method: 'POST',
    body: JSON.stringify({ path, account }),
  });
  return toProject(raw);
}

export async function removeProject(id: string): Promise<void> {
  await requestJson(`/api/codebases/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** One project's Claude Code activity: newest transcript write, and a terminal open in it now. */
export interface ProjectActivity {
  lastActivity: string | null;
  live: boolean;
}

/** Activity for every project, keyed by project id (HK-47 fork: rail live dots and "Recent" sort). */
export async function projectActivity(): Promise<Record<string, ProjectActivity>> {
  const raw = await requestJson<{ projects: Record<string, ProjectActivity> }>(
    '/api/hk47/project-activity'
  );
  return raw.projects;
}
