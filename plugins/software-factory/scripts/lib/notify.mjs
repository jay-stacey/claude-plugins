// Best-effort desktop notifications. Failures are ignored.
import { spawn } from 'node:child_process';
import { load as loadConfig } from './config.mjs';

export function enabled(home) {
  if (process.env.FACTORY_NO_NOTIFY === '1') return false;
  try { return loadConfig(home).notifications.desktop !== false; } catch { return false; }
}

function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

export function notify(home, title, body) {
  if (!enabled(home)) return false;
  title = String(title).slice(0, 60); body = String(body).slice(0, 200);
  try {
    let cmd; let args;
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms', 'Add-Type -AssemblyName System.Drawing',
        '$n = New-Object System.Windows.Forms.NotifyIcon', '$n.Icon = [System.Drawing.SystemIcons]::Information',
        '$n.Visible = $true', `$n.ShowBalloonTip(8000, ${psQuote(title)}, ${psQuote(body)}, [System.Windows.Forms.ToolTipIcon]::Info)`,
        'Start-Sleep -Seconds 9', '$n.Dispose()',
      ].join('; ');
      cmd = 'powershell'; args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script];
    } else if (process.platform === 'darwin') {
      const q = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;
      cmd = 'osascript'; args = ['-e', `display notification ${q(body)} with title ${q(title)}`];
    } else {
      cmd = 'notify-send'; args = [title, body];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

export function notifier(home) { return (title, body) => notify(home, title, body); }
