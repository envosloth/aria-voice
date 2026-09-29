import { execFile } from 'child_process';

export interface ProcessMemory { pid: number; parent: number; rssKb: number; }

/** Parse only the fixed numeric fields we request; never process command lines. */
export function parseProcessMemory(text: string, windows = false): ProcessMemory[] {
  const rows: ProcessMemory[] = windows
    ? ([] as any[]).concat(JSON.parse(text) || []).map((r) => ({
      pid: Number(r.ProcessId), parent: Number(r.ParentProcessId), rssKb: Number(r.WorkingSetSize) / 1024,
    }))
    : text.trim().split('\n').map((line) => {
      const [pid, parent, rssKb] = line.trim().split(/\s+/).map(Number);
      return { pid, parent, rssKb };
    });
  return rows.filter((r) => Number.isSafeInteger(r.pid) && r.pid > 0 &&
    Number.isSafeInteger(r.parent) && r.parent >= 0 && Number.isFinite(r.rssKb) && r.rssKb >= 0);
}

/** One bounded asynchronous process snapshot per watchdog tick. */
export function readProcessMemory(): Promise<ProcessMemory[]> {
  const windows = process.platform === 'win32';
  const command = windows ? 'powershell.exe' : 'ps';
  const args = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress']
    : ['-A', '-o', 'pid=,ppid=,rss='];
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(parseProcessMemory(stdout, windows)); } catch (e) { reject(e); }
    });
  });
}

/** Conservative sum of resident working sets; shared pages may be counted twice. */
export function processTreeRss(rows: ProcessMemory[], rootPid: number): number | null {
  if (!rows.some((r) => r.pid === rootPid)) return null;
  const children = new Map<number, ProcessMemory[]>();
  for (const row of rows) {
    const list = children.get(row.parent) || [];
    list.push(row); children.set(row.parent, list);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  const pending = [rootPid];
  let total = 0;
  while (pending.length) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += byPid.get(pid)?.rssKb || 0;
    for (const child of children.get(pid) || []) pending.push(child.pid);
  }
  return total;
}
