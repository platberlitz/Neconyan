# Optional expression image models

Character Expressions can download two optional models. Both are off by default.
Enable them under **Image generation and cleanup**. The model files come from
Hugging Face; your images are processed on your Neconyan server and are not sent
to the model host. Quick Image Gen still uses your chosen image provider to
generate new images.

- **AI background removal** uses `skytnt/anime-seg` (ISNet), a 176 MB download.
  It can recognise interior background gaps which colour-based cleanup cannot.
  On our ARM server, a 256 × 205 image took about 22 seconds and around 1 GB RAM.
  It can remove fine details as well. Export a copy before redoing cleanup.
- **Enlarge after cleanup** uses Real-ESRGAN animevideov3, a 2.5 MB download,
  at 2x or 4x. It processes overlapping small sections, then retains the original
  transparency with smooth resizing. A 2x run on the same size image took about
  21 seconds with a measured peak of 188 MiB for the isolated test process,
  including image decoding. Larger images take longer. This sharpens existing
  detail; it cannot recover the original missing detail or repair every artefact.

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
Upscaling runs after cleanup and enlarges again each time it is applied.

## Model sources and licences

No weights are included in the source repository or application build.

- Anime segmentation: [SkyTNT/anime-segmentation](https://github.com/SkyTNT/anime-segmentation),
  [Apache-2.0 licence](https://github.com/SkyTNT/anime-segmentation/blob/main/LICENSE).
  ONNX weights: `skytnt/anime-seg`, revision
  `493cb60893f47441b26ec4fb9a306bce9e342982`, `isnetis.onnx`.
- Upscaling: [Xintao Wang / Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN),
  BSD-3-Clause. The animevideov3 weights were converted to ONNX by
  [SkillSafe](https://huggingface.co/skillsafe-ai/realesr-animevideov3), revision
  `185e9142d439d17e3fb99395600fb7d08af09de5`, `model.onnx`.
  Its model card records the upstream weight hash and conversion recipe.

### Real-ESRGAN licence notice

BSD 3-Clause License

Copyright (c) 2021, Xintao Wang
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS 'AS IS' AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN
IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
