# Optional expression image models

Character Expressions can download an optional model. It is off by default.
Enable it under **Image generation and cleanup**. The model files come from
Hugging Face; your images are processed on your Neconyan server and are not sent
to the model host. Quick Image Gen still uses your chosen image provider to
generate new images.

- **AI background removal** uses `skytnt/anime-seg` (ISNet), a 176 MB download.
  It can recognise interior background gaps which colour-based cleanup cannot.
  On our ARM server, a 256 × 205 image took about 22 seconds and around 1 GB RAM.
  It can remove fine details as well. Export a copy before redoing cleanup.
Only one image model runs at a time. Its worker is released after each image,
including cancellation. The server checks file sizes and SHA-256 hashes before
using downloads, and stores them under `DATA_ROOT/_cache/sprite-models`.
`extensions.models.autoDownload: false` prevents new downloads. Enabling a model
that is already installed does not download it again. A failed download or model
run leaves the previous image intact.

The normal generation background is green, with magenta available for characters
wearing green. Choose a background colour absent from the character. These colours
are removed automatically; white-background cleanup has a separate checkbox.
Separate images retain more pixels per expression than splitting a large sheet.
Generation dimensions remain controlled by Quick Image Gen and its provider.

## Model sources and licences

No weights are included in the source repository or application build.

- Anime segmentation: [SkyTNT/anime-segmentation](https://github.com/SkyTNT/anime-segmentation),
  [Apache-2.0 licence](https://github.com/SkyTNT/anime-segmentation/blob/main/LICENSE).
  ONNX weights: `skytnt/anime-seg`, revision
  `493cb60893f47441b26ec4fb9a306bce9e342982`, `isnetis.onnx`.
