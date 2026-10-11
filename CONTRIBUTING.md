# Contributing to Lawnmower Man

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with the **Bug report** template and include:

* your Windows version, GPU and Lawnmower Man version (tray icon → the version is in *Settings*);
* what you did, what you expected and what happened;
* the log file (tray menu → *Open logs folder*). For voice problems also the setup log
  (*Settings → Voice → Open setup log*). Remove anything private before you attach it.

Security problems: please do not open a public issue, see [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/gkchkump-commits/Lawnmower_Man.git
cd Lawnmower_Man
npm ci
npm run dev            # Vite + Electron with hot reload
```

The local voice is optional; `scripts/setup-voice.cmd` (Windows) or `scripts/setup-voice.sh` set it up
(see [docs/VOICE.md](docs/VOICE.md)). Without it the app uses the system voice.

## Before you open a pull request

Run what CI runs:

```bash
npm run lint
npm test               # unit tests (vitest)
npm run build
npm run test:e2e       # Playwright (Chromium with software WebGL)
npm run test:voice     # only if you changed voice/
```

* Keep pull requests focused: one feature or fix per PR.
* Add or update tests with the change, and update the docs it affects (README for user-facing
  behaviour, `docs/ARCHITECTURE.md` for interfaces between the parts).
* Match the style of the code around you: plain ES modules with JSDoc types, pure logic in small
  testable modules, short comments that explain *why*.
* Avatar and animation changes: attach before/after screenshots or a short clip
  (`tools/visual/` has the screenshot, compare and film tools).
* Privacy is a feature: the app must not send anything to the network except Claude turns the user
  makes. Do not add analytics, remote assets or CDN loads.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
