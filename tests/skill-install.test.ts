import { createServer } from 'node:http';
import { mkdtemp,readFile,writeFile,rm,mkdir,readdir,chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe,it,expect } from 'vitest';
import { bashExecutable, bashPath } from './helpers/bash';
const exec=promisify(execFile);
const bash=bashExecutable();
describe('public skill installation',()=>{
  it('downloads and validates a complete package, backs up its own version, and refuses foreign skills',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'ym-skill-test-')),target=join(dir,'skill');
    const files=new Map<string,Buffer>();
    for(const name of ['SKILL.md','LICENSE','agents/openai.yaml'])files.set('/'+name,await readFile('integrations/agent/ai-yangmao-public/'+name));
    files.set('/manifest.sha256',Buffer.from([...files].map(([name,bytes])=>`${createHash('sha256').update(bytes).digest('hex')}  ${name.slice(1)}`).join('\n')+'\n'));
    let gate:Promise<void>|undefined,arrived:(()=>void)|undefined;
    const server=createServer(async(req,res)=>{arrived?.();if(gate)await gate;const body=files.get(req.url!);res.writeHead(body?200:404);res.end(body);});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${(server.address() as any).port}`;
    const install=()=>exec(bash,['integrations/agent/install.sh','--dir',bashPath(target),'--base-url',base]);
    try{
      await install();expect(await readFile(join(target,'SKILL.md'),'utf8')).toContain('name: ai-yangmao-public');
      await install();expect((await readdir(dir)).some(f=>f.startsWith('skill.backup.'))).toBe(true);
      const original=await readFile(join(target,'SKILL.md'),'utf8');
      const manifest=files.get('/manifest.sha256')!;
      files.set('/manifest.sha256',Buffer.from((manifest.toString().split('\n')[0]+'\n').repeat(3)));
      await expect(install()).rejects.toThrow();files.set('/manifest.sha256',manifest);
      const shim=join(dir,'bin');await mkdir(shim);
      await writeFile(join(shim,'mv'),'#!/bin/sh\ncase "$1" in */pkg) exit 73 ;; esac\nexec /bin/mv "$@"\n');await chmod(join(shim,'mv'),0o755);
      await expect(exec(bash,['-c','export PATH="$1:$PATH"; shift; exec bash "$@"','installer-test',bashPath(shim),'integrations/agent/install.sh','--dir',bashPath(target),'--base-url',base])).rejects.toThrow();
      expect(await readFile(join(target,'SKILL.md'),'utf8')).toBe(original);
      let release!:()=>void;gate=new Promise<void>(resolve=>{release=resolve;});
      const started=new Promise<void>(resolve=>{arrived=resolve;});const installing=install();await started;
      try{await expect(install()).rejects.toMatchObject({code:75});}finally{gate=undefined;release();arrived=undefined;}
      await installing;expect(await readFile(join(target,'SKILL.md'),'utf8')).toBe(original);
      await mkdir(target+'.install-lock');await writeFile(target+'.install-lock/pid','99999999');
      const locked=await Promise.allSettled([install(),install()]);
      expect(locked.every(result=>result.status==='rejected'&&result.reason.code===75)).toBe(true);
      expect(await readFile(join(target,'SKILL.md'),'utf8')).toBe(original);
      await rm(target+'.install-lock',{recursive:true});
      files.set('/SKILL.md',Buffer.from('tampered'));await expect(install()).rejects.toThrow();
      expect(await readFile(join(target,'SKILL.md'),'utf8')).toBe(original);
      const foreign=join(dir,'foreign');await mkdir(foreign);await writeFile(join(foreign,'SKILL.md'),'---\nname: another-skill\n---\n');
      await expect(exec(bash,['integrations/agent/install.sh','--dir',bashPath(foreign),'--base-url',base])).rejects.toThrow();
      expect(await readFile(join(foreign,'SKILL.md'),'utf8')).toContain('another-skill');
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
  }, 30_000);
});
