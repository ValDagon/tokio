# Tokio サンプルオーバーレイとデモデータ

このディレクトリには、Tokio の標準 **フォールバック用オーバーレイ**（`example/overlay/`）と **多言語デモデータ**（`example/seed/demo.json`）が含まれています。

## 自動フォールバックの仕組み

`<repo>/overlay/manifest.json` が存在しない場合、`scripts/compile-runtime-assets.mjs` は自動的に `example/overlay/` を `src/lib/overlay.generated.ts` にコンパイルします。リポジトリをクローンした直後から、追加設定なしで型チェック・テスト・ビルドを実行できます。

## カスタムオーバーレイの作成方法

1. サンプルを `.gitignore` 対象の `overlay/` ディレクトリにコピーします：

   ```bash
   cp -R example/overlay overlay
   ```

   あるいは、リポジトリ外にオーバーレイを配置し、環境変数 `OVERLAY_DIR` で指定することもできます：

   ```bash
   OVERLAY_DIR=/path/to/my-overlay npm run build
   ```

2. `overlay/manifest.json` を編集します：
   - `brand`：`assistantName`、`localizedNames`、`backupPrefix`、`supportContact`、`miniAppUrl`、`accessDeniedMessage` を設定します。
   - `defaults`：`timezone`、`baseCurrency`、`summaryTime`、`supportedCurrencies`、`inboxCurrencies` を設定します。
   - `features`：機能フラグ（`spendLimitEnabled`、`spendLimitUsd`、`onboardingWizard`、`byokCommand`、`feedbackEnabled`、`overloadShield`、`microFocusTriage`、`calmModeUi`）を切り替えます。
   - `finance`：`accountAliases`、`defaultAccountByCurrency`、`genericCardAccountByCurrency`、`reserveAmount` を定義します。
   - `miniapp`：`tabs` と `accountThemes` を調整します。
   - `prompts.personaStyles`：会話スタイル（`mentor`、`strategist`、`calm_partner`、`concise`）を編集します。

3. 必要に応じて `overlay/prompts/{ru,en,sr,ja}/{identity,mission,principles,classifier}.md` の Markdown プロンプトを編集します：
   - アシスタント名には `{{assistantName}}` を使用します。
   - `classifier.md` の JSON スキーマと `{{currencies}}` プレースホルダーは維持してください。

## デモデータ（`example/seed/demo.json`）

`example/seed/demo.json` には、`ru`・`en`・`sr`・`ja` 各言語のスターターデータ（口座3件、毎月の固定費1件、タスク3件、検索可能なメモ3件）が含まれています。ビルド時にオーバーレイへ組み込まれ、オンボーディングやデモ用に `getDemoSeed(locale)` から参照されます。

## ローカル検証とデプロイ

ローカルで型チェック・テスト・ビルドを実行します：

```bash
npm run typecheck && npm test && npm run build
```

Telegram Serverless（`tgcloud.ai`）へデプロイします：

```bash
npx tgcloud push && npx tgcloud migrate --yes
```

詳しい仕様は [docs/system/OVERLAY-SPEC.md](../docs/system/OVERLAY-SPEC.md) をご覧ください。
