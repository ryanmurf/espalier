# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| 1.x     | Security fixes only |
| < 1.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@espalier.dev** (or open a [private security advisory](https://github.com/ryanmurf/espalier/security/advisories/new) on GitHub).

Please include:

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact

You can expect an initial response within 48 hours and a resolution timeline within 7 days.

## Security Practices

- All SQL queries use parameterized statements
- SQL identifiers are validated and quoted
- Input validation at all system boundaries
- No `eval()` or dynamic code execution
- Dependencies are regularly audited
