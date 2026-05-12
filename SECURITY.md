# Security Policy

## Reporting Security Issues

Please do not open a public GitHub issue for security vulnerabilities.

If you find a security issue, contact the maintainer privately. If no private contact is listed for the fork you are using, open a minimal public issue asking for a private security contact without sharing exploit details.

## Secrets

Never commit real secrets, tokens, or API keys.

Sensitive values should live in Railway variables or a local `.env` file that is not committed:

- `TELEGRAM_BOT_TOKEN`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_MAPS_API_KEY`
- `GOOGLE_CLIENT_SECRET`
- Google refresh tokens stored in Supabase

If a secret is exposed, rotate it immediately in the relevant provider dashboard.

## Supported Version

Security fixes are expected to land on the `main` branch.
