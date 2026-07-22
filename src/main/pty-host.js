// PTY helper. Runs as a separate process from the Electron main process and
// communicates with it via stdin/stdout JSON messages.
//
// It is launched by `spawnBundledNode` (src/main/node-runtime.ts), i.e. as
// `Lares.exe` with ELECTRON_RUN_AS_NODE=1 — Electron's embedded Node runtime,
// which matches the ABI node-pty is rebuilt for and needs no system Node.js.
//
// This file deliberately lives under `src/main/` (copied verbatim into
// `dist/main/main/` by scripts/copy-static-main.mjs) rather than `scripts/`, so
// that packaged it sits inside `app.asar` and the bare `require('node-pty')`
// below resolves through the app's own module tree. Do not move it back.
// It must stay plain CommonJS and must never `require('electron')`.

const pty = require('node-pty');

let ptyProcess = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

process.stdin.setEncoding('utf-8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      send({ type: 'error', error: 'Invalid JSON: ' + e.message });
      continue;
    }
    try {
      handleMessage(msg);
    } catch (e) {
      send({ type: 'error', error: 'Handler error: ' + e.message });
    }
  }
});

// Quote a single arg for `cmd.exe /c <joined>`. Without this, args containing
// whitespace get re-split by cmd.exe — e.g. `--append-system-prompt "Workspace
// root: ..."` is shredded into `--append-system-prompt Workspace`, `root:`,
// and trailing tokens that Claude treats as a positional prompt.
function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'spawn': {
      if (ptyProcess) {
        ptyProcess.kill();
      }

      const env = { ...process.env };
      delete env.CLAUDECODE;

      // Electron-as-Node markers must not reach cmd.exe / wsl.exe / the agent
      // CLI: this host is itself Lares.exe running with ELECTRON_RUN_AS_NODE=1,
      // and a provider that re-execs node while inheriting that flag misbehaves
      // (it would silently turn any `electron` invocation downstream into a
      // bare node one). Strip them for the PTY child only — our own process
      // still needs them.
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.ELECTRON_NO_ATTACH_CONSOLE;


      // Force CLI tools like Claude Code to output ANSI colors even when wrapped
      // inside cmd.exe under node-pty on Windows.
      env.FORCE_COLOR = '3';
      env.CLICOLOR_FORCE = '1';
      env.TERM = 'xterm-256color';

      // On Windows, node-pty can't resolve commands from PATH directly.
      // Spawn via cmd.exe /c so the shell resolves the command.
      // If msg.directSpawn is set, skip cmd.exe wrapping (needed when args
      // contain multiline strings that cmd.exe would mangle).
      let spawnCmd, spawnArgs;
      if (process.platform === 'win32' && !msg.directSpawn && msg.command !== 'cmd.exe' && msg.command !== 'wsl.exe') {
        spawnCmd = 'cmd.exe';
        const fullCommand = [msg.command, ...(msg.args || [])].map(quoteForCmd).join(' ');
        spawnArgs = ['/c', fullCommand];
      } else {
        spawnCmd = msg.command;
        spawnArgs = msg.args || [];
      }

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols: msg.cols || 120,
        rows: msg.rows || 40,
        cwd: msg.cwd || process.cwd(),
        env,
      });

      send({ type: 'pid', pid: ptyProcess.pid });

      ptyProcess.onData((data) => {
        send({ type: 'data', data });
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        send({ type: 'exit', exitCode, signal });
        ptyProcess = null;
      });
      break;
    }

    case 'write': {
      if (ptyProcess) {
        ptyProcess.write(msg.data);
      }
      break;
    }

    case 'resize': {
      if (ptyProcess) {
        ptyProcess.resize(msg.cols, msg.rows);
      }
      break;
    }

    case 'kill': {
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
      }
      send({ type: 'killed' });
      break;
    }

    case 'ping': {
      send({ type: 'pong' });
      break;
    }
  }
}

process.on('SIGTERM', () => {
  if (ptyProcess) ptyProcess.kill();
  process.exit(0);
});

send({ type: 'ready' });
