# off-r39x DESIGN.md

off-r39x（おふりみっくす）ホームページ全ページ共通のフロントエンドデザイン指針。
実装エージェントはページを作る前に必ずこのファイルを通読し、ここに書かれた値・ルールをそのまま使うこと。

- **MUST** … 必ず守る。例外を作らない
- **SHOULD** … 原則守る。守れない場合は理由をコードコメントに残す
- **MAY** … 使ってよい演出。使うかどうかは判断に任せる

このファイルにない色・フォント・角丸・影・イージング・装飾を新しく足さない（MUST）。足りないときは、トークンの追加を提案する。

### このファイルの文章をページに載せない（MUST）

このファイルに書かれている文章は、すべて実装者への指示であり、サイトに載せる文言ではない。

- 見出し・本文・ボタン・リンク・ステッカーの中の語・流れる帯・`alt`・`aria-label`・`<title>`・meta description のどこにも、このファイルの言葉を流用しない。コンセプト名、原則の見出し、部品の名前、説明文、コード例の中の文字列もすべて含む
- ページに載せる文言は、ページごとに別途渡されるコンテンツだけを使う
- 渡されていない文言は `[見出し]` `[本文 2〜3行]` のように角括弧のプレースホルダーにする。それらしい文章を自分で作らない
- 唯一の例外は、ロゴに書かれている語（off-r39x、おふりみっくす、in 大阪らへん、2027）。流れる帯、フッターのワードマーク、ヒーローの大きな年号（2027）、ロゴ画像の `alt`（ロゴに書かれている語をそのまま並べる）に使ってよい
- UI の読み上げ用の文言（`aria-label`、スキップリンクなど）も、渡されていなければ `[メニューを開く]` のように角括弧のプレースホルダーにする

---

## 1. コンセプト：ステッカー・リミックス

ロゴに入っている部品を**サンプリングして、ページごとにリミックスする**。サイトの装飾は、すべてロゴから取り出したもので作る。

**ロゴから取り出す部品**
- **キャンディ文字**：レモン → ミント → ティールのグラデーションと、1文字ずつ右上に入る白い三角のツヤ
- **太い黒フチと白い型抜きフチ**：ダイカットステッカーの仕上がり
- **コーラルのずらし**：文字の左下に覗く、コーラル色のもう一枚
- **ダイヤ枠**：黒とグレーの二重線で描かれた菱形。ところどころ途切れていて、文字が枠からはみ出している
- **星とキラ**：黒い五芒星と、四方に尖ったキラ
- **音符**：コーラルの八分音符
- **スピード線**：先細りの平行線の束

ロゴ自体が「ステッカーを貼り重ね、枠からはみ出す」作りになっている。サイトはこれをページ全体に広げたものにする。

装飾は、ステッカーの貼り重ねと枠からのはみ出しで増やす。文字を読みにくくして増やすことはしない。角度も形もばらばらな要素は、黒フチの太さを揃えることで一つの紙面にまとめる。

### 部品と見た目の役割

| 見た目の役割 | 使う部品 |
|---|---|
| 暖色と寒色の対比 | コーラル（暖色）とミント〜ティール（寒色）。白面と黒面の切り替え |
| 不規則さ | 角度ばらばらに貼られたステッカー、セクションの境界を跨ぐ要素、途切れるダイヤ枠 |
| 装飾の密度 | 星・キラ・音符・スピード線。各ページで最低量を決める（§7） |
| 種類の多さ | 形も色も違うステッカー群、1文字ずつ幅が違う伸縮タイポ |
| 操作したときの手応え | 押すとずれが戻る「ずらし戻し」、マウスを乗せると揺れるステッカー |
| 動きのリズム | 画面に入ると貼られるステッカー、同じ拍で瞬くキラと揺れる音符（§9） |
| スケールの大きさ | 画面端で断ち切られる巨大なダイヤ枠とキャンディ文字 |
| 枠の外へ広がる構図 | ダイヤ枠からのはみ出し。ロゴやステッカーが枠の外へ出る |

---

## 2. デザイン原則

1. **ロゴが辞書**
   色・形・装飾は、ロゴにあるものだけで作る。迷ったら「これはロゴのどの部品か？」と問う。答えられない装飾は入れない。
2. **黒フチが秩序**
   ポップな要素はすべて太い黒フチで包む。フチの太さはトークンで統一する。どれだけ散らかっても、フチの太さが揃っていれば一つの紙面に見える。
3. **ずらしは左下へ、一定量**
   コーラルのずらしは、必ず左下方向に同じ量だけ出す。ランダムな方向・量にしない。
4. **はみ出しは外向き**
   ダイヤ枠・ステッカー・巨大な文字は、コンテナや画面の外へはみ出してよい。ただし本文・ボタン・入力欄の上には重ねない。
5. **大胆さはヒーローに集中**
   一番派手な演出はページ冒頭に置く。その下は骨格を見せて落ち着かせ、要所にステッカーを散らす。
6. **読ませる部分は直立させ、白か黒の上に置く**
   本文や情報は回転させず、グラデーションの上にも置かない。
7. **動くのは装飾だけ。動きは拍で揃える**
   ステッカーやダイヤ枠はよく動かしてよい。本文やボタンは動かさない。常時動くものは、すべて同じ拍（120BPM）で刻む。

---

## 3. カラー

### 3.1 パレット（ロゴから実測）

| トークン | HEX | 名前 | 役割 |
|---|---|---|---|
| `--ink` | `#000000` | 墨 | フチ、本文の文字、黒面の背景、星・キラ |
| `--paper` | `#FFFFFF` | 白 | 白面の背景、型抜きフチ、黒面の文字 |
| `--stripe` | `#494949` | ダイヤ灰 | ダイヤ枠の二本目の線、黒面の上の装飾線。文字には使わない |
| `--coral` | `#FF7856` | コーラル | ずらし、音符、主役級のアクセント。暖色側 |
| `--lemon` | `#F4FF70` | レモン | キャンディの上端、ステッカー |
| `--mint` | `#62FE9D` | ミント | キャンディの中間、黒面のアクセント文字、ハイライト |
| `--teal` | `#2FE5BB` | ティール | キャンディの下端。寒色側 |

**キャンディ・グラデーション**（使ってよい唯一のグラデーション）：

```css
--grad-candy: linear-gradient(180deg, #F4FF70 0%, #D0FF7B 25%, #9EFF8A 50%, #62FE9D 75%, #2FE5BB 100%);
```

キャンディ文字のツヤ（1文字ずつ右上に入る白い三角）は、グラデーションではなく塗り分けで作る。大きさは `--gloss`（初期値 `46%`）で決め、§5.1 で使う。

- 透明度違いは `color-mix()` で作る。新しい HEX を足さない（MUST）
- `#111` のような「ほぼ黒」にしない。黒はロゴと同じ `#000`（MUST）
- キャンディ以外のグラデーション、ネオンの発光（`text-shadow` のぼかし）、すりガラスは使わない（MUST）

### 3.2 面（サーフェス）の種類

| 面 | 背景 | 本文の文字 | 使ってよいアクセント | 使いどころ |
|---|---|---|---|---|
| **白面** | `--paper` | `--ink` | すべて（図形として） | 標準。ページの大半 |
| **黒面** | `--ink` | `--paper` | ミント・ティール・レモン・コーラル（文字にも使える）、ダイヤ灰の線 | 暗い面。リズムを変えたいセクション |
| **キャンディ面** | `--grad-candy` | `--ink` | コーラル・白・黒 | ページの締め。1ページに最大1つ |

- コーラルは面にしない。帯（流れる帯）とステッカー、ずらしだけに使う
- ダークモードは作らない（MUST）。暗い面が必要なときは黒面を使う

### 3.3 コントラスト表（WCAG 2.x、計算済み）

| 文字 / 背景 | 比率 | 判定 | 使ってよい用途 |
|---|---|---|---|
| 墨 / 白 | 21.0 | AAA | すべての文字 |
| 墨 / レモン・ミント・ティール | 13.1〜19.4 | AAA | キャンディ面・ボタンの文字 |
| 墨 / コーラル | 8.07 | AAA | 流れる帯、コーラルのステッカーの文字 |
| 白 / 墨 | 21.0 | AAA | 黒面のすべての文字 |
| ミント / 墨 | 16.18 | AAA | 黒面の強調・小見出し・リンク |
| ティール / 墨 | 13.05 | AAA | 黒面の強調 |
| コーラル / 墨 | 8.07 | AAA | 黒面の強調 |
| 白 / ダイヤ灰 | 8.86 | AAA | ほぼ使わない（灰は線専用） |
| コーラル / 白 | 2.60 | 不可 | **白面で文字に使わない** |
| ミント / 白 | 1.30 | 不可 | **白面で文字に使わない** |
| ティール / 白 | 1.61 | 不可 | **白面で文字に使わない** |

例外：**キャンディ文字**（§5.1）は、黒フチが背景と中身の両方に対して十分なコントラストを持つので、白面に置いてよい。

---

## 4. タイポグラフィ

### 4.1 書体

ロゴの、丸くて太くて弾む文字に合わせる。

| 役割 | 書体 | 備考 |
|---|---|---|
| ディスプレイ（欧文・数字） | **Fredoka**（可変：幅 75–125 / 太さ 300–700） | 丸い極太。幅を伸縮させて、文字ごとに表情を変える |
| ディスプレイ（和文） | **Mochiy Pop One** | 丸みのある極太ポップ体。Fredoka のフォールバックとして同じスタックに入れる |
| 本文・UI | **Zen Maru Gothic**（400 / 500 / 700 / 900） | 丸ゴシック。本文、ナビ、ボタン、フォーム |

```css
--font-display: "Fredoka Variable", "Mochiy Pop One", sans-serif;
--font-body: "Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif;
```

