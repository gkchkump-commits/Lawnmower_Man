// Permission requests (agent mode): turn a tool call into a short, human-readable summary for
// the approval card, and a short sentence for the avatar to say. Nothing here approves
// anything — the card's Allow/Deny buttons do.

/**
 * @typedef {object} PermissionSummary
 * @property {string} title    fixed wording from the tool name, e.g. "Run a command" — never
 *                             text the model wrote (that goes in `explanation`)
 * @property {string} [explanation] the model's own description of the call (Bash/PowerShell);
 *                             shown as "Claude says: …", never as the title
 * @property {string} target   the main subject (command, file path, URL, query) — may be ''
 * @property {string} [detail] a longer preview (file content, edit diff, prompt)
 * @property {'danger'|'write'|'read'|'web'|'other'} risk
 * @property {Array<{ label: string, value: string }>} fields  other input fields
 * @property {boolean} truncated  something approved by Allow is not shown in full (target,
 *                             detail or a field was shortened, or fields were left out). The
 *                             card then keeps Allow disabled until the user opens "Show all".
 * @property {number} hiddenChars  how many characters are not shown (0 when not truncated)
 */

// Generous preview sizes: typical commands, paths and edits fit completely. Anything longer is
// marked `truncated` — never silently cut (Allow approves the full input).
const MAX_TARGET = 2000;
const MAX_DETAIL = 4000;
const MAX_FIELD = 400;
const MAX_FIELDS = 12;

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

/** @param {unknown} v */
function asText(v) {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

/**
 * Summarise a tool call for the approval card.
 * @param {string} toolName
 * @param {Record<string, any>} input
 * @param {{ full?: boolean }} [o]  full: nothing is shortened (the card's "Show all" view)
 * @returns {PermissionSummary}
 */
export function summarizeToolInput(toolName, input, o = {}) {
  const name = String(toolName || 'tool');
  const inp = input && typeof input === 'object' ? input : {};
  const full = !!o.full;
  let hidden = 0;
  let truncated = false;
  /** Preview of an approved value: shortened only when not `full`, and then flagged. */
  const show = (/** @type {unknown} */ v, /** @type {number} */ max) => {
    const s = asText(v);
    if (full || s.length <= max) return s;
    truncated = true;
    hidden += s.length - (max - 1);
    return `${s.slice(0, max - 1)}…`;
  };
  const rest = (/** @type {string[]} */ used) => {
    const entries = Object.entries(inp).filter(([k, v]) => !used.includes(k) && v !== undefined && v !== null && v !== '');
    const shown = full ? entries : entries.slice(0, MAX_FIELDS);
    for (const [k, v] of entries.slice(shown.length)) {
      truncated = true;
      hidden += k.length + asText(v).length;
    }
    return shown.map(([k, v]) => ({ label: k, value: show(v, MAX_FIELD) }));
  };
  const diff = (/** @type {unknown} */ a, /** @type {unknown} */ b) => [
    ...asText(a).split('\n').map((l) => `- ${l}`),
    ...asText(b).split('\n').map((l) => `+ ${l}`),
  ].join('\n');

  /** @type {Omit<PermissionSummary, 'truncated'|'hiddenChars'>} */
  let s;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      // The title is fixed: `description` is written by the model and could claim anything
      // ("List files (read-only)") — it is shown separately, labelled as Claude's words.
      s = {
        title: 'Run a command',
        explanation: inp.description ? clip(inp.description, 300) : '',
        target: show(inp.command, MAX_TARGET),
        risk: 'danger',
        fields: rest(['command', 'description']),
      };
      break;
    case 'Write':
      s = {
        title: `Write ${baseName(inp.file_path)}`,
        target: show(inp.file_path, MAX_TARGET),
        detail: show(inp.content, MAX_DETAIL),
        risk: 'write',
        fields: rest(['file_path', 'content']),
      };
      break;
    case 'Edit':
      s = {
        title: `Edit ${baseName(inp.file_path)}`,
        target: show(inp.file_path, MAX_TARGET),
        detail: show(diff(inp.old_string, inp.new_string), MAX_DETAIL),
        risk: 'write',
        fields: rest(['file_path', 'old_string', 'new_string']),
      };
      break;
    case 'MultiEdit':
      s = {
        title: `Edit ${baseName(inp.file_path)} (${Array.isArray(inp.edits) ? inp.edits.length : 0} changes)`,
        target: show(inp.file_path, MAX_TARGET),
        detail: Array.isArray(inp.edits) ? show(inp.edits.map((e) => diff(e?.old_string, e?.new_string)).join('\n…\n'), MAX_DETAIL) : '',
        risk: 'write',
        fields: rest(['file_path', 'edits']),
      };
      break;
    case 'NotebookEdit':
      s = { title: `Edit notebook ${baseName(inp.notebook_path)}`, target: show(inp.notebook_path, MAX_TARGET), detail: show(inp.new_source, MAX_DETAIL), risk: 'write', fields: rest(['notebook_path', 'new_source']) };
      break;
    case 'Read':
      s = { title: `Read ${baseName(inp.file_path)}`, target: show(inp.file_path, MAX_TARGET), risk: 'read', fields: rest(['file_path']) };
      break;
    case 'Glob':
      s = { title: 'Find files', target: show(inp.pattern, MAX_TARGET), risk: 'read', fields: rest(['pattern']) };
      break;
    case 'Grep':
      s = { title: 'Search in files', target: show(inp.pattern, MAX_TARGET), risk: 'read', fields: rest(['pattern']) };
      break;
    case 'WebFetch':
      s = { title: 'Fetch a web page', target: show(inp.url, MAX_TARGET), detail: show(inp.prompt, MAX_DETAIL), risk: 'web', fields: rest(['url', 'prompt']) };
      break;
    case 'WebSearch':
      s = { title: 'Search the web', target: show(inp.query, MAX_TARGET), risk: 'web', fields: rest(['query']) };
      break;
    case 'Task':
    case 'Agent':
      s = { title: 'Start a sub-agent', explanation: inp.description ? clip(inp.description, 300) : '', target: '', detail: show(inp.prompt, MAX_DETAIL), risk: 'other', fields: rest(['description', 'prompt']) };
      break;
    default: {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
      const title = mcp ? `Use ${mcp[2].replace(/_/g, ' ')} (${mcp[1]})` : `Use ${name}`;
      s = { title, target: '', risk: 'other', fields: rest([]) };
    }
  }
  return { ...s, truncated, hiddenChars: truncated ? hidden : 0 };
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
