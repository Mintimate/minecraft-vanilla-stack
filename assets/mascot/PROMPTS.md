# 橙芽素材与提示词

橙色主题的 Q 版少女吉祥物：橙发、琥珀眼、橙色冒险外套、奶油色背带裙、棕色靴子与 MC 草方块发饰。五张 PNG 均使用透明背景，由内置 imagegen 生成。

| 文件 | 动作 | 表情 | README 用途 |
| --- | --- | --- | --- |
| hello.png | 挥手欢迎 | 灿烂开口笑 | 首页 |
| server.png | 按下开机键 | 单眼眨眼、得意闭嘴笑 | Docker 快速开服 |
| client.png | 地图与下载包 | 睁大眼睛、圆嘴惊喜 | 玩家客户端 |
| config.png | 清单与铅笔 | 皱眉、微噘嘴认真思考 | YAML 配置 |
| admin.png | 笔记本与点赞 | 双眼闭合、安心微笑 | Makers 网页管理 |

新增动作时以 `hello.png` 为角色参照，保留发型、草方块发饰、服装、配色和身材比例；表情需随场景改变，分别设计眉毛、眼睑、视线与嘴型，避免复用同一张笑脸。以下记录内置 imagegen 的实际提示词：动作图以 `hello.png` 为参照，最后一节以各动作图为目标只修改面部表情。

## 欢迎图的 Q 版调整

```text
Use case: style-transfer
Asset type: transparent PNG README mascot.
Input image 1: edit target; keep the orange-haired anime girl identity and original outfit theme, redesign her proportions and expression to be much cuter and more youthful.
Primary request: Make Chengya (橙芽) a very cute, lively, youthful anime girl mascot, with large warm amber eyes, a soft round face, short rounded body proportions around THREE AND A HALF HEADS TALL, a larger head and a cheerful gentle smile. She should feel like a charming cozy-game heroine, not a fashion illustration or mature realistic woman.
Preserve the tangerine orange hair, little side braid, cream cubic leaf hairclip, orange adventure jacket, cream overall dress with a practical pocket, warm brown opaque leggings and lace-up boots, small square utility pouch. Simplify garment details; make jacket sleeves slightly oversized, boots small and cute. Keep the dress modest and practical. Make the hair soft and bouncy rather than very long flowing strands.
Pose: full body, standing in three-quarter view and waving hello with one hand, other hand holding her pouch strap. Natural human girl anatomy and hands, no block creature.
Style: polished cute Japanese anime chibi sticker art, expressive thick-to-thin warm outlines, gentle soft cel shading, bright sunny oranges, creamy whites and warm brown; tiny green accent only. Readable at small README sizes.
Composition: single character centered on a square transparent canvas, full head-to-boots visible with 10% padding. No environment.
Constraints: transparent alpha background, no backdrop or ground, no cast shadow, no checkerboard, no labels, no text or letters, no logos, no watermark, no border, no extra figures.
```

## 欢迎图的草方块发饰调整

```text
Use case: precise-object-edit
Input image 1 is the edit target, the orange-haired cute anime girl mascot.
Change ONLY the hair ornament by her side braid. Replace the current cream cube with leaves with a miniature recognizable Minecraft GRASS BLOCK hair clip: a tiny three-dimensional cube with a flat bright-green pixel-textured grassy top, pixelated earthy brown dirt on the two visible sides, and a jagged short green grass fringe descending along the upper edges. Square cubic corners, roughly the same size and position as the previous cube. No face, no holes or dots, no sprout or leaves attached to this block.
Keep the girl's identity, round face, eyes, expression, orange hair and braid, outfit, hands, waving pose, boots, pouch, proportions, art style, lighting, framing and colors otherwise unchanged. Still cute and youthful orange-themed chibi girl.
Preserve the transparent alpha background. No text, letters, logos, watermark, scenery or new props.
```

## server.png