欧文と和文が混ざった見出しは `--font-display` 1本で書けば、欧文は Fredoka、和文は Mochiy Pop One に自動で振り分けられる。
Fontsource のパッケージ（`@fontsource-variable/fredoka`、`@fontsource/mochiy-pop-one`、`@fontsource/zen-maru-gothic`）で同じオリジンから自前配信し、`font-display: swap` で読み込む。Google Fonts など外部オリジンからは読み込まない（MUST。SPEC-050 §24.3、SPEC-140 SEC-WEB-004）。Fredoka は幅と太さの両軸を持つ可変版で、family 名は `Fredoka Variable`。等幅フォントは使わない（MUST）。

### 4.2 タイプスケール

古典的なスケール（12 / 14 / 16 / 18 / 21 / 24 / 36 / 48 / 72）を基準に、ディスプレイだけ上に拡張する。

| トークン | サイズ | 書体・太さ | 行間 | 字間 | 用途 |
|---|---|---|---|---|---|
| `--fs-hero` | `clamp(64px, 14vw, 192px)` | display / 700 | 0.95 | 0 | 巨大な英数字（日付、フッターのワードマーク） |
| `--fs-h1` | `clamp(44px, 7.5vw, 104px)` | display / 700 | 1.05 | 0.01em | 下層ページのタイトル（キャンディ文字） |
| `--fs-h2` | `clamp(30px, 4.5vw, 48px)` | display（Mochiy） | 1.25 | 0.02em | セクション見出し |
| `--fs-h3` | `24px` | body / 900 | 1.5 | 0.03em | 小見出し |
| `--fs-lead` | `21px` | body / 700 | 1.75 | 0.04em | リード文 |
| `--fs-body` | `16px` | body / 500 | 1.9 | 0.05em | 本文 |
| `--fs-small` | `14px` | body / 500 | 1.75 | 0.05em | 補足 |
| `--fs-caption` | `12px` | body / 700 | 1.6 | 0.06em | キャプションのみ。乱用しない |

**数字（日付・時刻・番号）**は Fredoka 700、幅 110 で組む。日付は小さなラベルにせず、大きく組んでデザインの一部にする（SHOULD）。

### 4.3 和文組版ルール

- 本文の1行は **38字以内**：`max-inline-size: 38ic;`（MUST）
- 本文は左揃え。両端揃え・中央揃えにしない（MUST）
- 見出しには `font-feature-settings: "palt";` を指定して字詰めする。本文には指定しない
- 見出しの改行は `word-break: auto-phrase; text-wrap: balance;`。非対応ブラウザ向けに、意図した位置へ `<wbr>` を入れる
- 段落の間は `1em`。行頭の字下げはしない

### 4.4 伸縮タイポ（Fredoka 専用の演出）

大きな英数字（日付、フッターのワードマークなど）は、**1文字ずつ幅を変えて**組む。文字ごとに幅を変えて、紙面に変化をつける。

```css
.stretch > span { font-variation-settings: "wdth" var(--w, 100), "wght" 700; }
.stretch > span:nth-child(6n+1) { --w: 125; }
.stretch > span:nth-child(6n+2) { --w: 80; }
.stretch > span:nth-child(6n+3) { --w: 112; }
.stretch > span:nth-child(6n+4) { --w: 75; }
.stretch > span:nth-child(6n+5) { --w: 120; }
.stretch > span:nth-child(6n+6) { --w: 92; }
```

- 1文字ずつ `<span>` に分けたときは、親に `aria-label` で元の語を入れ、子には `aria-hidden="true"` を付ける（MUST）
- 和文には使わない。1ビューポートに1つまで

---

## 5. ロゴ由来の表現

サイトの装飾は、ほぼすべてここで定義する表現で作る。新しいエフェクトを足す前に、ここにあるもので表現できないか考える。

### 5.1 キャンディ文字（主役）

ロゴの文字の仕上げを、HTML のテキストで再現する。重なり順は下から「白い型抜きフチ → 黒フチ → コーラルのずらし → キャンディの面とツヤ」。
ロゴのツヤは**1文字ごとに右上へ入る白い三角**なので、表の面（`.candy__face`）だけは1文字ずつ `<span>` に分ける。

```html
<h1 class="candy">
  <span class="sr-only">見出しテキスト</span>
  <span class="candy__edge" aria-hidden="true">見出しテキスト</span>
  <span class="candy__line candy__line--off" aria-hidden="true">見出しテキスト</span>
  <span class="candy__line" aria-hidden="true">見出しテキスト</span>
  <span class="candy__off" aria-hidden="true">見出しテキスト</span>
  <span class="candy__face" aria-hidden="true"><span>見</span><span>出</span><span>し</span>…</span>
</h1>
```

```css
.candy {
  --line-w: 0.18em;  /* 黒フチ（外に見えるのは半分） */
  --edge-w: 0.38em;  /* 白い型抜きフチ */
  position: relative; isolation: isolate;
  font-family: var(--font-display); font-weight: 700;
}
.candy > [aria-hidden]:not(.candy__face) { position: absolute; inset: 0; z-index: -1; }
.candy__edge { color: var(--paper); -webkit-text-stroke: var(--edge-w) var(--paper); }
.candy__line { color: var(--ink); -webkit-text-stroke: var(--line-w) var(--ink); }
.candy__line--off, .candy__off { translate: var(--off-x) var(--off-y); }
.candy__off { color: var(--coral); }
.candy__face > span {
  background: linear-gradient(210deg, var(--paper) 0 var(--gloss), transparent calc(var(--gloss) + 0.5%)),
              var(--grad-candy);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.sr-only {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}
```

- ずらし量は `--off-x: -0.06em; --off-y: 0.04em;`（左下）で固定（MUST）
- ツヤの白い三角は、**文字の上から約1/3、右上の角**にかかるのが正解。Fredoka / Mochiy Pop One を読み込んだ状態で見て、ずれていれば `--gloss` の初期値 `46%` だけを 40〜52% の範囲で調整する。`--gloss` は登場の動き（§9.5）で一瞬大きくなる
- 読み上げられるのは `.sr-only` の1つだけ。それ以外の版はすべて `aria-hidden="true"`。疑似要素の `content: attr()` で作らない（MUST）
- 文字の分割はコンポーネント側で自動で行い、手書きしない（SHOULD）
- 使うのは **下層ページの h1 / 大きな日付 / 黒面の h2（1つまで）** だけ。本文・h3 以下・ボタンには使わない
- 黒面の h2 に使うときも、文字の大きさは `--fs-h1` にする（`--fs-h2` ではフチとツヤが細かくなりすぎる）
- 2行までの見出しに使う。3行以上になる文には使わない
- 1つのコンポーネントとして一度だけ実装し、全ページで使い回す（SHOULD）。Chrome・Safari・Firefox で表示を確認する（確認の方法と結果は §11.1）

### 5.2 コーラルのずらし（UI 版）

ボタン・リンクになっている札・写真に使う、キャンディ文字のずらしの UI 版。コーラルの影を、黒フチごと左下にずらす。

```css
--shadow-off: -5px 5px 0 var(--coral), -5px 5px 0 3px var(--ink);
```

ソフトなグレーの影（`rgba(0,0,0,.1)` など）は使わない（MUST）。影はこれだけ。

### 5.3 ダイヤ枠

ロゴの背景にある、黒とグレーの二重線の菱形。サイトでは、要素が枠の外へはみ出す構図の基準として使う。

```html
<svg class="diamond" viewBox="0 0 100 100" aria-hidden="true">
  <path class="diamond__back" d="M50 3 L97 50 L50 97 L3 50 Z" fill="none" stroke-width="5" transform="translate(3 -3)" />
  <path class="diamond__front" d="M50 3 L97 50 L50 97 L3 50 Z" pathLength="100" fill="none" stroke-width="5"
        stroke-dasharray="0 4 30 6 40 5 15" />
</svg>
```

```css
.diamond { overflow: visible; color: var(--ink); }
.diamond__front { stroke: currentColor; }
.diamond__back { stroke: var(--stripe); }
.surface-ink .diamond { color: var(--paper); }
```

線を描く登場の動き付きの完全な形は §9.5 にある。

- `overflow: visible` を必ず付ける（付けないと、右上にずらした灰色の線が切れる）
- 灰色の線は**右上**にずらす（ロゴと同じ）。コーラルのずらし（左下）とは逆向き
- 線を `stroke-dasharray` でところどころ途切れさせる（`pathLength="100"` を付け、合計 100 になる値にする）。途切れたところから中身がはみ出しているように配置する
- 巨大に使う（ビューポートの 80〜140%）。画面の端で断ち切ってよい
- 黒面では、黒の線を `--paper` に、灰の線を `--stripe` のまま使う
- 線の色は、SVG の属性に `var()` を書かず、クラスで指定する（属性の `var()` は効かないブラウザがある）。黒の線は `stroke: currentColor` にして、枠の `color` を白面では `--ink`、黒面では `--paper` にする
- 同じ枠を何度も使っても、`<symbol>` と `<use>` で使い回さず、その場に書く。`<use>` の中身には黒面の切り替えが効かず、描く動き（§9.5）のマスクの `id` もページ内で重複させられないため
- 小さなダイヤ（12〜20px、キャンディの塗り＋黒フチ）は、リストの行頭記号として使ってよい

### 5.4 星・キラ・音符

| 部品 | 形 | 色 | 使いどころ |
|---|---|---|---|
| 星 | 少し傾いた五芒星 | `--ink`、白フチ | ステッカー、見出しの脇 |
| キラ | 辺が内側に反った四方星 | `--ink`（黒面では `--paper`） | 空いた余白、ダイヤ枠の角 |
| 音符 | 八分音符 | `--coral`、黒フチ | 1ページに1〜2個。「みっくす」の印 |

