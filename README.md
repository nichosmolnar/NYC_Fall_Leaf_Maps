## Autumn Leaves of New York

Visualization of NYC autumn leaf colors and shapes, built from the 2015 NYC Street Tree Census.

## Todo:

- fix the street name lookup (currently a json datalist fed into a input box) which is not nuanced enough to catch things like "east" meaning "e", etc
- update readme to remove features that are no longer included
- figure out if this should be hosted in a new repo, or pull request the old one (but then the old one would be lost!)

- **Street view:** type in a street to see which leaves you'd find on the ground there.
- **City map:** a zoomable, top-down map of NYC. Each of the ~650,000 living street trees is drawn at its real location as its species' leaf, in its fall color, on a light background with faint street centerlines. You can highlight individual boroughs, or pick a street to zoom to it and highlight its trees.

### How it works

Each tree species in the census is matched to a leaf shape (`shapes.json`) and a fall color (`string_color` in the JS). The data is prepared ahead of time in Python, so the browser only loads small, ready-to-draw files:

1. `tree_map_export.py` (in the companion `Tree_Leaf_Project` repo) reads the raw census CSV. It keeps only living trees and their species, state plane coordinates, borough, and address. It then cleans up street names (shared with `tree_to_street.ipynb` through `street_names.py`) and looks up each species' leaf shape and color.
2. Tree positions are stored as compact binary files (`data/trees_{borough}.bin`), about 12 bytes per tree. Positions use NY State Plane coordinates (in feet), which are flat and accurate for NYC, so no map projection or tile library is needed.
3. Street centerlines come from the NYC Open Data Centerline (CSCL) dataset. They're reprojected, simplified, and saved as `data/streets_{borough}.bin`. Borough outlines are saved as a small GeoJSON.
4. `data/manifest.json` holds the shape, color, and street name lookups, plus bounding boxes used to zoom to a borough or street.
5. In the browser, street lines are drawn on a 2D `<canvas>`, and the leaves are drawn on a second canvas with WebGL (`leaf-gl.js`). The tree data is sent to the graphics card once, so all ~650,000 leaves redraw in a single batch as you pan and zoom with d3-zoom. Every tree is drawn as its rotated leaf shape at every zoom; when leaves are only a few pixels wide they are drawn fully opaque so the zoomed-out city stays saturated. Browsers without WebGL2 fall back to colored dots. All map colors and sizes are set in one `MAP_STYLE` object.

### Files

- `index.html`, `styles.css`: page layout
- `colors.js`: leaf color table shared by the grid and the map
- `main.js`: street search and per-street leaf grid
- `map.js`: map loading, zoom, street layer, and borough and street highlighting; colors and sizes are in `MAP_STYLE` at the top
- `leaf-gl.js`: WebGL leaf renderer (shaders, leaf texture, per-borough tree buffers)
- `shapes.json`: SVG paths for each leaf shape
- `street_color_shapes.json`: leaf shape and color counts per street
- `data/`: generated map data (output of `tree_map_export.py`, not edited by hand)

### Regenerating the map data

```bash
cd Tree_Leaf_Project
pip install pandas numpy geopandas
python tree_map_export.py
```

The first run downloads the street centerlines and borough boundaries into `Data/NYC_rawdata/` (about 40 MB) and reuses them afterwards. Delete those two `.geojson` files to fetch fresh copies.

### Running locally

The map loads its data with `fetch`, so open the site through a local server rather than as a file:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

### Data sources

- [2015 Street Tree Census - Tree Data](https://data.cityofnewyork.us/Environment/2015-Street-Tree-Census-Tree-Data/uvpi-gqnh) (NYC Open Data)
- [Centerline (CSCL)](https://data.cityofnewyork.us/d/inkn-q76z) (NYC Open Data)
- [Borough Boundaries](https://data.cityofnewyork.us/d/gthc-hcne) (NYC Open Data)
