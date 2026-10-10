# Thickness Converter

Make a laser-cut SVG for any material thickness from two versions of the same design: one for thin material and one for thick material (for example 2 mm and 6 mm).

Every shape is paired between the two files. The tool then scales each joint with the material thickness, so tabs and slots that fit in both files also fit at the new thickness.

## Use

1. Open `thickness_tool.html` in a browser. It is one offline file and needs no install.
2. Drop the thin design and the thick design into the two boxes.
   - The thickness is read from the file name (`_2mm`, `_2_5mm`, `_1_8inch`, `_1_4inch`).
   - You can also type it in.
3. Read the check panel:
   - **Error** (red): this won't work.
   - **Warning** (orange): this is probably a mistake. A common example is a joint that wasn't resized in one of the two files.
   - **Info** (blue): worth knowing, but usually fine.
4. Pick or type the new thickness and click **Make SVG**.
5. Look at the preview, then download the SVG. It is named after the new thickness, for example `box_4mm.svg`.

### Rules for the two input files

- Both files must contain the same parts, built the same way. Only the sizes that depend on the thickness should differ.
- Colours (LightBurn layers) may differ, as long as each layer has the same number of shapes in both files.
- Convert text and images to paths before loading.
- Thicknesses between the two files give the most reliable results. Outside that range the result is extrapolated, and the tool shows a warning.

### Layout

- The new SVG follows the thick file's layout.
- Parts are kept at least half the material thickness apart, never less than 2 mm. The sheet grows when that's needed.
- To nest the parts tighter and save material, load the SVG into [Deepnest](https://deepnest.io).

## Develop

The project uses Vite and vanilla TypeScript. It needs Node 22.18 or newer, because the test and build scripts run `.ts` files directly.

```bash
npm install
npm run dev      # dev server
npm run build    # type-check, build, write thickness_tool.html
```

To check a conversion, run the check script with a thin file, a thick file, their two thicknesses and the new thickness. Add a real file of the new thickness at the end to compare against it:

```bash
node test/check.ts thin.svg thick.svg 2 6 4 [reference_4mm.svg]
```
