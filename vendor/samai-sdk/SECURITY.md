# Security Policy

## Supported Versions

samai-sdk is currently pre-1.0. Security fixes are backported to the latest
minor release only.

| Version | Supported          |
| ------- | ------------------- |
| 0.3.x   | :white_check_mark:  |
| < 0.3   | :x:                  |

This table will be updated once the project reaches 1.0 and adopts a longer
support window for prior major versions.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report it privately using one of the following:

- **GitHub Security Advisories** (preferred): go to the
  [Security tab](https://github.com/Sameer9823/samai-sdk/security/advisories/new)
  of this repository and click "Report a vulnerability."
- **Email**: [security contact email — replace with a real monitored address]

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal repro script is ideal)
- The version of samai-sdk affected
- Any suggested fix or mitigation, if you have one

## What to expect

- **Acknowledgment** within 3 business days of your report.
- **Initial assessment** (severity, affected versions) within 7 days.
- **Fix or mitigation timeline** communicated once the issue is confirmed —
  critical issues are prioritized for an out-of-band patch release.
- Credit in the release notes and CHANGELOG, unless you prefer to remain
  anonymous.

## Scope notes specific to samai-sdk

Given the nature of this SDK, please pay particular attention to and report:

- Anything that could leak API keys, tokens, or credentials (e.g. through
  logging, tracing, or the `RunTrace` output)
- Prompt-injection or guardrail-bypass techniques that defeat
  `createPromptInjectionGuardrail`, `createPiiInputGuardrail`, or the
  approval-gating (`requiresApproval`) mechanism
- Issues in the optional Redis/SQLite session stores that could allow
  cross-session data leakage
- Supply-chain concerns (e.g. a compromised dependency, a suspicious
  postinstall/build script)

Thank you for helping keep samai-sdk and its users safe.
