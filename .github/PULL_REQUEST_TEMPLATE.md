## 📋 Description
<!--- Describe your changes in detail -->

## 🔗 Related Issues
<!--- Reference any related issues (e.g. Closes #123) -->

## 🛠 Type of Change
- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] ♻️ Code refactoring or cleanup
- [ ] 🌐 Localization update (`en`, `ru`, `sr`, `ja`)
- [ ] 📝 Documentation update
- [ ] 🔒 Security hardening

## ✅ Contributor Checklist
- [ ] I have read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
- [ ] Core vs. Overlay boundary respected: neutral mechanism lives in core; personal persona, bank names, and private prompts stay in `overlay/`.
- [ ] No secrets, real API keys, personal identifiers, or private overlay files are committed (`npm run check:leaks` passes).
- [ ] All 4 locales (`en`, `ru`, `sr`, `ja`) are updated for any user-facing UI or bot string changes.
- [ ] Backend verification passed cleanly:
  - `npm run check:leaks` (0 violations)
  - `npm run typecheck` (0 errors)
  - `npm test` (all tests pass)
  - `npm run build` (`tgcloud/` module cap <= 100 and bundle graph valid)
- [ ] Mini App verification passed cleanly (if `miniapp/` was changed):
  - `cd miniapp && npm run lint && npm test && npm run build`
- [ ] Documentation (`docs/system/`, `README*.md`) was updated if architecture, overlays, or configuration changed.
