# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository. Don't open a public issue.

We'll acknowledge the report within 3 business days and keep you updated until it's resolved.

## Scope

origami-cli handles your Origami API key. In scope:

- Leaking the key (logs, error messages, `--debug` output, config files with loose permissions)
- Sending the key anywhere other than the configured Origami API base URL
- Anything that makes a command act on a different org, project, or resource than requested

Vulnerabilities in the Origami API itself should go to Origami.

## Supported versions

Security fixes land on the latest minor release.