- すべて SVG。白い型抜きフチは `stroke: var(--paper); stroke-width: 8; paint-order: stroke;`
- 傾きは `-15deg 〜 15deg`。同じ画面に同じ角度を2つ置かない

形は次のデータを使い回し、ページごとに描き直さない（MUST）。ページの先頭に見えない `<svg>` を1つ置いて `<symbol>` を定義し、`<svg><use href="#star"/></svg>` のように使う。黒面の切り替えが要らない部品なので、`<use>` で使い回してよい（ダイヤ枠は §5.3 のとおり、その場に書く）。

```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <!-- 音符の形。3つの部品を、白フチ → 黒フチ → コーラルの順に重ねて塗る -->
    <g id="note-shape">
      <ellipse cx="34" cy="76" rx="18" ry="13" transform="rotate(-22 34 76)"/>
      <path d="M44 12 h9 v62 h-9z"/>
      <path d="M44 8 h9 c2 14 24 16 28 36 c2 10 -2 20 -8 26 c2 -14 -6 -24 -20 -28z"/>
    </g>
  </defs>
  <!-- 星：墨の塗り＋白フチ -->
  <symbol id="star" viewBox="-6 -6 112 112">
    <path d="M50 4 L61.2 34.6 L93.7 35.8 L68.1 55.9 L77 87.2 L50 69 L23 87.2 L31.9 55.9 L6.3 35.8 L38.8 34.6Z"
          style="fill:var(--ink);stroke:var(--paper);stroke-width:8;stroke-linejoin:round;paint-order:stroke"/>
  </symbol>
  <!-- キラ：塗りは currentColor（白面は墨、黒面は白）＋白フチ -->
  <symbol id="kira" viewBox="-6 -6 112 112">
    <path d="M50 0 C54 36 64 46 100 50 C64 54 54 64 50 100 C46 64 36 54 0 50 C36 46 46 36 50 0Z"
          style="fill:currentColor;stroke:var(--paper);stroke-width:8;stroke-linejoin:round;paint-order:stroke"/>
  </symbol>
  <!-- 小さなダイヤ：塗りは currentColor（レモン・ミント・ティール・コーラル）＋墨のフチ -->
  <symbol id="chip" viewBox="-6 -6 112 112">
    <path d="M50 4 L96 50 L50 96 L4 50Z" style="fill:currentColor;stroke:var(--ink);stroke-width:10;stroke-linejoin:round"/>
  </symbol>
  <!-- 音符：白フチ 8 ＋ 黒フチ 4 ＋ コーラル -->
  <symbol id="note" viewBox="-14 -6 124 120">
    <use href="#note-shape" style="fill:var(--paper);stroke:var(--paper);stroke-width:24;stroke-linejoin:round"/>
    <use href="#note-shape" style="fill:var(--ink);stroke:var(--ink);stroke-width:8;stroke-linejoin:round"/>
    <use href="#note-shape" style="fill:var(--coral)"/>
  </symbol>
</svg>
```

- 色は SVG の属性ではなく `style` で `var()` を渡す（属性の `var()` は効かないブラウザがある）
- 部品が重なる形（音符など）は、`paint-order` では部品どうしの境目にフチが出る。白フチ → 黒フチ → 塗りの3層を、同じ形で重ねて塗る
- 中に語を入れるダイヤ札と吹き出しは、語がその場ごとに違うので `<symbol>` にせず、§8.6 の形をその場に書く

### 5.5 スピード線

ロゴの「in 大阪」と「2027」の下にある、先細りの平行線の束。動きの向きを示す装飾として使う。

- 3〜4本の線を束にし、上から下へ短くしていく。線の太さは同じ、先端は斜めに切る
- 色は `--ink`（黒面では `--paper`）、白い型抜きフチ付き
- 見出しの下、大きな日付の下、セクションの境界に使う。ゆるくカーブさせてよい

### 5.6 写真

- 角丸 `--r-card`、3px の黒フチ、`--shadow-off` を付けてステッカーとして貼る
- 目立たせたい1枚は、ダイヤ（菱形）に切り抜いてよい（`clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%)`）。`clip-path` を使うと枠線と影が消えるので、重ね順を次のようにする：①コーラルで塗った黒フチの菱形の SVG を左下へずらして置く → ②切り抜いた写真 → ③黒フチだけの菱形の SVG を写真の上に重ねる
- 写真の色は加工しない。写真の上に文字を重ねない

---

## 6. レイアウト

### 6.1 グリッドと余白

- 12カラム、最大コンテンツ幅 `1280px`
- ガター `24px`（768px 未満は `16px`）
- 外側マージン `clamp(16px, 5vw, 64px)`
- セクションの上下余白 `clamp(72px, 10vw, 160px)`
- 余白スケール（これ以外の値を使わない）：`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128 / 192` px
- 揃えは**すべて左揃え**。中央揃えは、キャンディ面の締めの CTA だけ許可する

### 6.2 フチと角丸

| トークン | 値 | 対象 |
|---|---|---|
| `--line-ui` | `3px` | ボタン・札・入力欄・写真の黒フチ |
| `--line-sticker` | `4px` | ステッカーの黒フチ |
| `--edge-sticker` | `8px` | ステッカーの白い型抜きフチ |
| `--r-card` | `14px` | 札・写真・ステッカー（四角いもの） |
| `--r-field` | `10px` | 入力欄・小さなタグ |
| `--r-pill` | `999px` | ボタン・チップ |
| `--r-none` | `0` | セクション、ダイヤ枠 |

### 6.3 トップページのヒーロー

サイトで一番派手な場所。主役は**ロゴそのもの**。巨大なダイヤ枠の中にロゴを置き、ロゴ・星・キラが枠の外へはみ出す。

```
デスクトップ（白面）
┌────────────────────────────────────────────────────────────┐
│                                ナビ  ナビ  ナビ   [副CTA]   │ ← ヒーローの間はヘッダーにロゴを出さない
│               ◇ 巨大なダイヤ枠（黒＋右上に灰。途切れあり）     │
│           ◇                        ◇           ✦          │
│       ◇     ┌───────────────────┐     ◇                    │
│     ◇       │                   │       ◇    ★            │
│       ◇     │    ロゴ（大）      │ ─ 枠の外へはみ出す ─       │
│           ◇ └───────────────────┘   ◇   [名札ステッカー]     │
│               ◇                   ◇     2027 ←伸縮タイポ   │
│                 ◇               ◇       日程・会場          │
│                   ◇           ◇         リード文            │
│                     ◇       ◇           [主CTA] [副CTA]    │
└────────────────────────────────────────────────────────────┘
  ══════ スピード線 ↑ ヒーローの下端から次のセクションに跨る

モバイル
┌──────────────────────┐
│               [≡]    │
│  ◇ ダイヤ（断ち切り）✦ │
│ ┌──────────────────┐ │
│ │  ロゴ（幅90%）     │ │
│ └──────────────────┘ │
│ ★                    │
│ 2027 ←伸縮タイポ       │
│ 日程・会場             │
│ リード文               │
│ [主CTA（全幅）]        │
│ [副CTA（全幅）]        │
└──────────────────────┘
  ══ スピード線 ↑ デスクトップと同じく、ヒーローの下端から次のセクションに跨る
```

- ロゴの幅：デスクトップは `clamp(280px, 44vw, 600px)`、モバイルは `90vw`。ロゴはほぼ正方形なので、これより大きくするとリード文と CTA が最初の画面に入らない
- デスクトップでは、リード文と CTA をロゴの右のカラムに置き、**最初の画面（高さ 900px）に主 CTA まで収める**（MUST）
- リード文と CTA の周りは「静域」（§7.3）。巨大なダイヤ枠の線が後ろを通るので、右のカラム（年号〜CTA）を白い地の静域でまとめる
- ヒーローを過ぎるまで、ヘッダーにロゴを出さない（SHOULD）。ロゴを同じ画面に2つ並べないため
- ヘッダーの CTA は副ボタンの見た目にする。ヒーローの主 CTA と同じ画面に入り、主ボタンが2つになるため（§8.1）
- 巨大なダイヤ枠はロゴの中心に重ね、幅はデスクトップ `110vw`、モバイル `140vw`。ヒーローの下端で断ち切る
- ステッカーは、キラ・星（ロゴの右側）、音符（ロゴの左上）、名札（右のカラムの年号の上）の4つ。モバイルではキラと星の2つだけにする（§7.2）

### 6.4 下層ページのヒーロー

トップより静かにする。ダイヤ枠を右上の角に半分だけ覗かせ、ページタイトルをキャンディ文字（`--fs-h1`）で組む。ステッカーは2つまで。

```
┌────────────────────────────────────────────╮
│ [ロゴ小]                  ナビ ナビ [CTA] ◇ │← ダイヤ枠の一部
│                                        ◇   │
│  ページタイトル（キャンディ文字・h1）      ◇  ✦ │
│  ════ スピード線                             │
│  短い説明文                    [ステッカー]   │
└────────────────────────────────────────────┘
```

### 6.5 セクションのリズム

1ページは「白面 → 黒面 → 白面 → キャンディ面 → フッター」の抑揚で組む。

```
[ヘッダー]
[ヒーロー ─ 白面 + ダイヤ枠 + ロゴ or キャンディ文字 + ステッカー]
[セクション ─ 白面]
 ～～～ 流れる帯（任意・境界を跨ぐ） ～～～
[セクション ─ 黒面（下端をダイヤの角で切ってよい）]
[セクション ─ 白面]
[締め ─ キャンディ面：CTA 1つ、中央揃え可]
[フッター ─ 黒面 + 下端で断ち切られる伸縮タイポの「off-r39x」]
```

