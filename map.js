// Top-down map of every NYC street tree, drawn as its fall leaf.
// Data comes from data/ (built by tree_map_export.py). Coordinates are feet in
// NY State Plane, shifted so x grows east and y grows south (canvas orientation).

const MAP_STYLE = {
    background: '#f7f7f5',      // near-white paper
    street: '#e2e2de',          // hairline centerlines, barely visible
    streetWidthPx: 0.5,         // scaled up gently with zoom
    boroughOutline: '#cfcfcb',
    selectedStreet: '#9a9a94',  // selected street, still neutral gray
    dimmedLeafAlpha: 0.15,      // non-selected boroughs and streets
    dimmedStreetAlpha: 0.4,
    leafFeet: 55,               // leaf shape size on the ground, in feet
    minLeafPx: 1.6,             // leaves never shrink below this on screen
    maxLeafPx: 90,
    solidLeafPx: [2, 6]         // leaf sizes over which tiny leaves go from fully opaque to true shape
};

const LeafMap = (() => {
    const MAX_ZOOM = 1.6;           // screen px per foot; keep leafFeet * MAX_ZOOM near maxLeafPx
    const STREET_MIN_SPAN_FT = 800; // zoom-to-street never gets closer than this

    const container = document.getElementById('map');
    const streetCanvas = document.getElementById('street-canvas');
    let leafCanvas = document.getElementById('leaf-canvas');
    const status = document.getElementById('map-status');
    const streetCtx = streetCanvas.getContext('2d');
    let renderer = null;    // WebGL2 leaf renderer (leaf-gl.js)
    let leafCtx = null;     // 2D fallback when WebGL2 isn't available

    let manifest = null;
    let streetIndex = new Map();
    let boroughs = [];
    let dotFull, dotDim;
    let dotImage = null;

    let width = 0, height = 0, dpr = 1;
    let fitK = 1;
    let transform = d3.zoomIdentity;
    let frame = null;

    const selectedBoroughs = new Set();  // empty = all boroughs active
    let selectedStreet = -1;
    let selectedStreetPath = null;

    const api = { onStreetCleared: null };

    const zoom = d3.zoom().on('zoom', event => {
        transform = event.transform;
        scheduleDraw();
    });

    api.ready = load().catch(error => {
        console.error('Error loading map data:', error);
        status.textContent = 'Could not load map data.';
    });

    // ---------- loading ----------

    async function load() {
        const [m, shapes, outlines] = await Promise.all([
            d3.json('data/manifest.json'),
            d3.json('shapes.json'),
            d3.json('data/boroughs.json')
        ]);
        manifest = m;
        manifest.streets.forEach((s, i) => streetIndex.set(s[0], i));

        [dotFull, dotDim] = buildDotPalettes();
        boroughs = await Promise.all(manifest.boroughs.map(loadBorough));

        try {
            renderer = createLeafRenderer(leafCanvas, { manifest, shapes, boroughs, fillLeaf });
        } catch (error) {
            console.error('WebGL leaf renderer failed, falling back to dots:', error);
        }
        if (!renderer) {
            // a canvas that already has a WebGL context can't hand out a 2D one
            const fresh = leafCanvas.cloneNode();
            leafCanvas.replaceWith(fresh);
            leafCanvas = fresh;
            leafCtx = leafCanvas.getContext('2d');
        }

        for (const feature of outlines.features) {
            const b = boroughs.find(b => b.code === feature.properties.code);
            if (b) b.outline = linesToPath(feature.geometry.coordinates);
        }

        buildBoroughToggles();
        resize();
        d3.select(leafCanvas).call(zoom).call(zoom.transform, boxTransform(manifest.bbox));
        window.addEventListener('resize', onResize);
        status.hidden = true;
    }

    async function loadBorough(info) {
        const [treeBuf, streetBuf] = await Promise.all([
            fetch(`data/${info.trees}`).then(r => r.arrayBuffer()),
            fetch(`data/${info.streets}`).then(r => r.arrayBuffer())
        ]);

        // tree blocks: x[n] u32, y[n] u32, streetId[n] u16, shape[n] u8, color[n] u8
        const n = info.treeCount;
        const trees = {
            x: new Uint32Array(treeBuf, 0, n),
            y: new Uint32Array(treeBuf, 4 * n, n),
            street: new Uint16Array(treeBuf, 8 * n, n),
            shape: new Uint8Array(treeBuf, 10 * n, n),
            color: new Uint8Array(treeBuf, 11 * n, n)
        };

        // street blocks: xy[2v] u32, offsets[m+1] u32, streetId[m] u16
        const v = info.streetVertexCount, m = info.streetPathCount;
        const lines = {
            xy: new Uint32Array(streetBuf, 0, 2 * v),
            offsets: new Uint32Array(streetBuf, 8 * v, m + 1),
            street: new Uint16Array(streetBuf, 8 * v + 4 * (m + 1), m)
        };

        return { ...info, n, trees, lines, streetPath: polylinesToPath(lines, () => true) };
    }

    function polylinesToPath(lines, keep) {
        const path = new Path2D();
        const { xy, offsets, street } = lines;
        for (let p = 0; p < street.length; p++) {
            if (!keep(street[p])) continue;
            const start = offsets[p], end = offsets[p + 1];
            path.moveTo(xy[2 * start], xy[2 * start + 1]);
            for (let i = start + 1; i < end; i++) path.lineTo(xy[2 * i], xy[2 * i + 1]);
        }
        return path;
    }

    function linesToPath(rings) {
        const path = new Path2D();
        for (const ring of rings) {
            path.moveTo(ring[0][0], ring[0][1]);
            for (let i = 1; i < ring.length; i++) path.lineTo(ring[i][0], ring[i][1]);
        }
        return path;
    }

    function fillLeaf(ctx, leafPath, colors, vx, vy, vw, vh) {
        if (colors.length > 1) {
            const gradient = ctx.createLinearGradient(vx, vy, vx + vw, vy + vh);
            colors.forEach((c, i) => gradient.addColorStop(i / (colors.length - 1), c));
            ctx.fillStyle = gradient;
        } else {
            ctx.fillStyle = colors[0];
        }
        ctx.fill(leafPath);
    }

    // 2D fallback dots use the middle of each leaf's gradient, as packed little-endian RGBA
    function buildDotPalettes() {
        const pack = (c, alpha) => ((Math.round(alpha * 255) << 24) | (c.b << 16) | (c.g << 8) | c.r) >>> 0;
        const full = new Uint32Array(manifest.colors.length);
        const dim = new Uint32Array(manifest.colors.length);
        manifest.colors.forEach((name, i) => {
            const colors = string_color[name] || ['#787878'];
            const mid = d3.rgb(colors.length > 1 ? d3.piecewise(d3.interpolateRgb, colors)(0.5) : colors[0]);
            full[i] = pack(mid, 1);
            dim[i] = pack(mid, MAP_STYLE.dimmedLeafAlpha);
        });
        return [full, dim];
    }

    // ---------- view ----------

    function resize() {
        const rect = container.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
        dpr = window.devicePixelRatio || 1;
        for (const canvas of [streetCanvas, leafCanvas]) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        dotImage = null;
        if (renderer) renderer.resize();

        const [x0, y0, x1, y1] = manifest.bbox;
        fitK = 0.95 * Math.min(width / (x1 - x0), height / (y1 - y0));
        // d3 recenters (ignoring the cursor) whenever the pan extent is smaller than the
        // viewport, so the extent must cover the whole viewport even at the minimum zoom
        const minK = fitK * 0.8;
        const pad = 20000;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const halfW = Math.max((x1 - x0) / 2 + pad, width / minK / 2);
        const halfH = Math.max((y1 - y0) / 2 + pad, height / minK / 2);
        zoom.scaleExtent([minK, MAX_ZOOM])
            .translateExtent([[cx - halfW, cy - halfH], [cx + halfW, cy + halfH]]);
    }

    // Keep the same point of the city in the middle of the map
    function onResize() {
        const center = transform.invert([width / 2, height / 2]);
        resize();
        const t = d3.zoomIdentity
            .translate(width / 2 - transform.k * center[0], height / 2 - transform.k * center[1])
            .scale(transform.k);
        d3.select(leafCanvas).call(zoom.transform, t);
    }

    function boxTransform([x0, y0, x1, y1], minSpan = 0) {
        const w = Math.max(x1 - x0, minSpan);
        const h = Math.max(y1 - y0, minSpan);
        const k = Math.min(MAX_ZOOM, 0.9 * Math.min(width / w, height / h));
        return d3.zoomIdentity
            .translate(width / 2 - k * (x0 + x1) / 2, height / 2 - k * (y0 + y1) / 2)
            .scale(k);
    }

    function zoomTo(bbox, minSpan) {
        d3.select(leafCanvas).transition().duration(750)
            .call(zoom.transform, boxTransform(bbox, minSpan));
    }

    function scheduleDraw() {
        if (frame === null) frame = requestAnimationFrame(draw);
    }

    function draw() {
        frame = null;
        drawStreets();
        drawLeaves();
    }

    const boroughActive = b => selectedBoroughs.size === 0 || selectedBoroughs.has(b.code);

    function drawStreets() {
        const ctx = streetCtx;
        const k = transform.k;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = MAP_STYLE.background;
        ctx.fillRect(0, 0, streetCanvas.width, streetCanvas.height);

        ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * transform.x, dpr * transform.y);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        const streetPx = MAP_STYLE.streetWidthPx * Math.min(6, Math.max(1, Math.pow(k / fitK, 0.4)));
        ctx.lineWidth = streetPx / k;
        ctx.strokeStyle = MAP_STYLE.street;
        for (const b of boroughs) {
            ctx.globalAlpha = boroughActive(b) ? 1 : MAP_STYLE.dimmedStreetAlpha;
            ctx.stroke(b.streetPath);
        }

        ctx.globalAlpha = 1;
        ctx.lineWidth = 1 / k;
        ctx.strokeStyle = MAP_STYLE.boroughOutline;
        for (const b of boroughs) if (b.outline) ctx.stroke(b.outline);

        if (selectedStreetPath) {
            ctx.lineWidth = Math.max(1.5, streetPx * 1.5) / k;
            ctx.strokeStyle = MAP_STYLE.selectedStreet;
            ctx.stroke(selectedStreetPath);
        }
    }

    // Calls fn(borough, start, end, dimmed) for every tree range, dimmed ranges first
    function forEachRange(fn) {
        if (selectedStreet >= 0) {
            const [, boroIdx, start, count] = manifest.streets[selectedStreet];
            boroughs.forEach((b, i) => {
                if (i !== boroIdx) fn(b, 0, b.n, true);
                else {
                    fn(b, 0, start, true);
                    fn(b, start + count, b.n, true);
                }
            });
            fn(boroughs[boroIdx], start, start + count, false);
            return;
        }
        for (const b of boroughs) if (!boroughActive(b)) fn(b, 0, b.n, true);
        for (const b of boroughs) if (boroughActive(b)) fn(b, 0, b.n, false);
    }

    const dotDevicePx = leafPx => Math.max(1, Math.round(Math.max(1, leafPx * 0.6) * dpr));

    function drawLeaves() {
        const leafPx = Math.min(MAP_STYLE.maxLeafPx, MAP_STYLE.leafFeet * transform.k);
        if (!renderer) return drawDots(leafPx);

        const [lo, hi] = MAP_STYLE.solidLeafPx;
        const t = Math.min(1, Math.max(0, (leafPx - lo) / (hi - lo)));
        renderer.draw({
            k: transform.k * dpr,
            x: transform.x * dpr,
            y: transform.y * dpr,
            size: Math.max(MAP_STYLE.minLeafPx, leafPx) * dpr,
            solid: 1 - t * t * (3 - 2 * t),
            dimAlpha: MAP_STYLE.dimmedLeafAlpha,
            ranges: highlightRanges()
        });
    }

    // Per borough, the [start, end) slice of trees drawn at full strength
    function highlightRanges() {
        if (selectedStreet >= 0) {
            const [, boroIdx, start, count] = manifest.streets[selectedStreet];
            return boroughs.map((b, i) => (i === boroIdx ? [start, start + count] : [0, 0]));
        }
        return boroughs.map(b => (boroughActive(b) ? [0, b.n] : [0, 0]));
    }

    // 2D fallback: every tree is a dot at every zoom
    function drawDots(leafPx) {
        const W = leafCanvas.width, H = leafCanvas.height;
        if (!dotImage) dotImage = leafCtx.createImageData(W, H);
        const pixels = new Uint32Array(dotImage.data.buffer);
        pixels.fill(0);

        const size = Math.min(dotDevicePx(leafPx), 6 * dpr);
        const half = size >> 1;
        const k = transform.k * dpr, tx = transform.x * dpr, ty = transform.y * dpr;

        forEachRange((b, start, end, dimmed) => {
            const palette = dimmed ? dotDim : dotFull;
            const { x, y, color } = b.trees;
            for (let i = start; i < end; i++) {
                const px = ((tx + k * x[i]) | 0) - half;
                const py = ((ty + k * y[i]) | 0) - half;
                if (px < 0 || py < 0 || px + size > W || py + size > H) continue;
                const c = palette[color[i]];
                for (let dy = 0; dy < size; dy++) {
                    const row = (py + dy) * W + px;
                    for (let dx = 0; dx < size; dx++) pixels[row + dx] = c;
                }
            }
        });
        leafCtx.putImageData(dotImage, 0, 0);
    }

    // ---------- highlighting ----------

    function buildBoroughToggles() {
        const holder = d3.select('#borough-toggles');
        holder.selectAll('button')
            .data(boroughs)
            .join('button')
            .attr('class', 'borough-toggle')
            .text(b => b.name)
            .on('click', (event, b) => toggleBorough(b.code));

        d3.select('#reset-view').on('click', resetView);
    }

    function updateToggles() {
        d3.selectAll('.borough-toggle').classed('active', b => selectedBoroughs.has(b.code));
    }

    function toggleBorough(code) {
        if (selectedBoroughs.has(code)) selectedBoroughs.delete(code);
        else selectedBoroughs.add(code);
        updateToggles();
        clearStreet(true);

        const active = boroughs.filter(boroughActive);
        const bbox = [
            d3.min(active, b => b.bbox[0]), d3.min(active, b => b.bbox[1]),
            d3.max(active, b => b.bbox[2]), d3.max(active, b => b.bbox[3])
        ];
        zoomTo(bbox);
    }

    async function selectStreet(name) {
        await api.ready;
        const id = streetIndex.get(name);
        if (id === undefined) return clearStreet();
        if (id === selectedStreet) return;

        const [, boroIdx, , , x0, y0, x1, y1] = manifest.streets[id];
        selectedStreet = id;
        selectedStreetPath = polylinesToPath(boroughs[boroIdx].lines, s => s === id);
        zoomTo([x0, y0, x1, y1], STREET_MIN_SPAN_FT);
    }

    function clearStreet(notify = false) {
        if (selectedStreet < 0) return;
        selectedStreet = -1;
        selectedStreetPath = null;
        scheduleDraw();
        if (notify && api.onStreetCleared) api.onStreetCleared();
    }

    function resetView() {
        selectedBoroughs.clear();
        updateToggles();
        clearStreet(true);
        zoomTo(manifest.bbox);
    }

    api.selectStreet = selectStreet;
    api.clearStreet = () => clearStreet();
    api.resetView = resetView;
    return api;
})();
