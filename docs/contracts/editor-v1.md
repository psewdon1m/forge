# Editor Plain

Add **Editor** from Space. In **Links**, connect an image file or Gallery to the Editor's `images` input and select an image version. Editor works with project-managed PNG, JPEG and WebP. The input name and version are shown in the graph. Crop, Resize, Exposure and Color adjustment nodes run in the shown order. Use **Move up**, **Move down** and **Remove node** to change the path. Input can also connect directly to the preview and output.

Choose **Render preview** to render the current draft. The preview shows the full output dimensions and a scaled image. **Cancel preview** keeps the last completed preview. **Save recipe** records the input version and parameters in the project. **Discard recipe changes** restores the saved graph. A draft is checked before leaving the panel.

Choose an output name and PNG or JPEG, then **Export image**. The confirmation names the new project file and defaults to Cancel. Export makes a new asset card in Space. PNG preserves alpha. JPEG uses quality 90 and composites transparency on white. **Repeat export** uses the recorded input, graph and output format of that export. The current output name is used for the new card.

## Graph and processing

Editor v1 stores one path with at most 12 processing nodes. An input reference of `null` means the pinned input image. Each processing node has a UUID and one input reference. The output references the last node or `null` for a direct copy. Core follows the output back to the input, rejects cycles and requires every processing node to be on that path.

The input accepts up to 48 MiB. Input and intermediate images allow up to 8192 pixels on either edge and 12 million total pixels. Core checks dimensions before decode, applies the decoded EXIF orientation and edits the resulting 8-bit RGBA samples. Crop uses integer pixel coordinates and must fit its incoming image. Resize uses fixed-point bilinear interpolation with premultiplied alpha. Exposure applies a gain of 2 to the power of the entered EV, in quarter stops from -4 to +4. The color node applies a gain from 0 to 200 percent independently to red, green and blue. Gains round and clamp to the byte range. Encoded outputs contain the edited pixels in the selected format.

## Versions and recovery

A new input pick is checked against its live Data Link, collection revision and version. A saved recipe retains its managed input version and SHA-256. Later replacements in Space affect new picks. Core verifies the saved bytes every time it renders the recipe. The original file remains available through the project's version history.

Preview is local and read-only. Core checks cancellation while reading the file, processing rows or pixels and before it publishes a preview. Export stages the image through the managed asset store. The export card, recipe receipt and project revision commit together. A duplicate operation ID with an identical request returns the committed result. Project ZIPs carry the pinned input, output files, current recipe and up to 32 recent export receipts. Earlier project revisions retain their receipts.

Run `node tests/editor-desktop.mjs` with a built Windows Core and renderer. The fixture checks graph validation, expected pixels, cancel, explicit export confirmation, deterministic repeat after source replacement and ZIP restore.
