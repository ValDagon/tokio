# Public overlay

Overlay of the public Tokio instance at `app9100920403` (`@LifeOS_Public_bot`). In content it is
the default `example/overlay`: neutral Tokio branding, prompts in all four locales (ru/en/sr/ja),
`spendLimitUsd: 2`. It is tracked here so a CI deploy and a manual deploy compile the same bundle.

Exactly three values differ from `example/overlay/manifest.json`:

- `id` = `tokio-public` — distinguishes this instance from `tokio-example` in logs and bundles.
- `brand.miniAppUrl` = `https://app9100920403.tgcloud.ai/` — the address behind the Mini App button.
- `features.publicOpenAccess` = `true` — the only explicit way to let users outside `ADMIN_IDS` and
  `BETA_WHITELIST` in; the example stays private.

Drift rule: when `example/overlay` changes, re-copy it here and re-apply these three edits.