- 黒面を2つ連続させない（MUST）
- キャンディ面は1ページに最大1つ（MUST）
- セクションの境界は次のどれか：スピード線、ステッカーの跨ぎ、流れる帯、ダイヤの角。境界ごとに同じものを繰り返さない

トップページの境界は、上から「スピード線（ヒーロー → 白面）→ 流れる帯（白面 → 黒面）→ ダイヤの角（黒面 → 白面）→ 星のステッカー（白面 → キャンディ面）」の順にしている。

ダイヤの角で切る境界：

```css
.cut-diamond { clip-path: polygon(0 0, 100% 0, 100% calc(100% - 56px), 50% 100%, 0 calc(100% - 56px)); }
```

### 6.6 繰り返し要素の並べ方

同じ種類の情報が並ぶとき（ゲスト一覧、企画一覧など）は、**同じ形の札を揃えて並べる**。読み比べやすさを優先し、変化はステッカーとわずかな傾きで足す。

- デスクトップでは札に `nth-child` で傾きを付ける：`-1.2deg / 0.6deg / -0.4deg / 1deg / -0.8deg` の順に繰り返す
- 768px 未満では傾けない
- 全部同じ角丸カードを並べ、同じ影を付けて済ませない。札には黒フチを付け、ずらしは「押せる札」だけに付ける

---

## 7. 装飾の量

実装者が迷わず、装飾の量を揃えるためのルール。**最低量**を下回ると地味になり、**上限**を超えると読めなくなる。

### 7.1 1ページあたりの最低量（MUST）

- [ ] ヒーローにロゴ（トップ）かキャンディ文字の h1（下層）が1つ
- [ ] ダイヤ枠が1つ以上
- [ ] ステッカー（星・キラ・音符・名札など）が3つ以上、2種類以上
- [ ] スピード線が1箇所以上
- [ ] 黒面が1つ以上
- [ ] 境界を跨ぐ要素が1つ以上

### 7.2 1ビューポートあたりの上限（MUST）

| 要素 | デスクトップ | モバイル |
|---|---|---|
| ロゴ＋キャンディ文字（合計） | 1 | 1 |
| ステッカー | 5 | 2 |
| 伸縮タイポ | 1 | 1 |
| 音符 | 1 | 1 |
| 流れる帯 | 1（ページ全体でも1） | 1 |
| 回転している要素 | 5 | 2 |
| 常時ループする要素（キラの瞬き・音符・流れる帯） | 3 | 2 |
| 同時に登場の動きを始める要素 | 6 | 4 |

### 7.3 静域（Quiet Zone）

本文、リード文、ボタン、リンク、フォーム、日時や料金などの情報の周囲 `24px` は**静域**。

- 静域にはステッカー・ダイヤ枠・スピード線を重ねない（MUST）
- 静域の文字は回転させない（MUST）
- 装飾が重なってよいのは：写真のフチ、見出しの端、セクションの境界、画面の端
- 巨大なダイヤ枠のように、どう配置しても静域の後ろを通ってしまう装飾は、静域の側に白い地を敷いて線を隠す。地は `--paper`、内側に `--quiet-zone` の余白を取り、同じ量の負のマージンで元の位置に戻す（線は静域の手前で途切れて見える）
- 黒面のダイヤ枠の白い線が、黒面の白い文字（モバイルメニューのリンクなど）と重ならないようにする。重なる場合は枠の位置を動かして、文字のない側で断ち切る

---

## 8. コンポーネント

### 8.1 ボタン

| 種類 | 地 | 文字 | フチ・影 | 使いどころ |
|---|---|---|---|---|
| 主ボタン | `--grad-candy` | `--ink` 900 | 3px 墨 ＋ `--shadow-off` | 1画面に1つ |
| 副ボタン | `--paper` | `--ink` 900 | 3px 墨、影なし | 主ボタンの隣 |
| 黒面の主ボタン | `--grad-candy` | `--ink` 900 | 3px 白 ＋ `-5px 5px 0 var(--coral)` | 黒面の上 |
| 黒面の副ボタン | 透明 | `--paper` 900 | 3px 白 | 黒面の上 |
| キャンディ面の主ボタン | `--paper` | `--ink` 900 | 3px 墨 ＋ `--shadow-off` | キャンディ面の上（キャンディ地のボタンは面に溶けるため使わない） |

- 形は `--r-pill`、高さは最低 `52px`、左右パディング `28px`、文字は Zen Maru Gothic 900 の `18px`
- **ずらし戻し**：ホバーでずらしが `5px → 7px` に広がり、押すとずらしが `0` になって、ボタンがずらしの位置へ沈む
- 文字の後ろに「→」を付けない。アイコンを付けるなら左に置き、意味のあるものだけにする

```css
.btn-primary {
  background: var(--grad-candy); color: var(--ink);
  border: var(--line-ui) solid var(--ink); border-radius: var(--r-pill);
  box-shadow: var(--shadow-off);
  transition: box-shadow var(--dur-fast) var(--ease-snap), translate var(--dur-fast) var(--ease-snap);
}
.btn-primary:hover { box-shadow: -7px 7px 0 var(--coral), -7px 7px 0 3px var(--ink); }
.btn-primary:active { box-shadow: 0 0 0 var(--coral), 0 0 0 0 var(--ink); translate: -5px 5px; }
```

### 8.2 テキストリンク

- 白面：文字 `--ink`、下線は `3px` の `--coral`、`text-underline-offset: 0.25em`
- ホバー：文字の背後に、下から 45% の高さのミントの帯が伸びる（墨 / ミント = 16.18）
- 黒面：文字 `--paper`、下線 `--mint`、ホバーで文字が `--mint` になる

### 8.3 ヘッダー

- 高さ `72px`（モバイル `60px`）、地 `--paper`。ナビは右（Zen Maru Gothic 700 / 16px）
- ロゴは左。ロゴ画像はほぼ正方形なので、最小幅 `120px`（§10）を守るとヘッダーの高さに収まらない。幅・高さ `120px` で上端から `4px` に置き、ヘッダーの下へはみ出して貼られたステッカーとして見せる（モバイルも同じ）
- はみ出した部分（デスクトップ約 `52px`、モバイル約 `64px`）は、スクロール中に本文の左上へ重なる。ロゴをステッカーとして貼る見せ方の一部として許容する（§7.3 の静域の例外）。ロゴを小さくしたり、本文側に余白を足したりして避けない
- ヒーロー表示中のロゴは `visibility: hidden` にして、見えないロゴにフォーカスが止まらないようにする
- ヘッダーの CTA は副ボタン（§6.3）。モバイルではナビと CTA を隠し、メニューボタン（`48px` の丸、3px の墨のフチ）だけを置く。CTA はモバイルメニューの最後に入れる
- トップページのヒーロー表示中は、ヘッダーの左のロゴ位置を空けたままにする。ナビと CTA の位置は動かさない。ヒーローを過ぎたらロゴを出す。出し入れは不透明度だけで行い、ロゴ自体は動かさない（§9.4）
- 現在のページは、ナビ項目の下に `6px` のミントの帯 ＋ 3px の墨の線
- ナビ項目にホバーすると、同じ帯が左から伸びる（`scale 0 → 1`、`transform-origin: left`、`--dur-fast` / `--ease-snap`）。帯はリンクの下端から `4px` 上に置く。ナビ項目のタップ領域の高さは `44px`
- スクロールしたら下端に `3px` の墨の線を出す。すりガラスは使わない。「スクロールしたか」と「ヒーローを過ぎたか」は、`scroll` イベントではなく IntersectionObserver で判定する（§9.3）
- モバイルメニュー：全画面の黒面。リンクは Mochiy Pop One の `36px`、左揃えで縦に並べる。背景に巨大なダイヤ枠（白と灰の線）。開くとき、黒い面がメニューボタンの位置からダイヤ形に広がり（`clip-path`、`--dur-base` / `--ease-snap`）、リンクが下から `16px` 浮き上がりながら、80ms 待ってから 40ms ずつ遅れて現れる。Esc で閉じ、開いている間はフォーカスをメニューの中に閉じ込める

### 8.4 フッター

- 黒面。下端に `off-r39x` を `--fs-hero` の伸縮タイポ（ミント）で置き、下半分を画面外で断ち切る
- リンクは2〜3列、白い文字。ロゴは置かない（ワードマークと重複するため）。デスクトップは3列、768px 未満は2列
- 列の見出しは `--mint` の `--fs-small` / 700。リンクは黒面のテキストリンク（§8.2）で、タップ領域の高さ `44px` を取る
- ワードマークの下半分を断ち切るため、フッターに `overflow: clip` と `display: flow-root` を付ける（`flow-root` がないと、負のマージンがフッターの外へ抜けて断ち切られない）

### 8.5 札（情報ブロック）

カードの代わり。ステッカーのように貼られた札。

- 地 `--paper`、`--line-ui` の墨のフチ、`--r-card`
- 黒面の上では、地 `--ink`、白のフチ
- リンクになっている札だけ、ホバーで `--shadow-off` が現れる。リンクでない札にホバー演出を付けない
- 札の角に星やキラを1つ貼ってよい（札の外へはみ出させる）
- 中のテキストが4行を超える札は回転させない
- 内側の余白は `--quiet-zone`（`24px`）。中身は上から「ラベル → 値 → 補足」を `8px` 間隔で積む
  - ラベル：`--fs-small` / 700。黒面では `--mint`、白面では `--ink`
  - 値：`--font-display` / 700、`--fs-h3`、行間 1.4、`palt`。日付などの数字は §4.2 の数字の組み方にする
  - 補足：`--fs-small`、行間 1.75
- 日時・場所・料金など、情報を載せる札は静域（§7.3）なので、§6.6 の傾きを付けない

### 8.6 ステッカー

