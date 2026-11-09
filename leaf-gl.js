// WebGL2 leaf layer: every tree is one instanced quad. Tree arrays are uploaded once;
// each frame only sends the zoom transform and highlight ranges.

const LEAF_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_corner;   // unit quad, -0.5..0.5
layout(location = 1) in float a_x;       // feet east of the map origin
layout(location = 2) in float a_y;       // feet south of the map origin
layout(location = 3) in float a_shape;
layout(location = 4) in float a_color;
layout(location = 5) in float a_rotation; // 0..255 -> full turn
layout(location = 6) in float a_highlight; // 0..1 street highlight progress

uniform vec2 u_viewport;     // device px
uniform vec3 u_transform;    // k, x, y in device px
uniform float u_size;        // quad size in device px
uniform float u_solid;       // 0..1: how far tiny leaves are boosted toward full opacity
uniform float u_nColors;
uniform float u_maxLevel;    // 1x1 mip level of the leaf texture
uniform int u_rangeStart;    // highlighted instances in this draw
uniform int u_rangeEnd;
uniform int u_pass;          // 0 = dimmed trees, 1 = highlighted trees
uniform float u_dimAlpha;
uniform mediump sampler2DArray u_leaves;

out vec2 v_uv;
flat out float v_layer;
flat out float v_gain;
flat out float v_alpha;

void main() {
    bool inRange = gl_InstanceID >= u_rangeStart && gl_InstanceID < u_rangeEnd;
    float h = a_highlight;
    bool highlighted = inRange || h > 0.0;
    if (highlighted != (u_pass == 1)) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // outside the clip volume
        return;
    }

    float a = a_rotation * (6.2831853 / 256.0);
    vec2 corner = mat2(cos(a), sin(a), -sin(a), cos(a)) * (a_corner * u_size * (1.0 + 0.5 * h));
    vec2 screen = vec2(a_x, a_y) * u_transform.x + u_transform.yz + corner;
    gl_Position = vec4(screen / u_viewport * 2.0 - 1.0, 0.0, 1.0);
    gl_Position.y = -gl_Position.y;

    v_uv = a_corner + 0.5;
    v_layer = a_shape * u_nColors + a_color;
    // A leaf only covers part of its square, so a few-pixel leaf averages out pale;
    // dividing by its mean coverage keeps the zoomed-out city as saturated as solid dots.
    float coverage = textureLod(u_leaves, vec3(0.5, 0.5, v_layer), u_maxLevel).a;
    v_gain = mix(1.0, 1.0 / max(coverage, 0.05), u_solid);
    v_alpha = inRange ? 1.0 : mix(u_dimAlpha, 1.0, h);
}
`;

const LEAF_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision mediump sampler2DArray;

uniform sampler2DArray u_leaves;

in vec2 v_uv;
flat in float v_layer;
flat in float v_gain;
flat in float v_alpha;
out vec4 outColor;

void main() {
    vec4 leaf = texture(u_leaves, vec3(v_uv, v_layer));  // premultiplied
    leaf *= min(v_gain, 1.0 / max(leaf.a, 0.004));       // boost without exceeding opaque
    vec4 color = leaf * v_alpha;
    if (color.a < 0.004) discard;
    outColor = color;
}
`;

// Fullscreen triangle that draws an offscreen layer (premultiplied) at an opacity
const COMPOSITE_VERTEX_SHADER = `#version 300 es
out vec2 v_uv;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    v_uv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_layer;
uniform float u_opacity;
in vec2 v_uv;
out vec4 outColor;
void main() {
    outColor = texture(u_layer, v_uv) * u_opacity;
}
`;

