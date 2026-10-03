/**
 * daemonManager.ts — per-OS daemon installation for the workspace MCP
 * + browser server. One daemon per workspace.
 *
 * Lifecycle:
 *   - `install(spec)`   register the daemon with the OS service manager
 *   - `start(id)`       start it now (so the browser is up immediately
 *                       after install, not on next reboot)
 *   - `stop(id)`        stop it (still installed)
 *   - `uninstall(id)`   remove the OS-level entry
 *   - `status(id)`      `'running' | 'stopped' | 'not-installed'`
 *
 * Per-OS mechanism:
 *   macOS:   ~/Library/LaunchAgents/com.codeatlas.mcp.<hash>.plist + launchctl
 *   Linux:   ~/.config/systemd/user/codeatlas-mcp-<hash>.service  + systemctl --user
 *   Windows: schtasks /tn "CodeAtlas MCP <hash>" + XML definition
 *
 * Daemon ID = `codeatlas-mcp-<sha1(workspace).slice(0,12)>`. Stable per
 * workspace so reinstalls update the same entry instead of accumulating.
 *
 * Logs go to ~/.config/codeatlas/logs/<id>.log (stdout) and .err.log
 * (stderr). Daemon picks them up via stdout-redirect in the OS spec.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { currentPlatform } from './platformPaths';

export interface DaemonSpec {
    /** Stable id derived from the workspace path. */
    id: string;
    /** Workspace path the daemon will index. */
    workspacePath: string;
    /** Absolute path to the node executable to launch. */
    nodeBin: string;
    /** Absolute path to the bundled mcp-server.js. */
    mcpServerJs: string;
    /** Port the browser surface listens on. */
    port: number;
}

export type DaemonStatus = 'running' | 'stopped' | 'not-installed' | 'unknown';

/**
 * Stable id for a workspace path — sha1 over the realpath, first 12 hex.
 * The MCP server bundles `crypto` so this is fast and consistent.
 */
export function daemonIdFor(workspacePath: string): string {
    let canonical = workspacePath;
    try { canonical = fs.realpathSync(workspacePath); } catch { /* fall back to literal */ }
    const h = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 12);
    return `codeatlas-mcp-${h}`;
}

export interface DaemonInstallResult {
    id: string;
    /** Path of the platform-specific service file we wrote. */
    servicePath: string;
    /** Started successfully right after install. */
    started: boolean;
    /** Free-form notes for the user (e.g. "systemd --user not running, daemon will start on next login"). */
    notes: string[];
}

export function installAndStart(spec: DaemonSpec): DaemonInstallResult {
    ensureLogsDir(spec.id);
    const platform = currentPlatform();
    if (platform === 'darwin') return installAndStartMac(spec);
    if (platform === 'linux') return installAndStartLinux(spec);
    if (platform === 'win32') return installAndStartWindows(spec);
    return { id: spec.id, servicePath: '', started: false, notes: [`Unsupported platform: ${platform}`] };
}

export function uninstall(id: string): { ok: boolean; notes: string[] } {
    const platform = currentPlatform();
    if (platform === 'darwin') return uninstallMac(id);
    if (platform === 'linux') return uninstallLinux(id);
    if (platform === 'win32') return uninstallWindows(id);
    return { ok: false, notes: [`Unsupported platform: ${platform}`] };
}

export function status(id: string): DaemonStatus {
    const platform = currentPlatform();
    try {
        if (platform === 'darwin') return statusMac(id);
        if (platform === 'linux') return statusLinux(id);
        if (platform === 'win32') return statusWindows(id);
    } catch { return 'unknown'; }
    return 'unknown';
}

// ── macOS — launchctl + LaunchAgent ─────────────────────────────────────

