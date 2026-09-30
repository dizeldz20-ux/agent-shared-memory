import { describe, expect, it } from 'vitest';
import { CommandUnavailableError, findExecutable, resolveCommand } from './command-resolver.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';

// The shim npm writes for a globally installed package (cmd-shim).
const CLAUDE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

// The npm.cmd that ships with Node: it names npm-prefix.js before npm-cli.js.
const NPM_CMD = `:: Created by npm, please don't edit manually.
@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"
)
"%NODE_EXE%" "%NPM_CLI_JS%" %*
`;

function windows(files: Record<string, string>, path: string) {
  const byLower = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]));
  return {
    platform: 'win32' as const,
    env: { PATH: path, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    execPath: NODE,
    exists: (file: string) => byLower.has(file.toLowerCase()),
    read: (file: string) => byLower.get(file.toLowerCase()) ?? '',
  };
}

describe('resolveCommand', () => {
  it('leaves a command name to the OS search on macOS and Linux', () => {
    expect(resolveCommand('claude', { platform: 'darwin' })).toEqual({ file: 'claude', args: [] });
  });

  it('runs a script path with the current node on every platform', () => {
    expect(resolveCommand('/x/fake.mjs', { platform: 'linux', execPath: '/n/node' })).toEqual({ file: '/n/node', args: ['/x/fake.mjs'] });
    expect(resolveCommand('C:\\x\\fake.cjs', windows({}, ''))).toEqual({ file: NODE, args: ['C:\\x\\fake.cjs'] });
  });

  it('finds an .exe on the Windows PATH and runs it directly', () => {
    const options = windows({ 'C:\\Users\\x\\.local\\bin\\uv.exe': '' }, 'C:\\Tools;C:\\Users\\x\\.local\\bin');
    expect(resolveCommand('uv', options)).toEqual({ file: 'C:\\Users\\x\\.local\\bin\\uv.exe', args: [] });
  });

  it('follows PATH order across folders and PATHEXT order inside one', () => {
    const options = windows({ 'C:\\a\\tool.cmd': CLAUDE_SHIM, 'C:\\a\\tool.exe': '', 'C:\\b\\tool.exe': '' }, 'C:\\a;C:\\b');
    expect(resolveCommand('tool', options)).toEqual({ file: 'C:\\a\\tool.exe', args: [] });
  });

  it('decodes an npm .cmd shim into node and the package script, with no shell', () => {
    const options = windows({
      'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd': CLAUDE_SHIM,
      'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js': '',
    }, 'C:\\Users\\x\\AppData\\Roaming\\npm');
    expect(resolveCommand('claude', options)).toEqual({
      file: NODE, args: ['C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
    });
  });

  it('runs npm through npm-cli.js next to node, in a folder with a space', () => {
    const options = windows({
      'C:\\Program Files\\nodejs\\npm.cmd': NPM_CMD,
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js': '',
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-prefix.js': '',
    }, 'C:\\Program Files\\nodejs');
    expect(resolveCommand('npm', options)).toEqual({ file: NODE, args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'] });
  });

  it('reads quoted and empty PATH entries', () => {
    const options = windows({ 'C:\\Quoted Dir\\grok.exe': '' }, ';"C:\\Quoted Dir";C:\\Other');
    expect(resolveCommand('grok', options)).toEqual({ file: 'C:\\Quoted Dir\\grok.exe', args: [] });
  });

  it('reads PATH under the key a Windows environment copy really uses', () => {
    const options = { ...windows({ 'C:\\a\\uv.exe': '' }, ''), env: { Path: 'C:\\a', PathExt: '.EXE' } };
    expect(resolveCommand('uv', options)).toEqual({ file: 'C:\\a\\uv.exe', args: [] });
  });

  it('tries PATHEXT on an explicit path without an extension', () => {
    const options = windows({ 'C:\\tools\\claude.exe': '' }, '');
    expect(resolveCommand('C:\\tools\\claude', options)).toEqual({ file: 'C:\\tools\\claude.exe', args: [] });
  });

  it('refuses a .cmd it cannot decode instead of handing it to a shell', () => {
    const options = windows({ 'C:\\a\\odd.cmd': '@echo off\r\nsomething.exe %*\r\n' }, 'C:\\a');
    expect(() => resolveCommand('odd', options)).toThrow(CommandUnavailableError);
    expect(() => resolveCommand('odd', options)).toThrow(/odd\.cmd/);
  });

  it('names the command that is missing', () => {
    expect(() => resolveCommand('graphify', windows({}, 'C:\\a'))).toThrow(/graphify/);
  });
});

describe('findExecutable', () => {
  it.skipIf(process.platform === 'win32')('finds the absolute path of an executable on a POSIX PATH', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'asm-which-'));
    try {
      writeFileSync(join(dir, 'uv'), '#!/bin/sh\n');
      writeFileSync(join(dir, 'notes'), 'not executable');
      chmodSync(join(dir, 'uv'), 0o755);
      expect(findExecutable('uv', { platform: 'linux', env: { PATH: `/nowhere:${dir}` } })).toBe(join(dir, 'uv'));
      expect(findExecutable('notes', { platform: 'linux', env: { PATH: dir } })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the .exe or the npm shim on Windows, and nothing for a missing tool', () => {
    const options = windows({ 'C:\\Users\\x\\.local\\bin\\uv.exe': '', 'C:\\npm\\codex.cmd': CLAUDE_SHIM }, 'C:\\Users\\x\\.local\\bin;C:\\npm');
    expect(findExecutable('uv', options)).toBe('C:\\Users\\x\\.local\\bin\\uv.exe');
    expect(findExecutable('codex', options)).toBe('C:\\npm\\codex.cmd');
    expect(findExecutable('grok', options)).toBeUndefined();
  });
});