紙面に変化をつける装飾。形はすべて自作する。基本は SVG で描き、中に語を組む名札と丸シールだけは HTML ＋ CSS で作る（語の長さに合わせて大きさが変わり、書体の指定もしやすいため）。

| 種類 | 形 | 色 | 中身 |
|---|---|---|---|
| **星・キラ・音符** | §5.4 | §5.4 | 文字なし |
| **名札** | 角丸の長方形、上に色帯 | 地は白、帯はキャンディ | 帯に短い見出し、下の欄に Mochiy Pop One の短い語 |
| **ダイヤ札** | 菱形 | キャンディ or コーラル | 墨の短い語や数字 |
| **吹き出し** | 角のある吹き出し | 白 | 墨の一言 |
| **丸シール** | 正円 | レモン / ミント / コーラル | 数字や記号1つ |

共通ルール：
- 黒フチ `--line-sticker` ＋ 白い型抜きフチ `--edge-sticker`。SVG では `paint-order: stroke` で描く。HTML で作るものは、黒フチを `border`、白い型抜きフチを `outline`（`outline-offset: 0`）で描き、角丸は `border-radius` に合わせる（`outline` は角丸に沿う）。`box-shadow` でフチを作らない（§5.2 の影と混ざるため）
- ステッカーに影は付けない。ロゴと同じくフラットにする
- 傾きは `-15deg 〜 15deg`。同じ画面に同じ角度を2つ置かない。傾きは `rotate` に直接書かず、`--tilt` で渡す（登場と揺れの動きが、この値を基準にするため）
- 外側と内側の2層で組む（§9.3）
- 装飾のステッカーには `aria-hidden="true"`。意味を持たせる場合は、同じ内容を本文側にも書く
- 既存のキャラクター・作品・企業ロゴを思わせる絵や持ち物にしない（MUST）

形と組み方：

```html
<!-- 名札（HTML）：幅 240px。帯はキャンディ、下の欄は Mochiy Pop One 36px -->
<span class="nametag">
  <span class="nametag__band">[見出し]</span>
  <span class="nametag__field">[短い語]</span>
</span>

<!-- 丸シール（HTML）：直径 112px、地はレモン / ミント / コーラル -->
<span class="roundseal">[数字]</span>

<!-- ダイヤ札（SVG）：白フチ → 塗り＋黒フチの2層。語は Fredoka 700 -->
<svg viewBox="-14 -14 148 148">
  <path d="M60 4 L116 60 L60 116 L4 60Z" style="fill:var(--paper);stroke:var(--paper);stroke-width:24;stroke-linejoin:round"/>
  <path d="M60 4 L116 60 L60 116 L4 60Z" style="fill:var(--coral);stroke:var(--ink);stroke-width:8;stroke-linejoin:round;paint-order:stroke"/>
  <text x="60" y="68" text-anchor="middle">[数字]</text>
</svg>

<!-- 吹き出し（SVG）：左下に角。語は Mochiy Pop One 24px -->
<svg viewBox="-12 -12 224 142">
  <path d="M20 4 H180 Q196 4 196 20 V70 Q196 86 180 86 H76 L44 112 L52 86 H20 Q4 86 4 70 V20 Q4 4 20 4Z"
        style="fill:var(--paper);stroke:var(--paper);stroke-width:24;stroke-linejoin:round"/>
  <path d="M20 4 H180 Q196 4 196 20 V70 Q196 86 180 86 H76 L44 112 L52 86 H20 Q4 86 4 70 V20 Q4 4 20 4Z"
        style="fill:var(--paper);stroke:var(--ink);stroke-width:8;stroke-linejoin:round;paint-order:stroke"/>
  <text x="100" y="56" text-anchor="middle">[一言]</text>
</svg>
```

```css
.nametag {
  display: grid; width: 240px; overflow: hidden;
  background: var(--paper);
  border: var(--line-sticker) solid var(--ink); border-radius: var(--r-card);
  outline: var(--edge-sticker) solid var(--paper);
}
.nametag__band {
  padding: var(--sp-2) var(--sp-4); background: var(--grad-candy);
  border-bottom: var(--line-sticker) solid var(--ink);
  font-family: var(--font-display); font-size: var(--fs-small); font-weight: 700; letter-spacing: 0.06em;
}
.nametag__field { padding: var(--sp-5) var(--sp-4); font-family: "Mochiy Pop One", sans-serif; font-size: 36px; line-height: 1.2; }
.roundseal {
  display: grid; place-items: center; width: 112px; aspect-ratio: 1;
  background: var(--lemon);
  border: var(--line-sticker) solid var(--ink); border-radius: 50%;
  outline: var(--edge-sticker) solid var(--paper);
  font-family: var(--font-display); font-weight: 700;
}
```

- 名札・丸シールも、外側の `.sticker`（傾き・登場・揺れ）で包む（§9.3）。HTML のステッカーそのものに `rotate` を書かない

### 8.7 流れる帯（ティッカー）（MAY）

- 1ページに1つまで。コーラルの帯に、墨の Mochiy Pop One `28〜36px`。帯の上下に `3px` の墨の線
- 語と語の区切りは**星**（★）。中黒（・）や縦線にしない
- `-2deg` 傾けて、セクションの境界を跨がせる
- 1周 80拍（40秒）。拍に合わせるため、長さを変えるときも拍の整数倍にする。ホバー・フォーカスで止まる。`prefers-reduced-motion` では止めて静的に表示する

### 8.8 チップ・タグ

- `--r-pill`、`2px` の墨のフチ、Zen Maru Gothic 700 / 14px
- 選択中：地 `--mint`、墨の文字。選択中の印として、左に小さなダイヤを付ける

### 8.9 フォーム

- 入力欄：地 `--paper`、`--line-ui` の墨のフチ、`--r-field`、高さ `52px`、文字 16px
- ラベルは入力欄の上に 14px / 700 で置く。プレースホルダーをラベルの代わりにしない
- エラー：フチを `--coral` に変えず墨のまま、入力欄の左下にコーラルの `--shadow-off` を出す。エラー文は墨の文字＋コーラルの丸アイコン

### 8.10 フォーカスリング（全要素共通）

```css
:focus-visible {
  outline: 3px solid var(--ink);
  outline-offset: 3px;
  box-shadow: 0 0 0 7px var(--mint);
}
.surface-ink :focus-visible { outline-color: var(--paper); box-shadow: 0 0 0 7px var(--coral); }
```

`outline: none` だけで消さない（MUST）。

### 8.11 スキップリンク

- 全ページの `<body>` の先頭に「本文へ移動する」リンクを置き、`<main>` に飛ばす。文言は渡されていなければプレースホルダー（`[本文へスキップ]`）
- ふだんは画面の上の外に隠し、フォーカスしたときだけ左上に出す。地 `--paper`、`--line-ui` の墨のフチ、`--r-field`、文字 700、`z-index: var(--z-overlay)`

```css
.skip-link {
  position: absolute; left: var(--sp-4); top: var(--sp-4); z-index: var(--z-overlay);
  padding: var(--sp-2) var(--sp-4); background: var(--paper);
  border: var(--line-ui) solid var(--ink); border-radius: var(--r-field);
  font-weight: 700; translate: 0 -200%;
}
.skip-link:focus { translate: 0 0; }
```

---

## 9. モーション

### 9.1 方針

動きは3種類に分ける。**登場**（画面に入ったとき1回）、**常時**（拍に合わせてループ、またはスクロールに連動）、**応答**（操作したとき）。

- **動くのはロゴ由来の装飾だけ**：ステッカー、キャンディ見出しの重ねた版とツヤ、ダイヤ枠、スピード線、キラ、音符。本文・リード文・ボタン・リンク・フォーム・札の中身は、画面に入っても動かさない（MUST）
- **常時の動きは、すべて同じ拍で刻む**：拍は `--beat: 500ms`（120BPM）。ループの長さも開始の遅れも、拍の整数倍にする（MUST）。数が増えても、同じリズムに乗っていれば散らかって見えない
- **JavaScript が動かなくても、最終状態が見える**：登場前に隠す処理は、JS が `<html>` に `.motion-ok` を付けたときだけ効くように書く（MUST）
- **動かすのは `translate` / `rotate` / `scale` / `opacity` だけ**。例外は、ダイヤ枠の線を描く `stroke-dashoffset` と、ダイヤ形に開く面（オープニングの幕 §9.4、モバイルメニュー §8.3、ページ移動 §9.7）の `clip-path`。幅・高さ・位置（`top` など）・影は動かさない（MUST）

### 9.2 トークン

```css
--ease-snap: cubic-bezier(.7, 0, .2, 1);     /* きびきび滑る */
--ease-slap: cubic-bezier(.2, 1.5, .4, 1);   /* ステッカーを貼る：軽いオーバーシュート */
--ease-whoosh: cubic-bezier(.16, 1, .3, 1);  /* スピード線：速く入って、ふっと止まる */
--dur-fast: 120ms;   /* ホバー、押下 */
--dur-base: 240ms;   /* 開閉 */
--dur-slow: 480ms;   /* ステッカーの登場 */
--dur-draw: 900ms;   /* ダイヤ枠の線を描く */
--beat: 500ms;       /* 拍（120BPM）。常時の動きはすべてこの倍数 */
--stagger: 80ms;     /* 複数の要素を順番に動かす間隔 */
```

### 9.3 動く装飾の組み立て方

登場・応答・常時の動きが同じ要素で衝突しないように、動く装飾は**外側と内側の2層**で作る（MUST）。

```html
<span class="sticker" data-enter="sticker" style="--tilt: 12deg; --i: 0" aria-hidden="true">
  <svg class="kira-loop" style="--g: 1">…</svg>
</span>
```

- **外側**（`.sticker`）：傾き `--tilt`、登場（トランジション）、ホバーの揺れ（アニメーション）
- **内側**（`svg`）：常時ループ
- 位置決めに `translate` を使っている要素（中央寄せなど）には、動きを付けない。ラッパーを1枚足して、そちらに付ける

