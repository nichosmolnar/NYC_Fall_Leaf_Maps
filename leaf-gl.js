// WebGL2 leaf layer: every tree is one instanced quad. Tree arrays are uploaded once;
// each frame only sends the zoom transform and highlight ranges.

const LEAF_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_corner;   // unit quad, -0.5..0.5
layout(location = 1) in float a_x;       // feet east of the map origin
layout(location = 2) in float a_y;       // feet south of the map origin
layout(location = 3) in float a_shape;
layout(location = 4) in float a_color;
layout(location = 5) in float a_rotation; // 0..255 -> full turn

uniform vec2 u_viewport;     // device px
uniform vec3 u_transform;    // k, x, y in device px
uniform float u_size;        // quad size in device px
uniform float u_blend;       // 0 = dot, 1 = leaf
uniform float u_nColors;
uniform int u_rangeStart;    // highlighted instances in this draw
uniform int u_rangeEnd;
uniform int u_pass;          // 0 = dimmed trees, 1 = highlighted trees
uniform float u_dimAlpha;
uniform vec3 u_dotColors[32];

out vec2 v_uv;
flat out float v_layer;
flat out vec3 v_dotColor;
flat out float v_alpha;

void main() {
    bool highlighted = gl_InstanceID >= u_rangeStart && gl_InstanceID < u_rangeEnd;
    if (highlighted != (u_pass == 1)) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // outside the clip volume
        return;
    }

    vec2 corner = a_corner * u_size;
    if (u_blend > 0.0) {
        float a = a_rotation * (6.2831853 / 256.0);
        corner = mat2(cos(a), sin(a), -sin(a), cos(a)) * corner;
    }
    vec2 screen = vec2(a_x, a_y) * u_transform.x + u_transform.yz + corner;
    gl_Position = vec4(screen / u_viewport * 2.0 - 1.0, 0.0, 1.0);
    gl_Position.y = -gl_Position.y;

    v_uv = a_corner + 0.5;
    v_layer = a_shape * u_nColors + a_color;
    v_dotColor = u_dotColors[int(a_color)];
    v_alpha = highlighted ? 1.0 : u_dimAlpha;
}
`;

const LEAF_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision mediump sampler2DArray;

uniform sampler2DArray u_leaves;
uniform float u_blend;

in vec2 v_uv;
flat in float v_layer;
flat in vec3 v_dotColor;
flat in float v_alpha;
out vec4 outColor;

void main() {
    vec4 leaf = texture(u_leaves, vec3(v_uv, v_layer));  // premultiplied
    vec4 color = mix(vec4(v_dotColor, 1.0), leaf, u_blend) * v_alpha;
    if (color.a < 0.004) discard;
    outColor = color;
}
`;

// Returns null when WebGL2 isn't available, so the caller can fall back to 2D dots.
// options: { manifest, shapes, boroughs, dotColors: [[r,g,b] 0..1], fillLeaf, layerPx }
function createLeafRenderer(canvas, options) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true });
    if (!gl) return null;

    const { manifest, shapes, boroughs, dotColors, fillLeaf } = options;
    const layerPx = options.layerPx || 128;
    const nShapes = manifest.shapes.length;
    const nColors = manifest.colors.length;

    const program = linkProgram(gl, LEAF_VERTEX_SHADER, LEAF_FRAGMENT_SHADER);
    const uniform = name => gl.getUniformLocation(program, name);
    const u = {
        viewport: uniform('u_viewport'),
        transform: uniform('u_transform'),
        size: uniform('u_size'),
        blend: uniform('u_blend'),
        nColors: uniform('u_nColors'),
        rangeStart: uniform('u_rangeStart'),
        rangeEnd: uniform('u_rangeEnd'),
        pass: uniform('u_pass'),
        dimAlpha: uniform('u_dimAlpha'),
        dotColors: uniform('u_dotColors'),
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
        gl.bindVertexArray(null);
        return { vao, n: b.n };
    });

    // ---- constant state ----
    gl.useProgram(program);
    gl.uniform1f(u.nColors, nColors);
    gl.uniform3fv(u.dotColors, new Float32Array(dotColors.flat()));
    gl.uniform1i(u.leaves, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    function resize() {
        gl.viewport(0, 0, canvas.width, canvas.height);
    }

    // state: { k, x, y (device px), size (device px), blend (0..1), dimAlpha,
    //          ranges: [[start, end], ...] highlighted instances per borough }
    function draw(state) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        gl.uniform2f(u.viewport, canvas.width, canvas.height);
        gl.uniform3f(u.transform, state.k, state.x, state.y);
        gl.uniform1f(u.size, state.size);
        gl.uniform1f(u.blend, state.blend);
        gl.uniform1f(u.dimAlpha, state.dimAlpha);

        // dimmed trees first, so highlighted leaves sit on top
        for (const pass of [0, 1]) {
            gl.uniform1i(u.pass, pass);
            layers.forEach((layer, i) => {
                const [start, end] = state.ranges[i];
                const highlightedCount = end - start;
                if (pass === 0 && highlightedCount === layer.n) return;
                if (pass === 1 && highlightedCount === 0) return;
                gl.uniform1i(u.rangeStart, start);
                gl.uniform1i(u.rangeEnd, end);
                gl.bindVertexArray(layer.vao);
                gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layer.n);
            });
        }
        gl.bindVertexArray(null);
    }

    return { resize, draw, gl };
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