function macPlistPath(id: string): string {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.codeatlas.${id}.plist`);
}

function installAndStartMac(spec: DaemonSpec): DaemonInstallResult {
    const plistPath = macPlistPath(spec.id);
    ensureDir(path.dirname(plistPath));
    fs.writeFileSync(plistPath, buildMacPlist(spec), 'utf-8');

    const notes: string[] = [];
    let started = false;
    try {
        // `launchctl bootstrap gui/<uid>` is the modern replacement for
        // `launchctl load -w`. The fallback covers older macOS where
        // bootstrap isn't available.
        const uid = String(process.getuid?.() ?? '');
        try {
            execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
        } catch {
            execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' });
        }
        started = true;
    } catch (err: any) {
        notes.push(`launchctl bootstrap failed: ${err?.message ?? err}. Restart your Mac to pick up the LaunchAgent.`);
    }
    return { id: spec.id, servicePath: plistPath, started, notes };
}

function uninstallMac(id: string): { ok: boolean; notes: string[] } {
    const plistPath = macPlistPath(id);
    const notes: string[] = [];
    try {
        const uid = String(process.getuid?.() ?? '');
        try {
            execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
        } catch {
            try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch { /* ignore */ }
        }
    } catch (err: any) {
        notes.push(`launchctl bootout failed: ${err?.message ?? err}`);
    }
    try { fs.unlinkSync(plistPath); } catch { /* file may already be gone */ }
    return { ok: true, notes };
}

function statusMac(id: string): DaemonStatus {
    const plistPath = macPlistPath(id);
    if (!fileExists(plistPath)) return 'not-installed';
    try {
        const uid = String(process.getuid?.() ?? '');
        const out = execFileSync('launchctl', ['print', `gui/${uid}/com.codeatlas.${id}`], { encoding: 'utf-8' });
        return /state\s*=\s*running/i.test(out) ? 'running' : 'stopped';
    } catch { return 'stopped'; }
}

function buildMacPlist(spec: DaemonSpec): string {
    const logBase = path.join(logsDir(), spec.id);
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codeatlas.${spec.id}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(spec.nodeBin)}</string>
        <string>${escapeXml(spec.mcpServerJs)}</string>
        <string>${escapeXml(spec.workspacePath)}</string>
        <string>--browser</string>
        <string>--no-open</string>
        <string>--no-stdio</string>
        <string>--port</string>
        <string>${spec.port}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(spec.workspacePath)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logBase + '.log')}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logBase + '.err.log')}</string>
</dict>
</plist>
`;
}

// ── Linux — systemd user unit ───────────────────────────────────────────

function linuxUnitPath(id: string): string {
    const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
        ? process.env.XDG_CONFIG_HOME
        : path.join(os.homedir(), '.config');
    return path.join(xdg, 'systemd', 'user', `${id}.service`);
}

function installAndStartLinux(spec: DaemonSpec): DaemonInstallResult {
    const unitPath = linuxUnitPath(spec.id);
    ensureDir(path.dirname(unitPath));
    fs.writeFileSync(unitPath, buildLinuxUnit(spec), 'utf-8');

    const notes: string[] = [];
    let started = false;
    try {
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
        execFileSync('systemctl', ['--user', 'enable', '--now', `${spec.id}.service`], { stdio: 'ignore' });
        started = true;
    } catch (err: any) {
        notes.push(`systemctl --user failed: ${err?.message ?? err}.`);
        notes.push(`If systemd user services aren't available (some distros / WSL), start manually with:`);
        notes.push(`  node ${spec.mcpServerJs} ${spec.workspacePath} --browser --port ${spec.port}`);
    }
    return { id: spec.id, servicePath: unitPath, started, notes };
}

function uninstallLinux(id: string): { ok: boolean; notes: string[] } {
    const unitPath = linuxUnitPath(id);
    const notes: string[] = [];
    try {
        execFileSync('systemctl', ['--user', 'disable', '--now', `${id}.service`], { stdio: 'ignore' });
    } catch { /* unit may already be gone */ }
    try { fs.unlinkSync(unitPath); } catch { /* file may already be gone */ }
    try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch { /* best-effort */ }
    return { ok: true, notes };
}