`<html>` のクラスは、`<head>` の中のインラインスクリプトで、最初の描画より前に付ける（MUST）。モジュールのスクリプトで付けると、装飾が一瞬見えてから消えるチラつきが出るため。

```html
<script>
  (() => {
    const root = document.documentElement;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) return; // 最終状態をそのまま表示
    root.classList.add('motion-ok');
    // トップページのみ：オープニング（§9.4）を再生するか、再生済みか
    try {
      if (new URLSearchParams(location.search).has('intro') || !sessionStorage.getItem('offr39x-intro')) {
        root.classList.add('is-intro');
        sessionStorage.setItem('offr39x-intro', '1');
      } else {
        root.classList.add('intro-seen');
      }
    } catch (e) { root.classList.add('intro-seen'); }
  })();
</script>
```

登場の合図は、IntersectionObserver 1つでページ全体をまとめて見張る。

```js
if (document.documentElement.classList.contains('motion-ok')) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -15% 0px' });
  document.querySelectorAll('[data-enter]').forEach((el) => io.observe(el));
}
```

`scroll` イベントで動きを作らない（MUST）。

### 9.4 ヒーローの貼り出し（オープニング。トップページのみ、1セッション1回）

サイトを開いた瞬間に、ロゴを中心に「ブワッ」と広がる。サイトで一番派手な動きはここに集める。

| 時間 | 動き |
|---|---|
| 200–1300ms | 画面を覆う黒い幕が、ロゴの中心からダイヤ形に開いてページが現れる |
| 300–1900ms | ダイヤ枠の線が、途切れ目から描かれていく（§9.5 と同じ動きを 1600ms で） |
| 500–1400ms | ロゴが叩きつけられる（`scale 1.8 → 0.94 → 1.03 → 1` と傾きを弾ませながら戻す。各区間 `--ease-snap`） |
| 800–2200ms | ロゴの後ろから、衝撃波のダイヤ枠（コーラル → 墨）が広がって消える（各 1200ms） |
| 900–2660ms | ロゴの後ろから、星・キラ・小さなダイヤ（レモン・ミント・ティール・コーラル）の粒が放射状に飛び散って消える（各 1600ms） |
| 1300–2580ms | 星・キラ・音符・名札が、ロゴの中心から定位置へ飛び出して、160ms ずつ遅れて貼られる（各 800ms） |
| 2000–3060ms | スピード線が1本ずつ飛び込む（各 700ms、120ms ずつ遅らせる） |

- 合計 3秒前後。開いた瞬間の騒がしさを、目で追える速さで見せる。2回目以降の表示では、最終状態を即表示する
- 黒い幕・衝撃波・粒は、このオープニングのためだけに出し、終わったら消す。粒と衝撃波はロゴの後ろ（ダイヤ枠の手前）に置き、ロゴの上には重ねない
- 本文・リード文・ボタンは動かさない。幕が開くまでの間（読み込みから最長約 1.3 秒）だけ隠れる。この間も操作は止めない：幕には `pointer-events: none` を付け、下のリンクやボタンはクリック・キーボードで使える状態のままにする
- 幕を開く動きだけは `clip-path` を動かしてよい（§9.1 の例外。モバイルメニューと同じ）
- ヒーローの装飾は、この流れで登場させる。§9.5 の登場を二重に付けない
- ロゴ画像自体は、この貼り出し以外では動かさない

それぞれの値：

| 部品 | 値 |
|---|---|
| 黒い幕 | `--ink` の全画面。穴はダイヤ形で、中心はロゴの中心。大きさを `0` から `120vmax`（画面の端まで届く大きさ）まで広げる。1100ms / `--ease-snap`。これより大きくすると、前半で幕が消えて開く様子が見えない |
| ロゴ | `scale(1.8) rotate(-8deg)` 不透明度 0 → 15% で不透明 → 55% で `scale(.94) rotate(1.5deg)` → 78% で `scale(1.03) rotate(-.5deg)` → 元の大きさ。900ms、各区間 `--ease-snap`（`--ease-slap` は序盤に動きが詰まり、一瞬で終わって見えるため使わない） |
| 衝撃波 | ロゴと同じ大きさのダイヤ枠の線（コーラル、続いて墨）。`scale .3 → 2.2`、不透明度 1 → 0。各 1200ms / `--ease-whoosh` |
| 粒 | 20個。星・キラ・小さなダイヤを順に使い、小さなダイヤはレモン・ミント・ティール・コーラルを順に塗る（墨のフチ）。大きさ 28 / 42 / 56px、飛ぶ距離はロゴの幅の 0.5〜0.86 倍、回転は ±90〜375 度。`scale .2 → 1`、70% まで不透明で、最後に消える。各 1600ms / `--ease-whoosh`、開始を 0 / 80 / 160ms ずらす |
| ステッカー | 登場前は、ロゴの中心の位置（`--fx` / `--fy`）で `scale .3`。定位置へ `translate` 800ms / `--ease-whoosh`、`scale`・`rotate` 800ms / `--ease-slap`、不透明度 `--dur-base`。160ms（`--stagger` の2倍）ずつ遅らせる |
| ダイヤ枠・スピード線 | §9.5 と同じ動きを、ダイヤ枠は 1600ms、スピード線は各 700ms・120ms ずつ遅らせて、ゆっくり見せる |

```css
.is-intro [data-intro] { --delay: var(--intro-delay, 0ms); }

/* オープニングのステッカー：ロゴの中心から飛び出す */
.is-intro [data-intro][data-enter="sticker"] {
  transition: opacity var(--dur-base) linear,
              scale 800ms var(--ease-slap),
              rotate 800ms var(--ease-slap),
              translate 800ms var(--ease-whoosh);
  transition-delay: calc(var(--delay, 0ms) + var(--i, 0) * var(--stagger) * 2);
}
.motion-ok.is-intro [data-intro][data-enter="sticker"]:not(.is-in) {
  translate: var(--fx, 0px) var(--fy, 0px);
  scale: .3;
}
.is-intro [data-intro] .draw { transition-duration: 1600ms; }
.is-intro .speed[data-intro] > * {
  transition-duration: 700ms, 700ms, var(--dur-base);
  transition-delay: calc(var(--delay, 0ms) + var(--i, 0) * 120ms);
}
```

衝撃波と粒は、待ち時間と終わった後に見えないよう、ふだんの不透明度を `0` にし、`animation-fill-mode` を付けない（`both` を付けると、待ち時間に小さな枠や点がロゴの中心に見える）。

実装の決まりごと：

- ヒーローの装飾には `data-intro` と、登場を始める時刻 `--intro-delay` を付ける。`.is-intro` のときだけ、その時刻を §9.5 の遅れ `--delay` に入れる
- 再生済みのセッション（`.intro-seen`）では、`data-intro` の装飾を登場前の状態に隠さない。隠す指定は `:not(.intro-seen [data-intro])` で外す
- 黒い幕は `.is-intro body::after` で作る（JavaScript が動かなければ幕も出ない）。穴の中心は、ロゴの中心のおおよその位置を CSS で計算して使う
- 衝撃波と粒は、`.is-intro` のときだけ JavaScript で作り、ロゴを包む要素に入れて、終わったら消す。粒の飛ぶ向き・距離・大きさは、乱数を使わずに番号から決め、毎回同じ形にする
- ステッカーがロゴの中心から飛び出す距離 `--fx` / `--fy` は、JavaScript が測って入れる。登場の合図（`.is-in`）より前に入れる
- デザイン確認用に、URL に `?intro` を付けると、再生済みのセッションでもオープニングを再生する

### 9.5 登場の動き（画面に入ったとき1回）

| 動き | 対象 | 内容 | 時間・イージング |
|---|---|---|---|
| **ステッカーが貼られる** | すべてのステッカー（星・キラ・音符・名札・ダイヤ札・吹き出し・丸シール） | 少し大きく、傾きが 10度ずれた状態から、本来の大きさと傾きに「ペタッ」と収まる | `--dur-slow` / `--ease-slap`。同じセクションの中では `--stagger` ずつ遅らせる（6個まで） |
| **キャンディ見出しの仕上げ** | キャンディ文字の見出し | ①コーラルのずらしが、文字の真後ろから左下の定位置へ滑り出る ②続けて、右上のツヤが一瞬大きく光って元に戻る | ① 360ms / `--ease-snap` ② `--dur-slow`、1文字ずつ 30ms 遅らせる |
| **ダイヤ枠の線が描かれる** | ダイヤ枠 | 途切れ目の位置から、線が一筆書きで描かれていく。黒と灰の線を同時に描く | `--dur-draw` / `--ease-snap` |
| **スピード線が飛び込む** | スピード線 | 1本ずつ、左から勢いよく入ってくる | 420ms / `--ease-whoosh`。上の線から 60ms ずつ遅らせる |

見出しの文字そのもの（`.candy__face` の形と位置）は動かさない。動くのは、ずらしとツヤだけ。

`--delay` は、ふだんは `0ms`。トップページのオープニング（§9.4）でだけ、ヒーローの装飾の登場をその時刻まで遅らせるのに使う。`:not(.intro-seen [data-intro])` は、オープニングを再生済みのセッションで、ヒーローの装飾を隠さないための指定。

**ステッカー**

```css
[data-enter="sticker"] {
  rotate: var(--tilt, 0deg);
  transition: opacity var(--dur-fast) linear,
              scale var(--dur-slow) var(--ease-slap),
              rotate var(--dur-slow) var(--ease-slap);
  transition-delay: calc(var(--delay, 0ms) + var(--i, 0) * var(--stagger));
}
.motion-ok [data-enter="sticker"]:not(.is-in):not(.intro-seen [data-intro]) {
  opacity: 0; scale: 1.25; rotate: calc(var(--tilt, 0deg) - 10deg);
}
```

