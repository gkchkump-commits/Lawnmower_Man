// First-run help shown as setup cards (src/ui/setup-cards.js): what to do when the Claude CLI is
// missing or not logged in, and the command for a manual local-voice setup.
//
// The install commands are the official ones from https://code.claude.com/docs/en/setup
// (checked 2026-10): native installer for PowerShell / CMD / macOS·Linux, WinGet, Homebrew and
// npm (needs Node.js 22+). The app only ever SHOWS them (with Copy buttons); it never runs an
// installer by itself.

export const CLAUDE_DOCS = Object.freeze({
  setup: 'https://code.claude.com/docs/en/setup',
  login: 'https://code.claude.com/docs/en/setup#authenticate',
  troubleshoot: 'https://code.claude.com/docs/en/troubleshoot-install',
});

export const CLAUDE_INSTALL = Object.freeze({
  win32: Object.freeze([
    { id: 'powershell', label: 'PowerShell (recommended)', command: 'irm https://claude.ai/install.ps1 | iex' },
    { id: 'winget', label: 'WinGet', command: 'winget install Anthropic.ClaudeCode' },
    { id: 'cmd', label: 'Command Prompt (CMD)', command: 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd' },
    { id: 'npm', label: 'npm (needs Node.js 22+)', command: 'npm install -g @anthropic-ai/claude-code' },
  ]),
  darwin: Object.freeze([
    { id: 'native', label: 'Terminal (recommended)', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
    { id: 'brew', label: 'Homebrew', command: 'brew install --cask claude-code' },
    { id: 'npm', label: 'npm (needs Node.js 22+)', command: 'npm install -g @anthropic-ai/claude-code' },
  ]),
  linux: Object.freeze([
    { id: 'native', label: 'Terminal (recommended)', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
    { id: 'npm', label: 'npm (needs Node.js 22+)', command: 'npm install -g @anthropic-ai/claude-code' },
  ]),
});

/** The command that starts Claude Code once, interactively, to log in. */
export const CLAUDE_LOGIN_COMMAND = 'claude';

/**
 * @typedef {{ text: string, command?: string, commandLabel?: string }} SetupStep
 * @typedef {object} SetupCardModel
 * @property {'cli-missing'|'auth'|'voice-manual'} kind
 * @property {string} title
 * @property {string} intro
 * @property {SetupStep[]} steps
 * @property {Array<{ label: string, command: string }>} [more]  other install methods (collapsed)
 * @property {string} [note]
 * @property {string} [detail]     the CLI's own message
 * @property {{ label: string, url: string }} [link]
 * @property {boolean} retry       show a Retry button
 */

/** @param {string} platform */
const terminalName = (platform) => (platform === 'win32' ? 'PowerShell' : 'a terminal');

/**
 * Card content for a Claude setup problem (ClaudeStatus.problem).
 * @param {{ kind: string, detail?: string }} problem
 * @param {string} platform  'win32' | 'darwin' | 'linux' | …
 * @returns {SetupCardModel|null}
 */
export function claudeSetupModel(problem, platform) {
  if (!problem || typeof problem !== 'object') return null;
  const plat = platform === 'win32' || platform === 'darwin' ? platform : 'linux';
  const methods = CLAUDE_INSTALL[plat];
  const detail = typeof problem.detail === 'string' ? problem.detail.trim() : '';
  if (problem.kind === 'cli-missing') {
    const [first, ...rest] = methods;
    return {
      kind: 'cli-missing',
      title: 'Install Claude Code',
      intro: 'Lawnmower Man talks through your own Claude Code CLI, and it was not found on this PC.',
      steps: [
        { text: `Open ${terminalName(plat)} and run:`, command: first.command, commandLabel: first.label },
        { text: 'Open a new terminal window, start Claude Code once and sign in (a Pro, Max, Team, Enterprise or Console account is needed):', command: CLAUDE_LOGIN_COMMAND },
        { text: 'Come back here and press Retry.' },
      ],
      more: rest.map((m) => ({ label: m.label, command: m.command })),
      note: 'Lawnmower Man never runs these commands for you. Installed somewhere else? Set Settings › Claude › CLI path.',
      detail,
      link: { label: 'Install guide', url: CLAUDE_DOCS.setup },
      retry: true,
    };
  }
  if (problem.kind === 'auth') {
    return {
      kind: 'auth',
      title: 'Sign in to Claude Code',
      intro: 'The Claude CLI is installed but not signed in, or its login expired.',
      steps: [
        { text: `Open ${terminalName(plat)} and start Claude Code:`, command: CLAUDE_LOGIN_COMMAND },
        { text: 'Follow the sign-in in your browser, then type /exit.' },
        { text: 'Come back here and press Retry.' },
      ],
      note: 'Using an API key instead? Make sure ANTHROPIC_API_KEY is valid (an old key overrides your subscription).',
      detail,
      link: { label: 'Sign-in help', url: CLAUDE_DOCS.login },
      retry: true,
    };
  }
  return null;
}

/**
 * Card for a voice setup the user runs by hand (no terminal could be opened, or the browser
 * preview).
 * @param {{ command?: string, detail?: string }} setup  VoiceInfo.setup
 * @returns {SetupCardModel|null}
 */
export function voiceManualModel(setup) {
  if (!setup || typeof setup.command !== 'string' || !setup.command) return null;
  return {
    kind: 'voice-manual',
    title: 'Set up local voice',
    intro: setup.detail || 'Run this command in a terminal to install the local voice:',
    steps: [
      { text: 'Run:', command: setup.command },
      { text: 'When it has finished, choose Restart voice (tray menu or Settings › Voice).' },
    ],
    retry: false,
  };
}

/** Lines of a failed setup step's output the drawer keeps (it shows about 12 at a time, scrollable). */
export const SETUP_TAIL_MAX_LINES = 20;

/**
 * What the settings drawer shows about the last local-voice setup run: the output tail of the
 * step that failed (pip prints its "ERROR: …" there), the setup log, and a text to copy for a
 * bug report.
 * @param {any} info  VoiceInfo (window.lawnmower.voice.info / onStatus)
 * @param {{ canOpenLog?: boolean }} [o]  canOpenLog: the bridge has voice.openSetupLog()
 * @returns {{ tail: string[], logPath: string, showOpenLog: boolean, copyText: string }}
 */
export function voiceSetupDiagnostics(info, o = {}) {
  const setup = info && typeof info === 'object' ? info.setup : null;
  const failed = !!setup && setup.state === 'failed';
  const raw = failed && Array.isArray(setup.errorTail) ? setup.errorTail : [];
  const tail = raw.filter((l) => typeof l === 'string' && l.trim()).map((l) => (l.length > 500 ? `${l.slice(0, 499)}…` : l)).slice(-SETUP_TAIL_MAX_LINES);
  const logPath = info && typeof info.setupLog === 'string' ? info.setupLog : '';
  const copy = [];
  if (failed && typeof setup.detail === 'string' && setup.detail) copy.push(setup.detail);
  if (tail.length) copy.push('', ...tail);
  if (logPath) copy.push('', `Setup log: ${logPath}`);
  return { tail, logPath, showOpenLog: !!logPath && o.canOpenLog !== false, copyText: copy.join('\n').trim() };
}
