import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Windows 使用已安装的 Git Bash；不要求用户修改全局 PATH。
export function bashExecutable(): string {
  if (process.platform !== 'win32') return 'bash';
  const gitPaths = execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const git of gitPaths) {
    const candidate = resolve(dirname(git), '../bin/bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('安装器测试需要 Git for Windows 自带的 Bash。');
}

export function bashPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => '/' + drive.toLowerCase()) : path;
}