```text
Use case: identity-preserve
Asset type: transparent PNG action sticker for the Minecraft Vanilla Stack README.
Input image 1: character reference and edit target. Use this exact cute orange-haired anime girl, Chengya (橙芽), and make an alternate action pose.
Preserve identity: exactly the same round face, large amber eyes, orange bangs and little side braid, miniature Minecraft GRASS BLOCK hairclip (flat green pixel-grass top, earthy brown pixel dirt sides, cubic corners; no leaves or face), orange oversized adventure jacket, cream overall dress, brown opaque leggings, small brown lace-up boots and square tan utility pouch. Preserve her youthful, cute, THREE AND A HALF HEADS TALL chibi proportions. Same polished Japanese anime illustration style, warm outlines, soft cel shading, color palette and clothing design. She has human hands and human anatomy. Do not redesign her.
Pose for the Docker quick-start section: the girl kneels next to a small orange-and-cream stack of two server boxes with tiny green status LEDs and a square power button, one hand pressing the power button and the other hand giving a small thumbs-up. Happy proud smile. Compact full-body composition; server boxes are cute simple block-shaped props, no display text.
Composition: one girl and only the specified small props, centered in a square canvas with generous padding, full silhouette visible, readable at small sizes.
Constraints: genuinely transparent alpha background; no backdrop, no floor plane, no cast shadow, no checkerboard texture, no text or letters, no logos, no watermark, no border, no extra figures, no scenery.
```

## client.png

```text
Use case: identity-preserve
Asset type: transparent PNG action sticker for the Minecraft Vanilla Stack README.
Input image 1: character reference and edit target. Use this exact cute orange-haired anime girl, Chengya (橙芽), and make an alternate action pose.
Preserve identity: exactly the same round face, large amber eyes, orange bangs and little side braid, miniature Minecraft GRASS BLOCK hairclip (flat green pixel-grass top, earthy brown pixel dirt sides, cubic corners; no leaves or face), orange oversized adventure jacket, cream overall dress, brown opaque leggings, small brown lace-up boots and square tan utility pouch. Preserve her youthful, cute, THREE AND A HALF HEADS TALL chibi proportions. Same polished Japanese anime illustration style, warm outlines, soft cel shading, color palette and clothing design. She has human hands and human anatomy. Do not redesign her.
Pose for the player-client section: the girl stands looking excited, holding a little open parchment map in one hand and a small cube-shaped package with a simple down-arrow symbol in the other hand. The props suggest exploring and installing a game pack. Warm smile, head tilted slightly; full body visible. Map has only a simple trail and tiny square tree motifs, no text.
Composition: one girl and only the specified small props, centered in a square canvas with generous padding, full silhouette visible, readable at small sizes.
Constraints: genuinely transparent alpha background; no backdrop, no floor plane, no cast shadow, no checkerboard texture, no text or letters, no logos, no watermark, no border, no extra figures, no scenery.
```

## config.png

```text
Use case: identity-preserve
Asset type: transparent PNG action sticker for the Minecraft Vanilla Stack README.
Input image 1: character reference and edit target. Use this exact cute orange-haired anime girl, Chengya (橙芽), and make an alternate action pose.
Preserve identity: exactly the same round face, large amber eyes, orange bangs and little side braid, miniature Minecraft GRASS BLOCK hairclip (flat green pixel-grass top, earthy brown pixel dirt sides, cubic corners; no leaves or face), orange oversized adventure jacket, cream overall dress, brown opaque leggings, small brown lace-up boots and square tan utility pouch. Preserve her youthful, cute, THREE AND A HALF HEADS TALL chibi proportions. Same polished Japanese anime illustration style, warm outlines, soft cel shading, color palette and clothing design. She has human hands and human anatomy. Do not redesign her.
Pose for the YAML configuration section: the girl sits with her legs neatly to one side, holding a cream clipboard with several orange square checkboxes and short brown lines. She holds a pencil in her other hand and looks focused but cheerful. The clipboard suggests editing a recipe/configuration. No readable writing or letters; only graphic checkboxes and line marks. Full body visible in a compact composition.
Composition: one girl and only the specified small props, centered in a square canvas with generous padding, full silhouette visible, readable at small sizes.
Constraints: genuinely transparent alpha background; no backdrop, no floor plane, no cast shadow, no checkerboard texture, no text or letters, no logos, no watermark, no border, no extra figures, no scenery.
```

