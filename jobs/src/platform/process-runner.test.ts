import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandUnavailableError } from './command-resolver.js';
import { ProcessRunner } from './process-runner.js';

describe('ProcessRunner', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asm-proc-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function script(name: string, body: string): string {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  }

  it('passes every argument through untouched, with no shell in between', async () => {
    const echo = script('echo.mjs', 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), flag: process.env.ASM_FLAG }));');
    const args = ['a b', '"quoted"', '{"mcpServers":{}}', 'x&y|z', '%PATH%', 'שלום'];
    const result = await new ProcessRunner().run(echo, args, { cwd: dir, env: { ...process.env, ASM_FLAG: 'on' } });
    expect(result.code).toBe(0);
    const seen = JSON.parse(result.output) as { argv: string[]; cwd: string; flag: string };
    expect(seen.argv).toEqual(args);
    expect(seen.flag).toBe('on');
  });

  it('keeps all of stdout, however long, apart from the combined tail', async () => {
    const long = script('long.mjs', 'process.stdout.write("x".repeat(50000)); console.error("tail");');
    const result = await new ProcessRunner().run(long, []);
    expect(result.stdout).toHaveLength(50_000);
    expect(result.output.length).toBeLessThanOrEqual(8_000);
    expect(result.output).toContain('tail');
  });

  it('streams output as it comes and reports a failing exit code without throwing', async () => {
    const fail = script('fail.mjs', 'console.log("step one"); console.error("broke"); process.exit(3);');
    const seen: string[] = [];
    const result = await new ProcessRunner().run(fail, [], { onOutput: (text) => seen.push(text) });
    expect(result.code).toBe(3);
    expect(seen.join('')).toContain('step one');
    expect(result.output).toContain('broke');
  });

  it('rejects, never throws, when the command cannot be resolved (a Windows .cmd with no script)', async () => {
    const refuse = (): never => { throw new CommandUnavailableError('C:\\a\\odd.cmd runs only through a shell'); };
    const pending = new ProcessRunner(refuse).run('odd', []);
    await expect(pending).rejects.toThrow(/odd\.cmd/);
  });

  it('names a working folder that does not exist instead of calling the tool missing', async () => {
    const echo = script('echo.mjs', 'process.exit(0);');
    await expect(new ProcessRunner().run(echo, [], { cwd: join(dir, 'gone') })).rejects.toThrow(/working folder .*gone.* does not exist/);
  });

  it.skipIf(process.platform === 'win32')('tells an installed tool that cannot start from one that is not installed', async () => {
    const broken = join(dir, 'graphify');
    writeFileSync(broken, '#!/nonexistent-interpreter/python3\n');
    chmodSync(broken, 0o755);
    const env = { ...process.env, PATH: dir };
    await expect(new ProcessRunner().run('graphify', [], { env })).rejects.toThrow(/graphify is installed .* but could not start/);
  });

  it('names a command that is not installed', async () => {
    await expect(new ProcessRunner().run('asm-no-such-tool-7f3a', [])).rejects.toThrow(CommandUnavailableError);
    await expect(new ProcessRunner().run('asm-no-such-tool-7f3a', [])).rejects.toThrow(/asm-no-such-tool-7f3a/);
  });
});
