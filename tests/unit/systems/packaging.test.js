// What the Windows installer build must look like (package.json "build", electron-builder 26) and
// the release workflow that builds, installs, tests and publishes it. The real proof is a build:
// `npx electron-builder --linux dir` + `scripts/electron-e2e.mjs --packaged` here, and
// .github/workflows/release.yml on windows-latest; these checks catch config regressions early.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
/** Text as in the repository: Windows checkouts may turn LF into CRLF. @param {string} rel */
const readText = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const build = pkg.build;

/** Sizes stored in an .ico file (ICONDIR / ICONDIRENTRY). @param {Buffer} b */
function icoSizes(b) {
  expect(b.readUInt16LE(0)).toBe(0);
  expect(b.readUInt16LE(2)).toBe(1); // 1 = icon
  const n = b.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const w = b[e] || 256;
    const bytes = b.readUInt32LE(e + 8);
    const offset = b.readUInt32LE(e + 12);
    expect(offset + bytes).toBeLessThanOrEqual(b.length);
    const png = b.subarray(offset, offset + 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    out.push({ size: w, png, bpp: b.readUInt16LE(e + 6) });
  }
  return out;
}

describe('package.json build (electron-builder)', () => {
  it('has sane Windows metadata', () => {
    expect(pkg.productName).toBe('Lawnmower Man');
    expect(pkg.author?.name).toBe('gkchkump-commits'); // → exe CompanyName, Apps & features "Publisher"
    expect(pkg.description).toMatch(/Claude/);
    expect(build.appId).toBe('com.lawnmower.avatar');
    expect(build.copyright).toMatch(/gkchkump-commits/);
    expect(build.publish).toBeNull(); // no auto-update feed; the release workflow publishes with gh
  });

  it('builds an unsigned per-user NSIS installer (no admin) and a portable exe, x64', () => {
    const targets = Object.fromEntries(build.win.target.map((t) => [t.target, t.arch]));
    expect(targets).toEqual({ nsis: ['x64'], portable: ['x64'] });
    expect(build.win.requestedExecutionLevel).toBe('asInvoker');
    const n = build.nsis;
    expect(n).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,
    });
    // the install-mode page ("for me / for all users") is skipped: always the current user
    const nsh = readText(n.include);
    expect(nsh).toMatch(/!macro customInstallMode\s+StrCpy \$isForceCurrentInstall "1"\s+!macroend/);
  });

  it('uninstall asks before deleting the voice and settings (default No); updates and /S never delete', () => {
    const nsh = readText(build.nsis.include);
    const m = nsh.match(/!macro customUnInstall\n([\s\S]*?)\n!macroend/);
    expect(m, 'customUnInstall macro').toBeTruthy();
    const body = m[1];
    // the guard comes first: an update (the old uninstaller runs with /S --updated) or a silent
    // uninstall never reaches the question or the deletes
    const guard = body.indexOf('${ifNot} ${isUpdated}');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('${andIfNot} ${Silent}')).toBeGreaterThan(guard);
    expect(body.indexOf('$LOCALAPPDATA != ""')).toBeGreaterThan(guard);
    expect(body.indexOf('$APPDATA != ""')).toBeGreaterThan(guard);
    const ask = body.indexOf('MessageBox MB_YESNO');
    expect(ask).toBeGreaterThan(guard);
    expect(body).toMatch(/MB_DEFBUTTON2 [^\n]*\/SD IDNO IDYES/); // No is the default, also when silent
    // only the app's own two folders are deleted, and only after the question
    const deletes = [...body.matchAll(/RMDir(?: \/r)? "([^"]+)"/g)].map((x) => ({ dir: x[1], at: x.index }));
    expect(deletes.map((d) => d.dir)).toEqual(['$LOCALAPPDATA\\LawnmowerMan\\voice', '$LOCALAPPDATA\\LawnmowerMan', '$APPDATA\\${APP_FILENAME}']);
    for (const d of deletes) expect(d.at).toBeGreaterThan(ask);
    expect(body).toMatch(/RMDir "\$LOCALAPPDATA\\LawnmowerMan"\n/); // the parent only when empty (no /r)
    // ASCII only: makensis reads the include in the system code page unless it has a BOM
    expect(/[^\x00-\x7f]/.test(nsh)).toBe(false);
  });

  it('names the artifacts without spaces', () => {
    const name = (tpl) => tpl.replace('${version}', pkg.version).replace('${ext}', 'exe');
    expect(name(build.nsis.artifactName)).toBe(`Lawnmower-Man-Setup-${pkg.version}.exe`);
    expect(name(build.portable.artifactName)).toBe(`Lawnmower-Man-${pkg.version}-portable.exe`);
    for (const a of [build.nsis.artifactName, build.portable.artifactName, build.linux.artifactName]) expect(a).not.toMatch(/\s|\$\{productName\}/);
  });

  it('uses the hologram badge as a multi-size .ico for the exe, installer and uninstaller', () => {
    for (const k of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) expect(build.nsis[k]).toBe('electron/assets/icon.ico');
    expect(build.win.icon).toBe('electron/assets/icon.ico');
    const sizes = icoSizes(fs.readFileSync(path.join(root, 'electron/assets/icon.ico')));
    expect(sizes.map((s) => s.size)).toEqual([16, 24, 32, 48, 64, 128, 256]);
    expect(sizes.every((s) => s.bpp === 32)).toBe(true);
    expect(sizes.filter((s) => s.png).map((s) => s.size)).toEqual([256]); // small sizes as BMP: read by every tool
    const png = fs.readFileSync(path.join(root, 'electron/assets/icon.png'));
    expect(png.readUInt32BE(16)).toBe(512); // IHDR width
    expect(png.readUInt32BE(20)).toBe(512);
    for (const f of ['tray.png', 'tray@1.5x.png', 'tray@2x.png']) expect(fs.existsSync(path.join(root, 'electron/assets', f))).toBe(true);
  });

  it('packs the runtime and nothing else', () => {
    expect(build.asar).toBe(true);
    expect(build.files).toEqual(expect.arrayContaining(['dist/**', 'electron/**', 'package.json', '!**/node_modules/**', '!dist/dev/**', '!electron/assets/*.ico', '!electron/assets/*.nsh']));
    expect(build.files.some((f) => /^(tests|tools|docs|voice|scripts)\b/.test(f))).toBe(false);
    const voice = build.extraResources.find((r) => r.from === 'voice');
    expect(voice.to).toBe('voice');
    expect(voice.filter).toEqual(expect.arrayContaining(['!.venv/**', '!**/__pycache__/**', '!tests/**', '!models/**', '!**/*.egg-info/**', '!setup*.log']));
    const scripts = build.extraResources.find((r) => r.from === 'scripts');
    expect(scripts).toMatchObject({ to: 'scripts', filter: ['setup-voice.ps1', 'setup-voice.cmd', 'setup-voice.sh'] });
    expect(build.extraResources.some((r) => r.from === 'THIRD_PARTY_NOTICES.md')).toBe(true);
    // main.js imports only node: built-ins and its own files: no node_modules at runtime
    for (const f of fs.readdirSync(path.join(root, 'electron')).filter((x) => /\.(m?js|cjs)$/.test(x))) {
      const src = readText(path.join('electron', f));
      for (const m of src.matchAll(/(?:import\s[^'"]*from\s|import\(|require\()\s*['"]([^'"]+)['"]/g)) {
        expect(m[1].startsWith('node:') || m[1].startsWith('./') || m[1] === 'electron', `${f}: ${m[1]}`).toBe(true);
      }
    }
  });

  it('ships the camera\'s face tracker: the model from public/, the wasm runtime copied into dist/', async () => {
    const { VISION_WASM_DIR, VISION_WASM_FILES, visionWasmSourceDir } = await import('../../../scripts/vite-vision-wasm.mjs');
    expect(fs.statSync(path.join(root, 'public/assets/vision/face_landmarker.task')).size).toBeGreaterThan(3_000_000);
    expect(pkg.dependencies['@mediapipe/tasks-vision']).toBe('1.1.0'); // pinned: the wasm and the JS API must match
    expect(VISION_WASM_DIR).toBe('assets/vision/wasm');
    const src = visionWasmSourceDir(root);
    for (const f of VISION_WASM_FILES) expect(fs.existsSync(path.join(src, f)), f).toBe(true);
    expect(readText('vite.config.js')).toMatch(/plugins: \[visionWasm\(/);
    // dist/** is packed; nothing excludes the vision assets (only dev pages and previews)
    expect(build.files.filter((f) => f.startsWith('!dist'))).toEqual(['!dist/dev/**', '!dist/assets/avatars/*/preview/**']);
    // the packaged smoke test looks for them inside app.asar
    expect(readText('scripts/electron-e2e.mjs')).toContain('app.asar/dist/assets/vision/wasm/vision_wasm_module_internal.wasm');
    // the notices name what the shipped wasm links in (a MediaPipe bump must keep them true)
    const notices = readText('THIRD_PARTY_NOTICES.md');
    for (const w of ['TensorFlow Lite', 'XNNPACK', 'Protocol Buffers', 'Eigen', 'OpenCV', '## BSD-3-Clause License', 'MPL-2.0']) expect(notices, w).toContain(w);
  });

  it('has the build scripts the docs and the workflow use', () => {
    expect(pkg.scripts['dist:win']).toBe('vite build && electron-builder --win --publish never');
    expect(pkg.scripts['dist:linux-dir']).toMatch(/electron-builder --linux dir --publish never/);
    expect(pkg.scripts['test:packaged']).toBe('node scripts/electron-e2e.mjs --packaged');
  });
});

describe('.github/workflows/release.yml', () => {
  const yml = readText('.github/workflows/release.yml');

  it('builds unsigned on windows-latest and tests the INSTALLED app', () => {
    expect(yml).toMatch(/runs-on: windows-latest/);
    expect(yml).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
    expect(yml).toContain('npm run dist:win');
    expect(yml).toContain("'/S', \"/D=$dest\"");
    expect(yml).toContain('node scripts/electron-e2e.mjs --packaged');
    expect(yml).toContain('ELECTRON_PATH: ${{ env.INSTALLED_EXE }}');
    for (const f of ['resources\\app.asar', 'resources\\voice\\lawnmower_voice\\__main__.py', 'resources\\scripts\\setup-voice.ps1', 'Uninstall Lawnmower Man.exe']) expect(yml).toContain(f);
    expect(yml).toContain("electron\\assets\\icon.ico"); // the exe icon is compared with it
    expect(yml).toContain(`Lawnmower-Man-Setup-$v.exe`);
    expect(yml).toContain(`Lawnmower-Man-$v-portable.exe`);
  });

  it('installs over the existing install and checks that the update and the silent uninstall keep user data', () => {
    const steps = yml.split(/\n {6}- name: /);
    const update = steps.find((s) => s.startsWith('Install again over the existing install'));
    const uninstall = steps.find((s) => s.startsWith('Uninstall silently'));
    expect(update, 'update step').toBeTruthy();
    expect(uninstall, 'uninstall step').toBeTruthy();
    expect(steps.indexOf(update)).toBeLessThan(steps.indexOf(uninstall));
    for (const s of [update, uninstall]) {
      expect(s).toContain("'LawnmowerMan\\voice\\.venv\\lawnmower-ci-marker.txt'");
      expect(s).toContain("'Lawnmower Man\\lawnmower-ci-marker.txt'");
    }
    expect(update).toContain("'/S', \"/D=$env:INSTALL_DIR\"");
    expect(update).toMatch(/the update deleted user data/);
    expect(uninstall).toMatch(/the silent uninstall deleted user data/);
  });

  it('publishes only for v* tag pushes and releases published on GitHub (never for PRs or manual runs)', () => {
    expect(yml).toMatch(/tags: \['v\*'\]/);
    expect(yml).toMatch(/release:\n {4}types: \[published\]/);
    const cond = yml.match(/^ {4}if: (.*)$/m)?.[1] || '';
    expect(cond).toContain("(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v'))");
    expect(cond).toContain("(github.event_name == 'release' && startsWith(github.ref, 'refs/tags/v'))");
    expect(cond).not.toMatch(/pull_request|workflow_dispatch/);
    // an existing (web-published) release gets the files; its own notes are kept
    expect(yml).toMatch(/gh release upload "\$GITHUB_REF_NAME" "\$\{files\[@\]\}" --repo "\$GITHUB_REPOSITORY" --clobber/);
    expect(yml).toMatch(/needs: windows-installer/);
    expect(yml).toMatch(/--prerelease/);
    // write access only in the publish job
    expect(yml.match(/contents: write/g)).toHaveLength(1);
    expect(yml).toMatch(/^permissions:\n {2}contents: read/m);
  });
});