## admin.png

```text
Use case: identity-preserve
Asset type: transparent PNG action sticker for the Minecraft Vanilla Stack README.
Input image 1: character reference and edit target. Use this exact cute orange-haired anime girl, Chengya (橙芽), and make an alternate action pose.
Preserve identity: exactly the same round face, large amber eyes, orange bangs and little side braid, miniature Minecraft GRASS BLOCK hairclip (flat green pixel-grass top, earthy brown pixel dirt sides, cubic corners; no leaves or face), orange oversized adventure jacket, cream overall dress, brown opaque leggings, small brown lace-up boots and square tan utility pouch. Preserve her youthful, cute, THREE AND A HALF HEADS TALL chibi proportions. Same polished Japanese anime illustration style, warm outlines, soft cel shading, color palette and clothing design. She has human hands and human anatomy. Do not redesign her.
Pose for the optional Makers RCON management section: the girl sits with knees bent comfortably, using a small orange laptop in front of her; one hand typing, the other giving an enthusiastic thumbs-up. The screen shows three simple green status dots and minimal square UI panels, no text. Cheerful confident expression. Full body and entire laptop visible; no chair or room.
Composition: one girl and only the specified small props, centered in a square canvas with generous padding, full silhouette visible, readable at small sizes.
Constraints: genuinely transparent alpha background; no backdrop, no floor plane, no cast shadow, no checkerboard texture, no text or letters, no logos, no watermark, no border, no extra figures, no scenery.
```

## 场景表情修正

角色造型与动作保持一致，四张章节图分别修改面部表情；欢迎图沿用开口笑。

### server.png

```text
Use case: precise-object-edit
Asset type: one transparent PNG expression variant for a README mascot.
Input image 1 is the edit target, showing Chengya (橙芽), the cute orange-haired chibi girl, in her existing action pose.
Primary request: Change ONLY the FACIAL EXPRESSION. Redraw eyes/eyelids, eyebrows, mouth and cheek expression as explicitly requested below. The original cheerful open-eyed open-mouth expression must NOT be retained. Maintaining character identity does not mean maintaining her old expression.
Confident playful WINK: close the eye on the viewer's RIGHT into a clearly visible curved wink with eyelashes; keep the other amber eye open. Raise one eyebrow playfully. Replace the current big open mouth with a small closed-mouth asymmetric smug smile. Add subtle cheek blush. The wink and small smirk must be obvious at 144px; no round open mouth.
Invariants: keep the same character identity, face shape, orange hair and side braid, miniature Minecraft grass-block hairclip, orange jacket, cream overall dress, opaque brown leggings, brown boots, bag, exact full-body action pose, hands, existing props, framing, image size, color palette, clean anime linework and soft cel-shading. Do not alter the body, add props, or change the layout.
Preserve the genuinely transparent alpha background. No backdrop, checkerboard, floor, text, speech bubbles, watermarks, logos or extra figures. The expression change must remain easy to read when the full image is shown at 144 pixels wide.
```

### client.png

