[English](CONTRIBUTING.md) | [Русский](CONTRIBUTING.ru.md) | [Srpski](CONTRIBUTING.sr.md) | **日本語**

# Tokio へのコントリビュートガイド

**Tokio** へのご関心とご協力ありがとうございます！Pull Request を作成する前に、[`AGENTS.md`](AGENTS.md) と本ガイドをご確認ください。

---

## 1. Core と Overlay の境界ルール

Tokio は再利用可能なオープンソースのコアと、非公開の宣言的オーバーレイで構成されています：

- **Core（`src/`、`miniapp/src/`、`locales/`、`tests/`）に含めるもの**：中立的な仕組み — エージェントツール、インターフェース、SQLite スキーマ・DAL、バグ修正、テスト、拡張ポイント、宣言的機能フラグ。
- **Overlay（`overlay/` または `OVERLAY_DIR`）に置くもの**：インスタンス固有の好み — ブランド名、個人用プロンプト、話し方のトーン、コーチング方針、銀行口座名、個人情報。
- **判断が分かれる挙動**：`manifest.features` 内のフラグとして切り替え可能にします（[`docs/system/OVERLAY-SPEC.md`](docs/system/OVERLAY-SPEC.md)）。

個人用プロンプト、実際の Telegram ユーザー ID、個人のメールアドレス、自身のデプロイ URL、個人口座名などを PR に含めないでください。

---

## 2. ローカル開発環境のセットアップ

**Node.js 22+** と `npm` が必要です：

```bash
git clone https://github.com/ValDagon/tokio.git
cd tokio
npm install
(cd miniapp && npm install)
```

- `npm install` により `git config core.hooksPath .githooks` が設定され、`.githooks/pre-push` が自動で有効になります。
- 任意：ローカルで push 前にシークレットをスキャンするには `gitleaks`（`brew install gitleaks`）をインストールしてください。

---

## 3. PR 前の必須検証ゲート

すべての変更はローカルで全チェックが `exit code 0` で通過する必要があります：

```bash
# 1. 情報漏洩・衛生チェック
npm run check:leaks

# 2. バックエンド / V8 アイソレート
npm run typecheck
npm test
npm run build        # モジュール数 <= 100 およびバンドルグラフの整合性を検証

# 3. Mini App
cd miniapp
npm run lint
npm test
npm run build
```

---

## 4. 多言語対応ポリシー（4 言語）

Tokio は **4 言語** に対応しています：`en`（英語）、`ru`（ロシア語）、`sr`（セルビア語ラテン文字 `č, ć, đ, š, ž`）、`ja`（丁寧体の日本語 `です/ます`）。

- ユーザー向けの文言を追加・変更する場合は、`locales/{en,ru,sr,ja}.json` および／または `miniapp/src/i18n/locales/{en,ru,sr,ja}.json` の 4 ファイルすべてを同時に更新してください。
- ロケール網羅性テストにより、4 言語間でのキー一致が検証されます。

---

## 5. Pull Request のガイドライン

- コミットメッセージは [Conventional Commits](https://www.conventionalcommits.org/)（`feat:`、`fix:`、`refactor:`、`docs:`、`test:`、`chore:`）に従ってください。
- PR の変更範囲を明確にし、新機能やバグ修正には必ずテストを追加してください。
- [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) のチェックリストに沿って確認し、CI（`backend`、`miniapp`、`security-leaks`）が成功することを確かめてください。
- コントリビューションの提出をもって、該当コードが [Apache License, Version 2.0](LICENSE) のもとで提供されることに同意したものとみなされます（[`NOTICE`](NOTICE) および [`CONTRIBUTORS.md`](CONTRIBUTORS.md) もご参照ください）。
