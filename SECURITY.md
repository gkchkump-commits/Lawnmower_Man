# Security policy

Lawnmower Man runs the Claude CLI on your computer, can use your microphone and camera, and (in
Agent mode) lets Claude use tools after you approve them. Security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on
[the repository page](https://github.com/gkchkump-commits/Lawnmower_Man/security/advisories/new).

Include the version, what an attacker can do, and steps to reproduce. You will get an answer as
soon as possible; please give a reasonable time for a fix before you publish details.

## Scope

In scope: the Electron app (main process, preload, renderer), the local voice server, the setup
scripts and the installer. Out of scope: the Claude CLI itself and the third-party models and
libraries listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (report those upstream).