```text
Use case: precise-object-edit
Asset type: one transparent PNG expression variant for a README mascot.
Input image 1 is the edit target, showing Chengya (橙芽), the cute orange-haired chibi girl, in her existing action pose.
Primary request: Change ONLY the FACIAL EXPRESSION. Redraw eyes/eyelids, eyebrows, mouth and cheek expression as explicitly requested below. The original cheerful open-eyed open-mouth expression must NOT be retained. Maintaining character identity does not mean maintaining her old expression.
Delighted SURPRISE AND ANTICIPATION: both eyes wide and round with larger sparkling highlights; both eyebrows raised high. Replace the broad smiling mouth with a SMALL ROUND 'o'-SHAPED OPEN MOUTH, clearly visible surprise, like discovering a new world. Slight blush. The face must look surprised, not the old happy open-mouth smile. Both eyes remain open; no wink.
Invariants: keep the same character identity, face shape, orange hair and side braid, miniature Minecraft grass-block hairclip, orange jacket, cream overall dress, opaque brown leggings, brown boots, bag, exact full-body action pose, hands, existing props, framing, image size, color palette, clean anime linework and soft cel-shading. Do not alter the body, add props, or change the layout.
Preserve the genuinely transparent alpha background. No backdrop, checkerboard, floor, text, speech bubbles, watermarks, logos or extra figures. The expression change must remain easy to read when the full image is shown at 144 pixels wide.
```

### config.png

```text
Use case: precise-object-edit
Asset type: one transparent PNG expression variant for a README mascot.
Input image 1 is the edit target, showing Chengya (橙芽), the cute orange-haired chibi girl, in her existing action pose.
Primary request: Change ONLY the FACIAL EXPRESSION. Redraw eyes/eyelids, eyebrows, mouth and cheek expression as explicitly requested below. The original cheerful open-eyed open-mouth expression must NOT be retained. Maintaining character identity does not mean maintaining her old expression.
Cute CONCENTRATED THINKING: lower the gaze toward the checklist she is holding, gently knit the inner brows with one brow slightly higher, and make a tiny CLOSED pursed/pouting mouth with one cheek just slightly puffed. She looks thoughtfully absorbed in checking her recipe. Soft blush; serious but adorable, not angry or distressed. NO smiling open mouth, no wink, no broad grin. Preserve the eye color while changing gaze and eyelids.
Invariants: keep the same character identity, face shape, orange hair and side braid, miniature Minecraft grass-block hairclip, orange jacket, cream overall dress, opaque brown leggings, brown boots, bag, exact full-body action pose, hands, existing props, framing, image size, color palette, clean anime linework and soft cel-shading. Do not alter the body, add props, or change the layout.
Preserve the genuinely transparent alpha background. No backdrop, checkerboard, floor, text, speech bubbles, watermarks, logos or extra figures. The expression change must remain easy to read when the full image is shown at 144 pixels wide.
```

### admin.png

```text
Use case: precise-object-edit
Asset type: one transparent PNG expression variant for a README mascot.
Input image 1 is the edit target, showing Chengya (橙芽), the cute orange-haired chibi girl, in her existing action pose.
Primary request: Change ONLY the FACIAL EXPRESSION. Redraw eyes/eyelids, eyebrows, mouth and cheek expression as explicitly requested below. The original cheerful open-eyed open-mouth expression must NOT be retained. Maintaining character identity does not mean maintaining her old expression.
RELIEVED, CONTENTED CLOSED-EYE SMILE: BOTH EYES fully closed as upward-curving happy arcs with delicate lashes, brows relaxed, and a small gentle CLOSED-MOUTH smile. Light warm blush on her cheeks. This should read as calm satisfaction after the server is working. Both eyelids unmistakably closed, not the original open-eyed grin. No open mouth, no wink.
Invariants: keep the same character identity, face shape, orange hair and side braid, miniature Minecraft grass-block hairclip, orange jacket, cream overall dress, opaque brown leggings, brown boots, bag, exact full-body action pose, hands, existing props, framing, image size, color palette, clean anime linework and soft cel-shading. Do not alter the body, add props, or change the layout.
Preserve the genuinely transparent alpha background. No backdrop, checkerboard, floor, text, speech bubbles, watermarks, logos or extra figures. The expression change must remain easy to read when the full image is shown at 144 pixels wide.
```