// Returns null when WebGL2 isn't available, so the caller can fall back to 2D dots.
// options: { manifest, shapes, boroughs, fillLeaf, layerPx }
function createLeafRenderer(canvas, options) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true });
    if (!gl) return null;

    const { manifest, shapes, boroughs, fillLeaf } = options;
    const layerPx = options.layerPx || 128;
    const nShapes = manifest.shapes.length;
    const nColors = manifest.colors.length;

    const program = linkProgram(gl, LEAF_VERTEX_SHADER, LEAF_FRAGMENT_SHADER);
    const uniform = name => gl.getUniformLocation(program, name);
    const u = {
        viewport: uniform('u_viewport'),
        transform: uniform('u_transform'),
        size: uniform('u_size'),
        solid: uniform('u_solid'),
        nColors: uniform('u_nColors'),
        maxLevel: uniform('u_maxLevel'),
        rangeStart: uniform('u_rangeStart'),
        rangeEnd: uniform('u_rangeEnd'),
        pass: uniform('u_pass'),
        dimAlpha: uniform('u_dimAlpha'),
        leaves: uniform('u_leaves')
    };

    // ---- leaf texture array: one layer per shape x color, with mipmaps ----
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    const levels = Math.log2(layerPx) + 1;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, layerPx, layerPx, nShapes * nColors);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = layerCanvas.height = layerPx;
    const ctx = layerCanvas.getContext('2d');
    manifest.shapes.forEach((shapeName, s) => {
        const [viewBox, pathData] = shapes[shapeName];
        const [vx, vy, vw, vh] = viewBox.split(/[\s,]+/).map(Number);
        const scale = layerPx / Math.max(vw, vh);
        const leafPath = new Path2D(pathData);
        manifest.colors.forEach((colorName, c) => {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, layerPx, layerPx);
            ctx.translate((layerPx - vw * scale) / 2, (layerPx - vh * scale) / 2);
            ctx.scale(scale, scale);
            ctx.translate(-vx, -vy);
            fillLeaf(ctx, leafPath, string_color[colorName] || ['#787878'], vx, vy, vw, vh);
            gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, s * nColors + c,
                layerPx, layerPx, 1, gl.RGBA, gl.UNSIGNED_BYTE, layerCanvas);
        });
    });
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ---- geometry: one shared quad, per-borough instance buffers ----
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);

    const instanceAttrib = (location, data, type) => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 1, type, false, 0, 0);
        gl.vertexAttribDivisor(location, 1);
    };

    const layers = boroughs.map(b => {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        const rotation = new Uint8Array(b.n);
        for (let i = 0; i < b.n; i++) rotation[i] = Math.imul(i + b.code * 7919, 2654435761) >>> 24;

        instanceAttrib(1, b.trees.x, gl.UNSIGNED_INT);
        instanceAttrib(2, b.trees.y, gl.UNSIGNED_INT);
        instanceAttrib(3, b.trees.shape, gl.UNSIGNED_BYTE);
        instanceAttrib(4, b.trees.color, gl.UNSIGNED_BYTE);
        instanceAttrib(5, rotation, gl.UNSIGNED_BYTE);

        const highlight = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, highlight);
        gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(b.n), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(6);
        gl.vertexAttribPointer(6, 1, gl.UNSIGNED_BYTE, true, 0, 0);
        gl.vertexAttribDivisor(6, 1);

        gl.bindVertexArray(null);
        return { vao, n: b.n, highlight };
    });

    // Writes highlight bytes (0..255) for trees [start, start + bytes.length) of one borough
    function setHighlight(boroIdx, start, bytes) {
        gl.bindBuffer(gl.ARRAY_BUFFER, layers[boroIdx].highlight);
        gl.bufferSubData(gl.ARRAY_BUFFER, start, bytes);
    }

    // ---- constant state ----
    gl.useProgram(program);
    gl.uniform1f(u.nColors, nColors);
    gl.uniform1f(u.maxLevel, levels - 1);
    gl.uniform1i(u.leaves, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    // ---- dimmed layer: drawn at full strength offscreen, then faded as a whole ----
    // Fading each leaf instead would let hundreds of overlapping tiny leaves add back up
    // to nearly opaque when zoomed out.
    const compositeProgram = linkProgram(gl, COMPOSITE_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER);
    const uComposite = {
        layer: gl.getUniformLocation(compositeProgram, 'u_layer'),
        opacity: gl.getUniformLocation(compositeProgram, 'u_opacity')
    };
    const compositeVao = gl.createVertexArray();
    const dimTexture = gl.createTexture();
    const dimFramebuffer = gl.createFramebuffer();

    function resize() {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.bindTexture(gl.TEXTURE_2D, dimTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, dimFramebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dimTexture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    resize();

    function drawPass(state, pass) {
        gl.uniform1i(u.pass, pass);
        layers.forEach((layer, i) => {
            const [start, end] = state.ranges[i];
            const highlightedCount = end - start;
            if (pass === 0 && highlightedCount === layer.n) return;
            if (pass === 1 && highlightedCount === 0 && !state.streetBoroughs.has(i)) return;
            gl.uniform1i(u.rangeStart, start);
            gl.uniform1i(u.rangeEnd, end);
            gl.bindVertexArray(layer.vao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layer.n);
        });
        gl.bindVertexArray(null);
    }

    // state: { k, x, y (device px), size (device px), solid (0..1), dimAlpha,
    //          ranges: [[start, end], ...] highlighted instances per borough,
    //          streetBoroughs: Set of borough indices with highlighted streets }
    function draw(state) {
        const anyDimmed = layers.some((layer, i) => state.ranges[i][1] - state.ranges[i][0] < layer.n);

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        gl.uniform2f(u.viewport, canvas.width, canvas.height);
        gl.uniform3f(u.transform, state.k, state.x, state.y);
        gl.uniform1f(u.size, state.size);
        gl.uniform1f(u.solid, state.solid);

        if (anyDimmed) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, dimFramebuffer);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform1f(u.dimAlpha, 1);
            drawPass(state, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }

        gl.clear(gl.COLOR_BUFFER_BIT);
        if (anyDimmed) {
            gl.useProgram(compositeProgram);
            gl.bindTexture(gl.TEXTURE_2D, dimTexture);
            gl.uniform1i(uComposite.layer, 0);
            gl.uniform1f(uComposite.opacity, state.dimAlpha);
            gl.bindVertexArray(compositeVao);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.bindVertexArray(null);
            gl.useProgram(program);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        }

        // highlighted trees on top of the faded layer
        gl.uniform1f(u.dimAlpha, state.dimAlpha);
        drawPass(state, 1);
    }

    return { resize, draw, setHighlight, gl };
}

function linkProgram(gl, vertexSource, fragmentSource) {
    const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader));
        }
        return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program));
    }
    return program;
}