function statusLinux(id: string): DaemonStatus {
    if (!fileExists(linuxUnitPath(id))) return 'not-installed';
    try {
        const out = execFileSync('systemctl', ['--user', 'is-active', `${id}.service`], { encoding: 'utf-8' }).trim();
        return out === 'active' ? 'running' : 'stopped';
    } catch { return 'stopped'; }
}

function buildLinuxUnit(spec: DaemonSpec): string {
    const logBase = path.join(logsDir(), spec.id);
    return `[Unit]
Description=CodeAtlas MCP — workspace ${spec.workspacePath}
After=network.target

[Service]
Type=simple
WorkingDirectory=${spec.workspacePath}
ExecStart=${spec.nodeBin} ${spec.mcpServerJs} ${spec.workspacePath} --browser --no-open --no-stdio --port ${spec.port}
StandardOutput=append:${logBase}.log
StandardError=append:${logBase}.err.log
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// ── Windows — Task Scheduler (schtasks) ─────────────────────────────────

function windowsTaskName(id: string): string {
    return `CodeAtlas MCP ${id}`;
}

function windowsTaskXmlPath(id: string): string {
    return path.join(logsDir(), `${id}.task.xml`);
}

function installAndStartWindows(spec: DaemonSpec): DaemonInstallResult {
    const xmlPath = windowsTaskXmlPath(spec.id);
    ensureDir(path.dirname(xmlPath));
    fs.writeFileSync(xmlPath, buildWindowsTaskXml(spec), 'utf-8');

    const notes: string[] = [];
    const taskName = windowsTaskName(spec.id);
    let started = false;
    try {
        // /F replaces an existing task with the same name (idempotency).
        execFileSync('schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'], { stdio: 'ignore' });
        execFileSync('schtasks', ['/Run', '/TN', taskName], { stdio: 'ignore' });
        started = true;
    } catch (err: any) {
        notes.push(`schtasks failed: ${err?.message ?? err}.`);
        notes.push(`Start manually:`);
        notes.push(`  node ${spec.mcpServerJs} ${spec.workspacePath} --browser --port ${spec.port}`);
    }
    return { id: spec.id, servicePath: xmlPath, started, notes };
}

function uninstallWindows(id: string): { ok: boolean; notes: string[] } {
    const notes: string[] = [];
    try {
        execFileSync('schtasks', ['/Delete', '/TN', windowsTaskName(id), '/F'], { stdio: 'ignore' });
    } catch { /* task may already be gone */ }
    try { fs.unlinkSync(windowsTaskXmlPath(id)); } catch { /* file may already be gone */ }
    return { ok: true, notes };
}

function statusWindows(id: string): DaemonStatus {
    try {
        const out = execFileSync('schtasks', ['/Query', '/TN', windowsTaskName(id), '/FO', 'LIST'], { encoding: 'utf-8' });
        return /Status:\s+Running/i.test(out) ? 'running' : 'stopped';
    } catch { return 'not-installed'; }
}

function buildWindowsTaskXml(spec: DaemonSpec): string {
    const userId = process.env.USERDOMAIN && process.env.USERNAME
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : process.env.USERNAME ?? 'CurrentUser';
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>CodeAtlas MCP — workspace ${escapeXml(spec.workspacePath)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>5</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(spec.nodeBin)}</Command>
      <Arguments>${escapeXml(spec.mcpServerJs)} ${escapeXml(spec.workspacePath)} --browser --no-open --no-stdio --port ${spec.port}</Arguments>
      <WorkingDirectory>${escapeXml(spec.workspacePath)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// ── helpers ─────────────────────────────────────────────────────────────

function logsDir(): string {
    return path.join(os.homedir(), '.config', 'codeatlas', 'logs');
}

function ensureLogsDir(_id: string): void {
    ensureDir(logsDir());
}

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

function fileExists(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
