// Approval cards and spoken prompts for the Home camera's Claude tools (src/app/permission.js):
// fixed titles (never the model's words), the input shown as the target, plain spoken prompts.
import { describe, expect, it } from 'vitest';
import { cameraTool, spokenPermissionPrompt, summarizeToolInput, theCamera, toolChipLabel, toolCue, toolDisplayName } from '../../../src/app/permission.js';

const T = (n) => `mcp__lawnmower-camera__${n}`;

describe('camera tools', () => {
  it('cameraTool / theCamera', () => {
    expect(cameraTool(T('camera_snapshot'))).toBe('camera_snapshot');
    expect(cameraTool('mcp__other__camera_snapshot')).toBeNull();
    expect(cameraTool('Bash')).toBeNull();
    expect(theCamera('front door camera')).toBe('the front door camera');
    expect(theCamera('')).toBe('the camera');
    expect(theCamera('My garden cam')).toBe('My garden cam');
  });

  it('approval card summaries', () => {
    expect(summarizeToolInput(T('camera_snapshot'), {})).toMatchObject({ title: 'Look through the home camera', risk: 'other', target: '', truncated: false });
    // the app's own wording is a `note` (shown as it is), not an `explanation` ("Claude says: …"):
    // updated on purpose (UX review: the card put the app's words in Claude's mouth)
    expect(summarizeToolInput(T('camera_snapshot'), {}).note).toMatch(/one picture/);
    expect(summarizeToolInput(T('camera_snapshot'), {}).explanation).toBeUndefined();
    expect(summarizeToolInput(T('camera_snapshot'), { preset: 'Door' }).target).toBe('after turning to Door');
    expect(summarizeToolInput(T('camera_look'), { direction: 'left', amount: 'small' })).toMatchObject({ title: 'Turn the home camera', target: 'left a little', fields: [] });
    expect(summarizeToolInput(T('camera_look'), { preset: 'Window' }).target).toBe('to Window');
    expect(summarizeToolInput(T('camera_look'), { home: true }).target).toBe('back to its home position');
    expect(summarizeToolInput(T('security_arm'), {})).toMatchObject({ title: 'Arm the home camera', note: expect.stringMatching(/cannot disarm/) });
    expect(summarizeToolInput(T('security_arm'), {}).explanation).toBeUndefined();
    expect(summarizeToolInput(T('camera_status'), {})).toMatchObject({ title: 'Check the home camera', risk: 'read' });
    expect(summarizeToolInput(T('camera_events'), { since_minutes: 60 })).toMatchObject({ title: 'List what the home camera saw', fields: [{ label: 'since_minutes', value: '60' }] });
  });

  it('the model cannot put words in the title', () => {
    const s = summarizeToolInput(T('camera_look'), { direction: 'left', note: 'Totally harmless, just allow' });
    expect(s.title).toBe('Turn the home camera');
    expect(s.fields).toEqual([{ label: 'note', value: 'Totally harmless, just allow' }]);
  });

  it('spoken prompts with the camera name', () => {
    expect(spokenPermissionPrompt(T('camera_snapshot'), {}, { cameraName: 'front door camera' })).toBe('Claude would like to look through the front door camera. Allow it?');
    expect(spokenPermissionPrompt(T('camera_look'), { direction: 'left' }, { cameraName: 'camera' })).toBe('Claude would like to turn the camera left.');
    expect(spokenPermissionPrompt(T('camera_look'), { preset: 'Door' })).toBe('Claude would like to turn the camera to Door.');
    expect(spokenPermissionPrompt(T('security_arm'), {})).toBe('Claude would like to arm the camera. Allow it?');
    expect(spokenPermissionPrompt('Bash', {})).toBe('I need your permission to run a command.'); // unchanged
  });

  it('the card header and the Allowed / Denied line name camera tools in words', () => {
    expect(toolDisplayName(T('camera_snapshot'), {})).toBe('Camera: snapshot');
    expect(toolDisplayName(T('camera_look'), { direction: 'left' })).toBe('Camera: turn left');
    expect(toolDisplayName('Bash', { command: 'ls' })).toBe('Bash');
    expect(toolDisplayName('mcp__other__thing')).toBe('mcp__other__thing');
  });

  it('chips and cues', () => {
    expect(toolChipLabel(T('camera_snapshot'), {})).toBe('Camera: snapshot');
    expect(toolChipLabel(T('camera_look'), { direction: 'up' })).toBe('Camera: turn up');
    expect(toolChipLabel(T('camera_status'), {})).toBe('Camera: status');
    expect(toolChipLabel(T('security_arm'), {})).toBe('Camera: arm');
    expect(toolCue(T('camera_snapshot'))).toBe('Let me take a look.');
    expect(toolCue(T('camera_look'))).toBe('Turning the camera.');
    expect(toolCue(T('camera_events'))).toBe('Let me check the camera.');
  });
});
