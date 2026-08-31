# Security policy

Please report vulnerabilities privately through GitHub Security Advisories for `nerdynigel/signalk-wakelogger`. Do not open a public issue containing credentials, vessel locations or exploit details.

Only the latest released version receives security fixes during pre-1.0 development. Reports should include affected version, reproduction steps and impact without real production secrets. Maintainers will acknowledge a report as soon as practical and coordinate disclosure after a fix is available.

The plugin requires validated TLS and never supports `rejectUnauthorized: false`. Logs and diagnostic reports must be reviewed for vessel location privacy and must not contain pairing codes, passwords, tokens or private keys.