**キャンディ見出し**（§5.1 の部品に足す。`--i` は文字の番号で、コンポーネントが自動で振る）

```css
@property --gloss { syntax: "<percentage>"; inherits: true; initial-value: 46%; }

.candy :is(.candy__off, .candy__line--off) { transition: translate 360ms var(--ease-snap); }
.motion-ok .candy:not(.is-in) :is(.candy__off, .candy__line--off) { translate: 0 0; }
.candy.is-in .candy__face > span {
  animation: gloss-flash var(--dur-slow) var(--ease-snap) calc(360ms + var(--i, 0) * 30ms) both;
}
@keyframes gloss-flash { 0% { --gloss: 46%; } 40% { --gloss: 72%; } 100% { --gloss: 46%; } }
```

**ダイヤ枠**（線を、描画用のマスクで隠しておき、マスクを伸ばして見せる。`id` はページ内で重複させない）

```html
<svg class="diamond" viewBox="0 0 100 100" data-enter="draw" aria-hidden="true">
  <mask id="dm-hero" maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">
    <path class="draw" d="M50 3 L97 50 L50 97 L3 50 Z" pathLength="100" fill="none" stroke-width="14" />
  </mask>
  <g mask="url(#dm-hero)">
    <path class="diamond__back" d="M50 3 L97 50 L50 97 L3 50 Z" fill="none" stroke-width="5" transform="translate(3 -3)" />
    <path class="diamond__front" d="M50 3 L97 50 L50 97 L3 50 Z" pathLength="100" fill="none" stroke-width="5"
          stroke-dasharray="0 4 30 6 40 5 15" />
  </g>
</svg>
```

```css
/* stroke はマスクの色。白い部分だけ線が見える */
.draw {
  stroke: var(--paper); stroke-dasharray: 100 100; stroke-dashoffset: 0;
  transition: stroke-dashoffset var(--dur-draw) var(--ease-snap) var(--delay, 0ms);
}
.motion-ok [data-enter="draw"]:not(.is-in):not(.intro-seen [data-intro]) .draw { stroke-dashoffset: 100; }
```

黒い線の `stroke-dasharray` は `0` で始める。線の始点が途切れ目の中に入り、「途切れ目から描かれる」動きになる。

**スピード線**（線を1本ずつ動かすため、`<polygon>` を `<svg>` の直下に1本ずつ書き、`--i` に上からの番号を入れる。`<use>` で1つにまとめない）

```css
.speed > * {
  transform-box: fill-box; transform-origin: left center;
  transition: translate 420ms var(--ease-whoosh), scale 420ms var(--ease-whoosh), opacity var(--dur-fast) linear;
  transition-delay: calc(var(--delay, 0ms) + var(--i, 0) * 60ms);
}
.motion-ok .speed:not(.is-in):not(.intro-seen [data-intro]) > * { translate: -48px 0; scale: .6 1; opacity: 0; }
```

### 9.6 常時の動き

ループは、ページを読み込んだ時点で一斉に始める。画面に入ってから始めたり、画面外で止めたりしない（拍がずれるため）。ループは内側の要素に付ける（§9.3）。

| 動き | 対象 | 内容 | 周期 |
|---|---|---|---|
| **キラの瞬き** | キラ | 縮みながら45度回って、元に戻る。キラを3つのグループ（`--g: 0 / 1 / 2`）に分け、1拍ずつずらして順番に瞬かせる | 4拍（2秒）。瞬くのは最初の1拍だけ |
| **音符の揺れ** | 音符 | 拍ごとに小さく跳ねながら、左右に傾く | 2拍（1秒） |
| **ダイヤ枠の視差** | ダイヤ枠（のラッパー） | スクロールに合わせて、文字とは違う速さで上下にずれる。大きい枠ほど大きくずらす | スクロール連動（拍とは無関係） |
| **流れる帯** | §8.7 | 一定の速さで流れる | 80拍（40秒） |

```css
.kira-loop {
  transform-box: fill-box; transform-origin: center;
  animation: kira calc(var(--beat) * 4) var(--ease-snap) calc(var(--beat) * var(--g, 0)) infinite;
}
@keyframes kira {
  0%, 25%, 100% { scale: 1; rotate: 0deg; }
  12% { scale: .55; rotate: 45deg; }
}

.note-loop {
  transform-box: fill-box; transform-origin: 50% 100%;
  animation: note calc(var(--beat) * 2) ease-in-out infinite;
}
@keyframes note {
  0%, 100% { translate: 0 0; rotate: -6deg; }
  25%, 75% { translate: 0 -6px; rotate: 0deg; }
  50% { translate: 0 0; rotate: 6deg; }
}

@supports (animation-timeline: view()) {
  .parallax { animation: drift linear both; animation-timeline: view(); animation-range: cover; }
  @keyframes drift {
    from { translate: 0 var(--drift, 64px); }
    to { translate: 0 calc(var(--drift, 64px) * -1); }
  }
}
```

- 視差の量 `--drift`：画面幅を超える巨大な枠は `96px`、セクションの角に覗く枠は `48px`
- 視差はスクロール連動アニメーション（`animation-timeline: view()`）で作る。非対応のブラウザでは動かさない
- 1画面に入る常時ループ（キラ・音符・流れる帯）の数は §7.2 の上限に従う

### 9.7 操作への応答

- **ボタン**：ずらし戻し（§8.1）
- **リンク**：ミントの帯が伸びる（§8.2）
- **押せる札**：ずらしが現れる（§8.5）
- **メニュー・アコーディオンの開閉**：`--dur-base` / `--ease-snap`。開いたものが「出てくる」向きに動く
- **ステッカーの揺れ**：マウスを乗せると、ぷるっと3回揺れて元の傾きに戻る。1拍で終える。リンクでない装飾のステッカーにも付けてよい

```css
@media (hover: hover) {
  .sticker:hover { animation: wobble var(--beat) var(--ease-snap); }
}
@keyframes wobble {
  0%, 100% { rotate: var(--tilt, 0deg); }
  20% { rotate: calc(var(--tilt, 0deg) + 8deg); }
  45% { rotate: calc(var(--tilt, 0deg) - 6deg); }
  70% { rotate: calc(var(--tilt, 0deg) + 3deg); }
}
```

- **ページ移動**：新しいページが、画面の中央からダイヤ形に広がって現れる。ヘッダーは切り替えに巻き込まず、そのまま残す

```css
@view-transition { navigation: auto; }
.site-header { view-transition-name: site-header; }
::view-transition-old(root) { animation: none; }
::view-transition-new(root) { animation: diamond-in 600ms var(--ease-snap); }
@keyframes diamond-in {
  from { clip-path: polygon(50% 50%, 50% 50%, 50% 50%, 50% 50%); }
  to { clip-path: polygon(50% -50%, 150% 50%, 50% 150%, -50% 50%); }
}
```

ページを読み込み直さない作り（SPA）の場合は、画面を切り替える処理を `document.startViewTransition()` で包む。View Transitions に対応していないブラウザでは、普通に切り替わる。

### 9.8 動きを減らす設定

`prefers-reduced-motion: reduce` のときは、次のようにする（MUST）。

| 種類 | 扱い |
|---|---|
| 登場 | 最終状態を即表示する（`.motion-ok` も `.is-intro` も付けないので、オープニングも出ない） |
| 常時 | キラ・音符・流れる帯・視差をすべて止める |
| 応答 | ずらし戻し・ステッカーの揺れを止め、色の変化だけ残す |
| ページ移動 | アニメーションなしで切り替える |

```css
@media (prefers-reduced-motion: reduce) {
  .kira-loop, .note-loop, .parallax, .ticker__track, .sticker:hover { animation: none !important; }
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
  /* 応答は色の変化だけ残す */
  .btn, .card, .site-header__logo, .menu, .menu__list li, .site-nav__link::after {
    transition-property: color, background-color, border-color, opacity, visibility;
  }
  .btn-primary:hover, .btn-primary:active { translate: none; box-shadow: var(--shadow-off); }
  .menu, .menu.is-open { clip-path: none; }  /* メニューはダイヤ形に広げず、すぐ表示する */
  .menu__list li { translate: none; }
}
```

---

## 10. ロゴの扱い

- 支給されたロゴ画像をそのまま使う。色を変える、部品を分ける、影や発光を足す、縦横比を変える、回転させる、はすべて禁止（MUST）
- ファイルも支給のまま（1920×1920px の透過 PNG、約 490KB）を使い、縮小版・圧縮版・別形式は作らない。ヒーローとヘッダーで同じファイルを使い回し、大きさは CSS で決める。ヒーローのロゴには `fetchpriority="high"` を付けて先に読み込ませる
- `width` / `height` 属性（`1920`）を必ず書き、読み込み中にレイアウトがずれないようにする
- ロゴには白い型抜きフチが付いているので、白面・黒面・キャンディ面のどこに置いてもよい
- 周囲の余白：ロゴの幅の 1/10 以上。ステッカーやダイヤ枠はロゴに触れてよいが、ロゴの上には重ねない
- 最小幅：ヘッダーで `120px`。それより小さくしない（ヘッダーの高さに収まらない分は、下へはみ出させる §8.3）
- ロゴとキャンディ文字を同じ画面に並べない（§7.2）。主役が2つになるため

---

## 11. レスポンシブ

| ブレークポイント | 幅 |
|---|---|
| `sm` | 480px |
| `md` | 768px |
| `lg` | 1024px |
| `xl` | 1440px |

