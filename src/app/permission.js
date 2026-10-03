// Permission requests (agent mode): turn a tool call into a short, human-readable summary for
// the approval card, and a short sentence for the avatar to say. Nothing here approves
// anything — the card's Allow/Deny buttons do.

/**
 * @typedef {object} PermissionSummary
 * @property {string} title    e.g. "Run a command"
 * @property {string} target   the main subject (command, file path, URL, query) — may be ''
 * @property {string} [detail] a longer preview (file content, edit diff, prompt), clipped
 * @property {'danger'|'write'|'read'|'web'|'other'} risk
 * @property {Array<{ label: string, value: string }>} fields  other input fields, clipped
 */

const MAX_TARGET = 400;
const MAX_DETAIL = 1200;
const MAX_FIELD = 160;

/** @param {unknown} v @param {number} max */
export function clip(v, max) {
  let s;
  if (typeof v === 'string') s = v;
  else if (v === undefined || v === null) s = '';
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** @param {string} p */
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

/**
 * @param {string} toolName
 * @param {Record<string, any>} input
 * @returns {PermissionSummary}
 */
export function summarizeToolInput(toolName, input) {
  const name = String(toolName || 'tool');
  const inp = input && typeof input === 'object' ? input : {};
  const rest = (/** @type {string[]} */ used) => Object.entries(inp)
    .filter(([k, v]) => !used.includes(k) && v !== undefined && v !== null && v !== '')
    .slice(0, 6)
    .map(([k, v]) => ({ label: k, value: clip(v, MAX_FIELD) }));

  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return {
        title: inp.description ? clip(inp.description, 120) : 'Run a command',
        target: clip(inp.command, MAX_TARGET),
        risk: 'danger',
        fields: rest(['command', 'description']),
      };
    case 'Write':
      return {
        title: `Write ${baseName(inp.file_path)}`,
        target: clip(inp.file_path, MAX_TARGET),
        detail: clip(inp.content, MAX_DETAIL),
        risk: 'write',
        fields: rest(['file_path', 'content']),
      };
    case 'Edit':
      return {
        title: `Edit ${baseName(inp.file_path)}`,
        target: clip(inp.file_path, MAX_TARGET),
        detail: diffPreview(inp.old_string, inp.new_string),
        risk: 'write',
        fields: rest(['file_path', 'old_string', 'new_string']),
      };
    case 'MultiEdit':
      return {
        title: `Edit ${baseName(inp.file_path)} (${Array.isArray(inp.edits) ? inp.edits.length : 0} changes)`,
        target: clip(inp.file_path, MAX_TARGET),
        detail: Array.isArray(inp.edits) ? clip(inp.edits.map((e) => diffPreview(e?.old_string, e?.new_string)).join('\n…\n'), MAX_DETAIL) : '',
        risk: 'write',
        fields: rest(['file_path', 'edits']),
      };
    case 'NotebookEdit':
      return { title: `Edit notebook ${baseName(inp.notebook_path)}`, target: clip(inp.notebook_path, MAX_TARGET), detail: clip(inp.new_source, MAX_DETAIL), risk: 'write', fields: rest(['notebook_path', 'new_source']) };
    case 'Read':
      return { title: `Read ${baseName(inp.file_path)}`, target: clip(inp.file_path, MAX_TARGET), risk: 'read', fields: rest(['file_path']) };
    case 'Glob':
      return { title: 'Find files', target: clip(inp.pattern, MAX_TARGET), risk: 'read', fields: rest(['pattern']) };
    case 'Grep':
      return { title: 'Search in files', target: clip(inp.pattern, MAX_TARGET), risk: 'read', fields: rest(['pattern']) };
    case 'WebFetch':
      return { title: 'Fetch a web page', target: clip(inp.url, MAX_TARGET), detail: clip(inp.prompt, MAX_DETAIL), risk: 'web', fields: rest(['url', 'prompt']) };
    case 'WebSearch':
      return { title: 'Search the web', target: clip(inp.query, MAX_TARGET), risk: 'web', fields: rest(['query']) };
    case 'Task':
    case 'Agent':
      return { title: inp.description ? `Start a sub-agent: ${clip(inp.description, 80)}` : 'Start a sub-agent', target: '', detail: clip(inp.prompt, MAX_DETAIL), risk: 'other', fields: rest(['description', 'prompt']) };
    default: {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
      const title = mcp ? `Use ${mcp[2].replace(/_/g, ' ')} (${mcp[1]})` : `Use ${name}`;
      return { title, target: '', risk: 'other', fields: rest([]) };
    }
  }
}

/** @param {unknown} a @param {unknown} b */
function diffPreview(a, b) {
  const lines = [];
  for (const l of String(a ?? '').split('\n').slice(0, 12)) lines.push(`- ${l}`);
  for (const l of String(b ?? '').split('\n').slice(0, 12)) lines.push(`+ ${l}`);
  return clip(lines.join('\n'), MAX_DETAIL);
}

/**
 * What the avatar says when a permission card appears.
 * @param {string} toolName @param {Record<string, any>} [input]
 */
export function spokenPermissionPrompt(toolName, input = {}) {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return 'I need your permission to run a command.';
    case 'Write':
      return `May I write the file ${spokenFile(input.file_path)}?`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `May I edit ${spokenFile(input.file_path || input.notebook_path)}?`;
    case 'WebFetch':
    case 'WebSearch':
      return 'May I look this up on the web?';
    default:
      return `I need your permission to use ${String(toolName || 'a tool').replace(/^mcp__.*?__/, '').replace(/_/g, ' ')}.`;
  }
}

/** "C:\\work\\notes.md" → "notes dot md" style is overkill; just the base name. @param {unknown} p */
function spokenFile(p) {
  const b = baseName(String(p || ''));
  return b ? b : 'this file';
}

/**
 * A short spoken cue when Claude starts using a tool (said at most once per turn).
 * @param {string} toolName
 */
export function toolCue(toolName) {
  switch (toolName) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'Let me take a look.';
    case 'WebSearch':
    case 'WebFetch':
      return 'Let me look that up.';
    case 'Bash':
    case 'PowerShell':
      return 'One moment.';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return 'Working on it.';
    default:
      return 'One moment.';
  }
}

/** One-line label for a tool chip in the transcript. @param {string} name @param {Record<string, any>} input */
export function toolChipLabel(name, input) {
  const s = summarizeToolInput(name, input);
  const t = s.target ? `: ${clip(s.target.replace(/\s+/g, ' '), 70)}` : '';
  switch (name) {
    case 'Bash': case 'PowerShell': return `Running${t}`;
    case 'Read': return `Reading ${baseName(input?.file_path)}`;
    case 'Write': return `Writing ${baseName(input?.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${baseName(input?.file_path)}`;
    case 'Glob': return `Finding files${t}`;
    case 'Grep': return `Searching${t}`;
    case 'WebSearch': return `Searching the web${t}`;
    case 'WebFetch': return `Fetching${t}`;
    default: return s.title;
  }
}
