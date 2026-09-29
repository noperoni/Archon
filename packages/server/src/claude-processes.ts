/**
 * HK-47 fork: which directories have a Claude Code terminal open in them right
 * now, read from /proc. A process counts when its `comm` is exactly `claude`
 * (the desktop app's `claude-desktop` processes do not), and it is placed by the
 * real path of its cwd so a session opened through a symlink still matches.
 */
import { readFile, readdir, readlink, realpath } from 'fs/promises';

/** Real cwds of every running `claude` process; empty where /proc is unreadable. */
export async function liveClaudeCwds(): Promise<Set<string>> {
  let pids: string[];
  try {
    pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
  } catch {
    return new Set();
  }
  const cwds = await Promise.all(
    pids.map(async pid => {
      try {
        if ((await readFile(`/proc/${pid}/comm`, 'utf8')).trim() !== 'claude') return null;
        return await realpath(await readlink(`/proc/${pid}/cwd`));
      } catch {
        // gone mid-scan, or another user's process we may not inspect
        return null;
      }
    })
  );
  return new Set(cwds.filter((cwd): cwd is string => cwd !== null));
}