768px 未満でやること：
- 装飾の量をモバイルの上限（§7.2）に切り替える
- 札の傾きを `0` にする
- 主ボタンを全幅にする
- キャンディ文字の黒フチ・ずらし量は em 指定なので、自動で縮む。それ以上は細くしない
- 横スクロールを出さない：はみ出す装飾の親に `overflow-x: clip` を付ける（`hidden` にすると `position: sticky` が壊れるため `clip`）

### 11.1 ブラウザごとの対応と確認

| 機能 | Chrome | Safari（WebKit） | Firefox | 非対応のとき |
|---|---|---|---|---|
| キャンディ文字（`background-clip: text`・`-webkit-text-stroke`） | ○ | ○ | ○ | — |
| ツヤの光り（`@property --gloss`） | ○ | ○ | ○ | ツヤは光らず、初期値 46% のまま |
| オープニングの幕（`clip-path: polygon(evenodd, …)`） | ○ | ○ | ○ | — |
| ダイヤ枠の視差（`animation-timeline: view()`） | ○ | ○ | × | 視差なしで止まって表示（§9.6） |
| ページ移動（`@view-transition`） | ○ | ○ | × | 普通に切り替わる（§9.7） |

- Safari の ○ は Safari 26 以降（WebKit 27 で確認）。Firefox の列は各ブラウザの対応状況に基づくもので、実際の表示は未確認
- 「非対応のとき」の挙動はどれも仕様どおりで、代わりの動きを足さない
- 確認は、本番ビルド（`npm run build` → `npx vite preview --port 4173`）に対して行う。開発サーバーは CSS を JavaScript で読み込むため、JavaScript なしの表示や動きの時間を正しく確かめられない
- Firefox と WebKit（デスクトップ 1440×900、iPhone 13）は `npm run check:browsers` で撮影・確認できる。結果は `recordings/browsers/` に出る
- 2026年11月のトップページの確認結果：Chrome と WebKit（デスクトップ・iPhone 13）でエラー・横スクロールなし、オープニングと黒面の登場まで表示を確認。Firefox は確認環境（macOS）で Playwright の Firefox が起動せず未確認。実機の iPhone / Android も未確認

---

## 12. アクセシビリティ（品質の床）

- 文字のコントラストは §3.3 の表に従う（MUST）
- 装飾（キャンディ文字の重ねた版、ステッカー、ダイヤ枠、スピード線）は、すべて `aria-hidden="true"` か CSS 背景にする
- `prefers-reduced-motion: reduce` では、§9.8 のとおり、登場・常時・応答・ページ移動の動きをすべて止める。操作への応答は色の変化だけ残す
- JavaScript が動かなくても、すべての装飾が最終状態で見える（§9.1）
- タップ領域は最低 `44×44px`
- キーボードの移動順は、見た目の順と同じにする。トップページでは「スキップリンク → ナビ → ヘッダーの CTA → ヒーローの CTA → 本文のリンク → 流れる帯 → 札 → 締めの CTA → フッター」。モバイルはナビの代わりにメニューボタン
- 流れる帯は `tabindex="0"` でフォーカスでき、フォーカス中は止まる。`role="marquee"` と、帯の語を並べた `aria-label` を付け、中の繰り返しは `aria-hidden="true"`
- モバイルメニューを開いたら、閉じるボタンにフォーカスを移し、Tab でメニューの中を巡回させる。Esc か閉じるボタンで閉じ、フォーカスをメニューボタンに戻す。メニューの中のリンクを選んだときは、移動先にフォーカスを任せる
- フォーカスリングは §8.10 を全要素で使う
- 意味のある情報を、傾いた文字やステッカーの中だけに置かない

---

## 13. やらないこと

テンプレートっぽさ・AI生成っぽさが出る定番の処理と、ロゴの世界観から外れる処理。

- 見出しの中の1語だけ色・太さ・斜体を変えて強調する
- 英字の大文字ラベルを、字間を空けて見出しの上に置く（アイブロウ）
- 意味のない連番（01 / 02 / 03）。本当に順番がある内容（タイムテーブル、手順）だけに使う
- `A · B · C` のように中黒でメタ情報をつなぐ。区切りが必要なら星かダイヤ
- ボタンやリンクの文字の末尾に「→」を付ける
- 同じ角丸・同じソフトな影のカードを均等に並べるだけのレイアウト
- キャンディ以外のグラデーション、ネオンの発光、すりガラス
- `#111` などの「ほぼ黒」
- 白面で、ミント・ティール・コーラルを文字色に使う
- 等幅フォントの小さなラベル
- スクロールに合わせて、セクションや本文がふわっと浮き上がってフェードインする演出（画面に入って動くのは、§9.5 のロゴ由来の装飾だけ）
- 本文・ボタン・リンク・フォームを動かす
- `scroll` イベントで動きを作る
- 拍（`--beat`）の倍数になっていない、ばらばらな周期のループ
- ロゴを加工する
- パレット・書体・フチ・角丸・影・イージングにない値を新しく足す

---

## 14. 実装後チェックリスト

各ページを作り終えたら、次をすべて確認する。

- [ ] 色はすべて §3.1 のトークンから来ている
- [ ] 文字色の組み合わせが §3.3 の「不可」に当たっていない
- [ ] ヒーローにロゴかキャンディ文字があり、重ねた版に `aria-hidden` が付いている
- [ ] §7.1 の最低量を満たし、§7.2 の上限を超えていない
- [ ] 静域にステッカーやダイヤ枠が重なっていない
- [ ] コーラルのずらしがすべて左下、ダイヤ枠の灰の線がすべて右上を向いている
- [ ] 本文の1行が 38字以内で、左揃えになっている
- [ ] 黒面が連続しておらず、キャンディ面が1つ以下
- [ ] 375px 幅で横スクロールが出ない
- [ ] キーボードだけで全操作ができ、フォーカスが見える
- [ ] `prefers-reduced-motion` で自動の動きが止まる
- [ ] JavaScript を切っても、すべての装飾が最終状態で見える
- [ ] 常時ループの周期と開始の遅れが、すべて `--beat` の整数倍になっている
- [ ] 動く装飾が外側・内側の2層になっていて、ホバーで揺らしても登場の動きが再生し直されない
- [ ] 動いているのが装飾だけで、本文・ボタンが動いていない
- [ ] §13 の「やらないこと」に当たる処理がない
- [ ] ステッカーの形が §5.4・§8.6 のデータと同じで、ページごとに描き直していない
- [ ] 文言が、渡されたコンテンツか角括弧のプレースホルダーだけになっている（ロゴの語の例外を除く）

トップページだけ、次も確認する。

- [ ] 高さ 900px のデスクトップの最初の画面に、主 CTA まで入っている（§6.3）
- [ ] オープニングが §9.4 の順番と時間で再生され、本文・リード文・ボタンが動いていない
- [ ] 同じタブで読み込み直すとオープニングが再生されず、ヒーローの装飾が最終状態で表示される。URL に `?intro` を付けると再生される
- [ ] 動きを減らす設定と JavaScript なしの環境で、黒い幕・衝撃波・粒が出ず、最終状態で表示される
- [ ] 衝撃波と粒が、ロゴの上・静域の上に重なっていない

---

## 付録：デザイントークン

```css
:root {
  /* Color */
  --ink: #000000;
  --paper: #FFFFFF;
  --stripe: #494949;
  --coral: #FF7856;
  --lemon: #F4FF70;
  --mint: #62FE9D;
  --teal: #2FE5BB;
  --grad-candy: linear-gradient(180deg, #F4FF70 0%, #D0FF7B 25%, #9EFF8A 50%, #62FE9D 75%, #2FE5BB 100%);

  /* Type */
  --font-display: "Fredoka Variable", "Mochiy Pop One", sans-serif;
  --font-body: "Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif;

  --fs-hero: clamp(64px, 14vw, 192px);
  --fs-h1: clamp(44px, 7.5vw, 104px);
  --fs-h2: clamp(30px, 4.5vw, 48px);
  --fs-h3: 24px;
  --fs-lead: 21px;
  --fs-body: 16px;
  --fs-small: 14px;
  --fs-caption: 12px;

  /* Logo-derived effects */
  --off-x: -0.06em;   /* キャンディ文字のずらし（左下） */
  --off-y: 0.04em;
  --shadow-off: -5px 5px 0 var(--coral), -5px 5px 0 3px var(--ink);

  /* Lines & shape */
  --line-ui: 3px;
  --line-sticker: 4px;
  --edge-sticker: 8px;
  --r-none: 0;
  --r-field: 10px;
  --r-card: 14px;
  --r-pill: 999px;

  /* Space */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px; --sp-8: 64px;
  --sp-9: 96px; --sp-10: 128px; --sp-11: 192px;
  --section-y: clamp(72px, 10vw, 160px);
  --page-x: clamp(16px, 5vw, 64px);
  --content-max: 1280px;
  --quiet-zone: 24px;
  --gutter: 24px;      /* 768px 未満は 16px */
  --header-h: 72px;    /* 768px 未満は 60px */

  /* Motion */
  --ease-snap: cubic-bezier(.7, 0, .2, 1);
  --ease-slap: cubic-bezier(.2, 1.5, .4, 1);
  --ease-whoosh: cubic-bezier(.16, 1, .3, 1);
  --dur-fast: 120ms;
  --dur-base: 240ms;
  --dur-slow: 480ms;
  --dur-draw: 900ms;
  --beat: 500ms;   /* 120BPM */
  --stagger: 80ms;

  /* Layers */
  --z-content: 10;
  --z-sticker: 20;
  --z-header: 50;
  --z-overlay: 100;
}

@media (max-width: 767px) {
  :root { --gutter: 16px; --header-h: 60px; }
}

/* キャンディ文字のツヤの大きさ。登場の動き（§9.5）で値をアニメーションさせるため登録する */
@property --gloss { syntax: "<percentage>"; inherits: true; initial-value: 46%; }
```
