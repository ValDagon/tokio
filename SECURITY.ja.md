[English](SECURITY.md) | [Русский](SECURITY.ru.md) | [Srpski](SECURITY.sr.md) | **日本語**

# セキュリティポリシー

## サポート対象バージョン

| バージョン | サポート状況 |
| :--- | :--- |
| `3.x` | :white_check_mark: |
| `< 3.0` | :x: |

---

## 脆弱性の報告

**Tokio** ではセキュリティを最重要事項として扱っています。セキュリティ上の脆弱性を発見した場合は、公開の GitHub Issue・Pull Request・ディスカッションには**投稿しないでください**。

### 非公開報告の手順

1. [GitHub Security Advisories](https://github.com/ValDagon/tokio/security/advisories) から **Private Vulnerability Report** を作成してください。
2. 調査と再現に必要な以下の情報をご記載ください：
   - 問題の種類（シークレット漏洩、認証回避、IDOR・テナント分離不備、プロンプトインジェクション、XSS、SQL インジェクションなど）。
   - 影響を受けるコンポーネント（`src/handlers/`、`src/endpoints/rpc.ts`、`src/lib/dal/`、`miniapp/`、`scripts/`、ビルドツールなど）。
   - 最小限の再現手順または Proof-of-Concept（PoC）。
   - 悪用された場合に想定される影響。

### 対応タイムライン

- **一次受付通知**：48 時間以内。
- **トリアージと評価**：5 営業日以内。
- **修正と公開**：修正パッチを非公開で作成し `main` へリリースします（匿名希望でない限り報告者をクレジット表記します）。

---

## セキュリティアーキテクチャの概要

- **保存時の BYOK 暗号化（`src/lib/crypto.ts`）**：ユーザーが登録する Gemini API キーは、Pure-TypeScript の RFC 8439 ChaCha20-Poly1305（96 ビット固有ナンス）と HMAC-SHA256 検証によって暗号化されます。
- **Mini App 認証（`src/endpoints/rpc.ts`、`src/lib/auth.ts`）**：本番 RPC リクエストでは Telegram WebApp の `initData` 署名（`HMAC-SHA256`）および `auth_date` の有効期限を検証します。
- **テナント分離（`src/lib/dal/`）**：DAL のすべての読み書きで `user_id` / `telegram_id` によるスコープ強制を行い、オープン登録またはフェイルクローズ型のホワイトリスト制御（`ADMIN_IDS`、`BETA_WHITELIST`）を選択できます。
- **3 層の情報漏洩防止**：プライベートな `overlay/`、シークレットファイル、`.forbidden-strings.local` は `.gitignore` で除外され、ローカルの `.githooks/pre-push`（`scripts/check-leaks.mjs` + `gitleaks`）および GitHub Actions CI で自動検査されます。
