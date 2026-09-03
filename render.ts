/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018, 2025 Red Blob Games <redblobgames@gmail.com>
 * @license Apache-2.0 <https://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * This module uses webgl to render the generated maps
 */

import {vec2, vec4, mat4} from 'gl-matrix';
import colormap from "./colormap.ts";
import Geometry from "./geometry.ts";
import {NUM_COUNTRIES, countryPalette} from "./countries.ts";
import {NUM_CITY_ZONES, cityPalette as cityColors} from "./city.ts";
import {NUM_TERRAINS, terrainPalette as terrainColors} from "./terrains.ts";
import type {Mesh} from "./types.d.ts";

//////////////////////////////////////////////////////////////////////
// WebGL wrappers

type Buffer = {
    bind(): void;
    vertexAttribPointer(index: GLuint, size: GLint, type: GLenum, normalized: GLboolean, stride: GLsizei, offset: GLintptr): void;
    subdata(offset: number, data: AllowSharedBufferSource): void;
}

type Program = {
    run(body: () => void): void;
    [name: `a_${string}`]: GLint;
    [name: `u_${string}`]: WebGLUniformLocation;
}

type Texture = {
    id: WebGLTexture;
    width: number;
    height: number;
    bind(): void;
    activate(register: GLint, uniform: WebGLUniformLocation): void;
}

type Framebuffer = {
    id: WebGLFramebuffer;
    texture: Texture | null;
    depth: boolean;
    bind(): void;
    viewport(): void;
    clear(r: number, g: number, b: number, a: number): void;
}

class WebGLWrapper {
    gl: WebGL2RenderingContext;

    constructor (canvas: HTMLCanvasElement) {
        this.gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
        if (!this.gl) { alert("This project requires WebGL 2."); return; }
        canvas.addEventListener('webglcontextlost', () => console.error("This project not handle WebGL context loss"));
        const ext_color_buffer_float = this.gl.getExtension('EXT_color_buffer_float'); // 99.93% support
        if (!ext_color_buffer_float) { alert("This project requires WebGL2 EXT_color_buffer_float"); }
    }

    createBuffer(options: {indices?: boolean, update: 'static' | 'dynamic', data: AllowSharedBufferSource}): Buffer {
        const {gl} = this;
        const target = options.indices ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
        const buffer = gl.createBuffer();
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, options.data, options.update === 'static'? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
        return {
            bind() {
                gl.bindBuffer(target, buffer);
            },
            vertexAttribPointer(index, size, type, normalized, stride, offset) {
                this.bind();
                gl.enableVertexAttribArray(index);
                gl.vertexAttribPointer(index, size, type, normalized, stride, offset);
            },
            subdata(offset: number, data: AllowSharedBufferSource) {
                this.bind();
                gl.bufferSubData(target, offset, data);
            },
        };
    }

    createTexture(options: {width?: number, height?: number, mipmap?: boolean, image?: HTMLCanvasElement, data?: Uint8Array, internalFormat?: GLenum, format?: GLenum, filter: 'linear'|'nearest'}): Texture {
        const {gl} = this;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);

        if (options.image) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, options.image);
        } else if (options.width && options.height) {
            gl.texStorage2D(gl.TEXTURE_2D, 1, options.internalFormat ?? gl.RGBA8, options.width, options.height);
            if (options.data) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, options.width, options.height, options.format ?? gl.RGBA, gl.UNSIGNED_BYTE, options.data);
            }
        } else {
            throw "createTexture needs either an image or a width✕height";
        }

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.filter === 'linear'? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, options.filter === 'linear'? gl.LINEAR : gl.NEAREST);
        if (options.mipmap) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.filter === 'linear'? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST);
            gl.generateMipmap(gl.TEXTURE_2D);
        }

        gl.bindTexture(gl.TEXTURE_2D, null);
        return {
            id: texture,
            width: options.width ?? options.image.width,
            height: options.height ?? options.image.height,
            bind() {
                gl.bindTexture(gl.TEXTURE_2D, texture);
            },
            activate(register: GLint, uniform: WebGLUniformLocation) {
                if (register < gl.TEXTURE0 || register >= gl.TEXTURE7) throw "invalid texture register";
                gl.uniform1i(uniform, register - gl.TEXTURE0);
                gl.activeTexture(register);
                this.bind();
            }
        };
    }

    _createFramebufferWrapper(framebuffer: WebGLFramebuffer | null, texture: Texture | null, depth: boolean): Framebuffer {
        const {gl} = this;
        return {
            id: framebuffer,
            texture,
            depth,
            bind() {
                gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            },
            viewport() {
                this.bind();
                const image = this.texture ?? gl.canvas;
                gl.viewport(0, 0, image.width, image.height);
            },
            clear(r, g, b, a) {
                this.bind();
                gl.clearColor(r, g, b, a);
                gl.clear(gl.COLOR_BUFFER_BIT | (this.depth? gl.DEPTH_BUFFER_BIT : 0));
            },
        };
    }

    drawToScreen(): Framebuffer {
        return this._createFramebufferWrapper(null, null, true);
    }

    createFramebuffer(width: number, height: number, options: {depth?: boolean, internalFormat?: GLenum, format?: GLenum, filter: 'linear'|'nearest'}): Framebuffer {
        const {gl} = this;
        const texture = this.createTexture({width, height, internalFormat: options.internalFormat, format: options.format, filter: options.filter});
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.id, 0);

        if (options.depth) {
            const depthBuffer = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, texture.width, texture.height);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        }

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.error("Framebuffer is not complete:", status.toString(16));
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return this._createFramebufferWrapper(framebuffer, texture, options.depth ?? false);
    }

    createProgram(name: string, vert: string, frag: string, setup: (gl: WebGL2RenderingContext, program: Program) => void): Program {
        const {gl} = this;

        function createShader(type, source): WebGLShader {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, "#version 300 es\n" + source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error(`Error compiling shader for program ${name}`);
                console.error(gl.getShaderInfoLog(shader));
            }
            return shader;
        }

        const vs = createShader(gl.VERTEX_SHADER, vert);
        const fs = createShader(gl.FRAGMENT_SHADER, frag);
        const pr = gl.createProgram();
        gl.attachShader(pr, vs);
        gl.attachShader(pr, fs);
        gl.linkProgram(pr);

        if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
            console.error(`Error linking shaders for program ${name}`);
            console.error(gl.getProgramInfoLog(pr));
        }

        gl.validateProgram(pr);
        if (!gl.getProgramParameter(pr, gl.VALIDATE_STATUS)) {
            console.warn(`Warning while validating shaders for program ${name}`);
            console.warn(gl.getProgramInfoLog(pr));
        }

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        const vao = gl.createVertexArray();

        let program: Program = {
            run(body) {
                gl.bindVertexArray(vao);
                gl.useProgram(pr);
                body();
                gl.bindVertexArray(null);
            },
        };

        for (let i = 0; i < gl.getProgramParameter(pr, gl.ACTIVE_ATTRIBUTES); i++) {
            let name = gl.getActiveAttrib(pr, i).name;
            program[name] = gl.getAttribLocation(pr, name);
        }
        for (let i = 0; i < gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS); i++) {
            let name = gl.getActiveUniform(pr, i).name;
            program[name] = gl.getUniformLocation(pr, name);
        }

        gl.bindVertexArray(vao);
        setup(gl, program);
        gl.bindVertexArray(null);

        return program;
    }
}


//////////////////////////////////////////////////////////////////////
// Shaders

const vert_river = `
    precision highp float;
    uniform mat4 u_projection;
    in vec4 a_xyww; // x, y, width1, width2 (widths are constant across vertices)
    out vec2 v_riverwidth;
    out vec3 v_barycentric;
    void main() {
        v_riverwidth = a_xyww.ba;
        int index = gl_VertexID % 3;
        v_barycentric = vec3(index == 0, index == 1, index == 2);
        gl_Position = u_projection * vec4(a_xyww.xy, 0, 1);
    }`;

const frag_river = `
    precision mediump float;
    in vec2 v_riverwidth;
    in vec3 v_barycentric;
    out vec4 out_fragcolor;
    const vec3 blue = vec3(0.2, 0.5, 0.7);
    void main() {
        float xt = v_barycentric.r / (v_barycentric.b + v_barycentric.r);
        float dist = sqrt(v_barycentric.b*v_barycentric.b + v_barycentric.r*v_barycentric.r + v_barycentric.b*v_barycentric.r);
        float pos = 0.5;
        float width = 0.35 * mix(v_riverwidth.x, v_riverwidth.y, xt); // variable width from r side to b side
        // NOTE: I've tried using screen space derivatives to make widths consistent between adjacent triangles,
        // but it ended up looking worse, so I reverted it. I multiplied the width by 2.0 * fwidth(v_barycentric.g)
        // and removed the divide by / s_length[s] in setRiverGeometry().
        // NOTE: the smoothstep is from w + minwidth to w - antialias thickness, but antialias thickness should
        // be calculated based on the matrix transform because we want it to be roughly 1 pixel; the min width should
        // probably also be 1 pixel
        float in_river = smoothstep(width + 0.025, max(0.0, width - 0.05), abs(dist - pos));
        vec4 river_color = in_river * vec4(blue, 1);
        // HACK: for debugging - if (min(v_barycentric.r, min(v_barycentric.g, v_barycentric.b)) < 0.05) river_color = vec4(0, 0, 0, 1);
        out_fragcolor = river_color;
    }`;

const vert_land = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    in vec2 a_em; // NOTE: moisture channel unused
    out float v_e;
    out vec2 v_xy;
    void main() {
        vec4 pos = u_projection * vec4(a_xy, 0, 1);
        v_xy = (1.0 + pos.xy) * 0.5;
        v_e = a_em.x;
        gl_Position = pos;
    }`;

 const frag_land = `
    precision highp float;
    uniform sampler2D u_water;
    uniform float u_outline_water;
    in float v_e;
    in vec2 v_xy;
    out vec4 out_elevation;
    void main() {
        float e = 0.5 * (1.0 + v_e);
        float river = texture(u_water, v_xy).a;
        if (e >= 0.5) {
            float bump = u_outline_water / 256.0;
            float L1 = e + bump;
            float L2 = (e - 0.5) * (bump * 100.0) + 0.5;
            // TODO: simplify equation
            e = min(L1, mix(L1, L2, river));
        }
        out_elevation = vec4(e, 0, 0, 1);
    }`;

const vert_depth = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    in vec2 a_em;
    out float v_z;
    void main() {
        vec4 pos = u_projection * vec4(a_xy, max(0.0, a_em.x), 1);
        v_z = a_em.x;
        gl_Position = pos;
    }`;

const frag_depth = `
    precision highp float;
    in float v_z;
    out vec4 out_depth;
    void main() {
        out_depth = vec4(v_z, 0, 0, 1);
    }`;

const vert_drape = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    in vec2 a_em;
    in float a_country;
    in float a_zone;
    in float a_terrain;
    out vec2 v_em, v_uv, v_xy;
    out float v_z;
    out float v_country;
    out float v_zone;
    out float v_terrain;
    void main() {
        v_em = a_em;
        v_country = a_country;
        v_zone = a_zone;
        v_terrain = a_terrain;
        vec2 xy_clamped = clamp(a_xy, vec2(0, 0), vec2(1000, 1000));
        v_z = max(0.0, a_em.x); // oceans with e<0 still rendered at z=0
        if (xy_clamped != a_xy) { // boundary points
            v_z = -0.5;
            v_em = vec2(0.0, 0.0);
            v_country = -1.0;
            v_zone = -1.0;
            v_terrain = -1.0;
        }
        vec4 pos = vec4(u_projection * vec4(xy_clamped, v_z, 1));
        v_uv = a_xy / 1000.0;
        v_xy = (1.0 + pos.xy) * 0.5;
        gl_Position = pos;
    }`;

const frag_drape = `
    precision highp float;
    uniform sampler2D u_colormap;
    uniform sampler2D u_elevation;
    uniform sampler2D u_water;
    uniform sampler2D u_depth;
    uniform sampler2D u_border;
    uniform sampler2D u_road;
    uniform vec2 u_light_angle, u_inverse_texture_size;
    uniform float u_slope, u_flat,
                  u_ambient, u_overhead,
                  u_outline_strength, u_outline_coast, u_outline_water,
                  u_outline_depth, u_outline_threshold,
                  u_biome_colors,
                  u_country_strength, u_country_borders,
                  u_city_mode, u_road_strength;
    uniform vec3 u_countrypalette[8];
    uniform vec3 u_citypalette[4];
    uniform vec3 u_terrainpalette[8];
    in vec2 v_uv, v_xy, v_em;
    in float v_z;
    in float v_country;
    in float v_zone;
    in float v_terrain;
    out vec4 out_fragcolor;

    const vec3 neutral_land_biome = vec3(0.9, 0.8, 0.7);
    const vec3 neutral_water_biome = 0.8 * neutral_land_biome;

    void main() {
        vec2 sample_offset = 0.5 * u_inverse_texture_size;
        vec2 pos = v_uv + sample_offset;
        vec2 dx = vec2(u_inverse_texture_size.x, 0),
             dy = vec2(0, u_inverse_texture_size.y);

        float z  = texture(u_elevation, pos).x;
        float zE = texture(u_elevation, pos + dx).x;
        float zN = texture(u_elevation, pos - dy).x;
        float zW = texture(u_elevation, pos - dx).x;
        float zS = texture(u_elevation, pos + dy).x;
        vec3 slope_vector = normalize(vec3(zS-zN, zE-zW, u_overhead * (u_inverse_texture_size.x + u_inverse_texture_size.y)));
        vec3 light_vector = normalize(vec3(u_light_angle, mix(u_slope, u_flat, slope_vector.z)));
        float light = u_ambient + max(0.0, dot(light_vector, slope_vector));
        vec3 neutral_biome_color = neutral_land_biome;
        vec4 water_color = texture(u_water, pos);
        if (z >= 0.5 && v_z >= 0.0) {
            // on land, lower the elevation around rivers
            z -= u_outline_water / 256.0 * (1.0 - water_color.a);
        } else {
            // in the ocean, or underground, don't draw rivers
            water_color.a = 0.0; neutral_biome_color = neutral_water_biome;
        }
        vec3 biome_color = texture(u_colormap, vec2(z, v_em.y)).rgb;
        water_color = mix(vec4(neutral_water_biome * (1.2 - water_color.a), water_color.a), water_color, u_biome_colors);
        biome_color = mix(neutral_biome_color, biome_color, u_biome_colors);
        if (v_z < 0.0) {
            // at the exterior boundary, we'll draw soil or water underground
            float land_or_water = smoothstep(0.0, -0.001, v_em.x - v_z);
            vec3 soil_color = vec3(0.4, 0.3, 0.2);
            vec3 underground_color = mix(soil_color, mix(neutral_water_biome, vec3(0.1, 0.1, 0.2), u_biome_colors), land_or_water) * smoothstep(-0.7, -0.1, v_z);
            vec3 highlight_color = mix(vec3(0, 0, 0), mix(vec3(0.8, 0.8, 0.8), vec3(0.4, 0.5, 0.7), u_biome_colors), land_or_water);
            biome_color = mix(underground_color, highlight_color, 0.5 * smoothstep(-0.025, 0.0, v_z));
            light = 1.0 - 0.3 * smoothstep(0.8, 1.0, fract((v_em.x - v_z) * 20.0)); // add horizontal lines
        }
        // if (fract(z * 10.0) < 10.0 * fwidth(z)) { biome_color = vec3(0,0,0); } // contour lines

        // TODO: add noise texture based on biome

        float depth0 = texture(u_depth, v_xy).x,
              depth1 = max(max(texture(u_depth, v_xy + u_outline_depth*(-dy-dx)).x,
                               texture(u_depth, v_xy + u_outline_depth*(-dy+dx)).x),
                           texture(u_depth, v_xy + u_outline_depth*(-dy)).x),
              depth2 = max(max(texture(u_depth, v_xy + u_outline_depth*(dy-dx)).x,
                               texture(u_depth, v_xy + u_outline_depth*(dy+dx)).x),
                           texture(u_depth, v_xy + u_outline_depth*(dy)).x);
        float outline = 1.0 + u_outline_strength * (max(u_outline_threshold, depth1-depth0) - u_outline_threshold);

        // Add coast outline, but avoid it if there's a river nearby
        float neighboring_river = max(
            max(
                texture(u_water, pos + u_outline_depth * dx).a,
                texture(u_water, pos - u_outline_depth * dx).a
            ),
            max(
                texture(u_water, pos + u_outline_depth * dy).a,
                texture(u_water, pos - u_outline_depth * dy).a
            )
        );
        if (z <= 0.5 && max(depth1, depth2) > 1.0/256.0 && neighboring_river <= 0.2) { outline += u_outline_coast * 256.0 * (max(depth1, depth2) - 2.0*(z - 0.5)); }

        // City mode: replace the biome color with the zone color.
        if (u_city_mode > 0.5 && v_zone >= 0.0) {
            int zi = int(clamp(floor(v_zone + 0.5), 0.0, 3.0));
            biome_color = u_citypalette[zi];
        }

        // Explicit terrain (e.g. snow): override the biome color.
        if (v_terrain > 0.5) {
            int ti = int(clamp(floor(v_terrain + 0.5), 0.0, 7.0));
            biome_color = u_terrainpalette[ti];
        }

        // Tint land with the country color and draw dark national borders
        if (v_em.x >= 0.0 && v_country >= 0.0) {
            int slot = int(clamp(floor(v_country + 0.5), 0.0, 7.0));
            vec3 country_color = u_countrypalette[slot];
            biome_color = mix(biome_color, country_color, u_country_strength);
        }
        float border = texture(u_border, pos).a;
        biome_color *= mix(1.0, 1.0 - 0.9 * border, u_country_borders);

        // City roads: draw asphalt over developable ground in city mode
        if (u_city_mode > 0.5) {
            float road = texture(u_road, pos).a;
            biome_color = mix(biome_color, vec3(0.10, 0.10, 0.11), u_road_strength * 0.92 * road);
        }

        out_fragcolor = vec4(mix(biome_color, water_color.rgb, water_color.a) * light / outline, 1);
    }`;

const vert_final = `
    precision highp float;
    in vec2 a_uv;
    out vec2 v_uv;
    void main() {
        v_uv = a_uv;
        gl_Position = vec4(2.0 * v_uv - 1.0, 0.0, 1.0);
    }`;

const frag_final = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec2 u_offset;
    in vec2 v_uv;
    out vec4 out_fragcolor;
    void main() {
         out_fragcolor = texture(u_texture, v_uv + u_offset);
    }`;

const vert_border = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    void main() {
        gl_Position = u_projection * vec4(a_xy, 0, 1);
    }`;

const frag_border = `
    precision mediump float;
    out vec4 out_fragcolor;
    void main() {
        out_fragcolor = vec4(0, 0, 0, 1);
    }`;

const frag_road = `
    precision mediump float;
    out vec4 out_fragcolor;
    void main() {
        out_fragcolor = vec4(0.13, 0.13, 0.14, 1); // asphalt
    }`;

const vert_building = `
    precision highp float;
    uniform mat4 u_projection;
    in vec3 a_xyz;
    in vec3 a_color;
    out vec3 v_color;
    void main() {
        v_color = a_color;
        gl_Position = u_projection * vec4(a_xyz, 1);
    }`;

const frag_building = `
    precision mediump float;
    in vec3 v_color;
    out vec4 out_fragcolor;
    void main() {
        out_fragcolor = vec4(v_color, 1);
    }`;

//////////////////////////////////////////////////////////////////////
// Mapgen4 renderer

const fbo_texture_size: number = 2048;

export default class Renderer {
    numRiverTriangles: number = 0;
    numBorderSegments: number = 0;
    numRoadSegments: number = 0;
    numBuildings: number = 0;
    numTrees: number = 0;
    treeDensity: number = 1;

    mesh: Mesh;
    topdown: mat4;
    projection: mat4;
    inverse_projection: mat4;

    a_quad_xy: Float32Array;
    a_quad_em: Float32Array;
    quad_elements_length: number; // have to store the original size because the worker thread borrows the actual array
    quad_elements: Int32Array;
    a_river_xyww: Float32Array;
    a_border_xy: Float32Array;
    a_road_xy: Float32Array;
    a_buildings: Float32Array;
    a_trees: Float32Array;
    countryPalette: Float32Array;
    cityPalette: Float32Array;
    terrainPalette: Float32Array;

    countryNames: string[];
    countrySumX: Float32Array;
    countrySumY: Float32Array;
    countryCenterX: Float32Array;
    countryCenterY: Float32Array;
    labelLayer: HTMLDivElement;
    countryLabels: {el: HTMLSpanElement; visible: boolean; x: number; y: number}[];

    screenshotCanvas: HTMLCanvasElement;
    screenshotCallback: () => void;
    renderParam: any;

    webgl: WebGLWrapper;

    texture_colormap: Texture;

    fbo_river: Framebuffer;
    fbo_land: Framebuffer;
    fbo_depth: Framebuffer;
    fbo_drape: Framebuffer;
    fbo_border: Framebuffer;
    fbo_road: Framebuffer;

    program_river: Program;
    program_land: Program;
    program_depth: Program;
    program_drape: Program;
    program_final: Program;
    program_border: Program;
    program_road: Program;
    program_building: Program;
    program_tree: Program;

    buffer_fullscreen: Buffer;
    buffer_quad_xy: Buffer;
    buffer_quad_em: Buffer;
    buffer_quad_elements: Buffer;
    buffer_river_xyww: Buffer;
    buffer_border_xy: Buffer;
    buffer_road_xy: Buffer;
    buffer_buildings: Buffer;
    buffer_trees: Buffer;

    constructor (mesh: Mesh) {
        const canvas = document.getElementById('mapgen4') as HTMLCanvasElement;
        this.mesh = mesh;
        this.webgl = new WebGLWrapper(canvas);

        this.resizeCanvas();

        this.topdown = mat4.create();
        mat4.translate(this.topdown, this.topdown, [-1, -1, 0]);
        mat4.scale(this.topdown, this.topdown, [1/500, 1/500, 1]);

        this.projection = mat4.create();
        this.inverse_projection = mat4.create();

        this.a_quad_xy = new Float32Array(2 * (mesh.numRegions + mesh.numTriangles));
        /* per-vertex layout: elevation, rainfall, country id, city zone,
         * object mask */
        this.a_quad_em = new Float32Array(6 * (mesh.numRegions + mesh.numTriangles));
        this.quad_elements_length = 3 * mesh.numSolidSides;
        this.quad_elements = new Int32Array(this.quad_elements_length);
        /* NOTE: The maximum number of river triangles will be when
         * there's a single binary tree that has every node filled.
         * Each of the N/2 leaves will produce 1 output triangle and
         * each of the N/2 nodes will produce 2 triangles. On average
         * there will be 1.5 output triangles per input triangle. */
        const numRiverVertices = 1.5 /* river triangles per input triangle */ * 3 /* vertices per triangle */ * mesh.numSolidTriangles;
        this.a_river_xyww = new Float32Array(numRiverVertices * 4);
        /* each border segment is 6 vertices of 2 floats, at most one
         * segment per solid side */
        this.a_border_xy = new Float32Array(12 * mesh.numSolidSides);
        this.a_road_xy = new Float32Array(12 * mesh.numSolidSides);
        /* each building is 30 vertices of 6 floats (x, y, z, r, g, b) */
        this.a_buildings = new Float32Array(180 * mesh.numSolidRegions);
        /* each tree is 18 vertices of 6 floats (x, y, z, r, g, b) */
        this.a_trees = new Float32Array(108 * mesh.numSolidRegions);
        this.countryPalette = new Float32Array(3 * NUM_COUNTRIES);
        for (let i = 0; i < NUM_COUNTRIES; i++) {
            let [r, g, b] = countryPalette[i];
            this.countryPalette[3*i] = r;
            this.countryPalette[3*i+1] = g;
            this.countryPalette[3*i+2] = b;
        }
        this.cityPalette = new Float32Array(3 * NUM_CITY_ZONES);
        for (let i = 0; i < NUM_CITY_ZONES; i++) {
            let [r, g, b] = cityColors[i];
            this.cityPalette[3*i] = r;
            this.cityPalette[3*i+1] = g;
            this.cityPalette[3*i+2] = b;
        }
        this.terrainPalette = new Float32Array(3 * NUM_TERRAINS);
        for (let i = 0; i < NUM_TERRAINS; i++) {
            let [r, g, b] = terrainColors[i];
            this.terrainPalette[3*i] = r;
            this.terrainPalette[3*i+1] = g;
            this.terrainPalette[3*i+2] = b;
        }

        Geometry.setMeshGeometry(mesh, this.a_quad_xy);

        this.buffer_quad_xy = this.webgl.createBuffer({update: 'static', data: this.a_quad_xy});
        this.buffer_quad_em = this.webgl.createBuffer({update: 'dynamic', data: this.a_quad_em});
        this.buffer_quad_elements = this.webgl.createBuffer({indices: true, update: 'dynamic', data: this.quad_elements});

        this.buffer_fullscreen = this.webgl.createBuffer({update: 'static', data: new Float32Array([-2, 0, 0, -2, 2, 2])});
        this.buffer_river_xyww = this.webgl.createBuffer({update: 'dynamic', data: this.a_river_xyww});
        this.buffer_border_xy = this.webgl.createBuffer({update: 'dynamic', data: this.a_border_xy});
        this.buffer_road_xy = this.webgl.createBuffer({update: 'dynamic', data: this.a_road_xy});
        this.buffer_buildings = this.webgl.createBuffer({update: 'dynamic', data: this.a_buildings});
        this.buffer_trees = this.webgl.createBuffer({update: 'dynamic', data: this.a_trees});

        this.texture_colormap = this.webgl.createTexture({data: colormap.data, width: colormap.width, height: colormap.height, filter: 'nearest'});

        this.fbo_land  = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: false, internalFormat: this.webgl.gl.R16F, filter: 'linear'});
        this.fbo_depth = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: true, internalFormat: this.webgl.gl.R16F, filter: 'nearest'}); // NOTE: linear requires adjusting parameters
        this.fbo_river = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: false, filter: 'linear'}); // linear makes rivers look better
        this.fbo_drape = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: true, filter: 'linear'}); // linear to smooth out edges
        this.fbo_border = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: false, filter: 'linear'});
        this.fbo_road = this.webgl.createFramebuffer(fbo_texture_size, fbo_texture_size, {depth: false, filter: 'linear'});

        this.program_river = this.webgl.createProgram('river', vert_river, frag_river, (gl, program) => {
            this.buffer_river_xyww.vertexAttribPointer(program.a_xyww, 4, gl.FLOAT, false, 0, 0);
        });
        this.program_land  = this.webgl.createProgram('land', vert_land,  frag_land, (gl, program) => {
            this.buffer_quad_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_em, 2, gl.FLOAT, false, 24, 0);
            this.buffer_quad_elements.bind();
        });
        this.program_depth = this.webgl.createProgram('depth', vert_depth, frag_depth, (gl, program) => {
            this.buffer_quad_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_em, 2, gl.FLOAT, false, 24, 0);
            this.buffer_quad_elements.bind();
        });
        this.program_drape = this.webgl.createProgram('drape', vert_drape, frag_drape, (gl, program) => {
            this.buffer_quad_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_em, 2, gl.FLOAT, false, 24, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_country, 1, gl.FLOAT, false, 24, 8);
            this.buffer_quad_em.vertexAttribPointer(program.a_zone, 1, gl.FLOAT, false, 24, 12);
            this.buffer_quad_em.vertexAttribPointer(program.a_terrain, 1, gl.FLOAT, false, 24, 20);
            this.buffer_quad_elements.bind();
        });
        this.program_final = this.webgl.createProgram('final', vert_final, frag_final, (gl, program) => {
            this.buffer_fullscreen.vertexAttribPointer(program.a_uv, 2, gl.FLOAT, false, 0, 0);
        });
        this.program_border = this.webgl.createProgram('border', vert_border, frag_border, (gl, program) => {
            this.buffer_border_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
        });
        this.program_road = this.webgl.createProgram('road', vert_border, frag_road, (gl, program) => {
            this.buffer_road_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
        });
        this.program_building = this.webgl.createProgram('building', vert_building, frag_building, (gl, program) => {
            this.buffer_buildings.vertexAttribPointer(program.a_xyz, 3, gl.FLOAT, false, 24, 0);
            this.buffer_buildings.vertexAttribPointer(program.a_color, 3, gl.FLOAT, false, 24, 12);
        });
        this.program_tree = this.webgl.createProgram('tree', vert_building, frag_building, (gl, program) => {
            this.buffer_trees.vertexAttribPointer(program.a_xyz, 3, gl.FLOAT, false, 24, 0);
            this.buffer_trees.vertexAttribPointer(program.a_color, 3, gl.FLOAT, false, 24, 12);
        });

        this.screenshotCanvas = document.createElement('canvas');
        this.screenshotCanvas.width = fbo_texture_size;
        this.screenshotCanvas.height = fbo_texture_size;
        this.screenshotCallback = null;

        /* Country name labels overlaid on the map (DOM, repositioned
         * every frame to track the projection). */
        this.countryNames = new Array(NUM_COUNTRIES).fill('');
        this.countrySumX = new Float32Array(NUM_COUNTRIES);
        this.countrySumY = new Float32Array(NUM_COUNTRIES);
        this.countryCenterX = new Float32Array(NUM_COUNTRIES).fill(NaN);
        this.countryCenterY = new Float32Array(NUM_COUNTRIES).fill(NaN);
        this.labelLayer = document.getElementById('labels') as HTMLDivElement;
        if (!this.labelLayer) {
            this.labelLayer = document.createElement('div');
            this.labelLayer.setAttribute('id', 'labels');
            document.getElementById('map').appendChild(this.labelLayer);
        }
        this.countryLabels = [];
        for (let i = 0; i < NUM_COUNTRIES; i++) {
            const el = document.createElement('span');
            el.setAttribute('class', 'country-name-label');
            el.style.display = 'none';
            this.labelLayer.appendChild(el);
            this.countryLabels.push({el, visible: false, x: 0, y: 0});
        }

        this.renderParam = undefined;
        this.startDrawingLoop();
    }

    screenToWorld(coords: [number, number]): vec2 {
        /* convert from screen 2d (inverted y) to 4d for matrix multiply */
        let glCoords = vec4.fromValues(
            coords[0] * 2 - 1,
            1 - coords[1] * 2,
            /* TODO: z should be 0 only when tilt_deg is 0;
             * need to figure out the proper z value here */
            0,
            1
        );
        /* it returns vec4 but we only need vec2; they're compatible */
        let transformed = vec4.transformMat4(vec4.create(), glCoords, this.inverse_projection);
        return [transformed[0], transformed[1]];
    }

    /* Update the buffers with the latest map data */
    updateMap() {
        this.buffer_quad_em.subdata(0, this.a_quad_em);
        this.buffer_quad_elements.subdata(0, this.quad_elements);
        this.buffer_river_xyww.subdata(0, this.a_river_xyww.subarray(0, 4 * 3 * this.numRiverTriangles));

        this.numBorderSegments = Geometry.setBorderGeometry(this.mesh, this.a_quad_em, this.a_border_xy);
        this.buffer_border_xy.subdata(0, this.a_border_xy.subarray(0, 12 * this.numBorderSegments));

        this.numRoadSegments = Geometry.setRoadGeometry(this.mesh, this.a_quad_em, this.a_road_xy);
        this.buffer_road_xy.subdata(0, this.a_road_xy.subarray(0, 12 * this.numRoadSegments));

        this.numBuildings = Geometry.setBuildingGeometry(this.mesh, this.a_quad_em, this.a_buildings);
        this.buffer_buildings.subdata(0, this.a_buildings.subarray(0, 180 * this.numBuildings));
        this.updateTrees();
        this.computeCountryCenters();
    }

    /* Average the positions of each country's regions to get a label
     * anchor point; NaN means the country hasn't been painted. */
    computeCountryCenters() {
        this.countrySumX.fill(0);
        this.countrySumY.fill(0);
        const counts = new Int32Array(NUM_COUNTRIES);
        const {mesh} = this;
        for (let r = 0; r < mesh.numSolidRegions; r++) {
            const c = this.a_quad_em[6*r + 2];
            if (c >= 0 && c < NUM_COUNTRIES) {
                counts[c]++;
                this.countrySumX[c] += mesh.x_of_r(r);
                this.countrySumY[c] += mesh.y_of_r(r);
            }
        }
        for (let c = 0; c < NUM_COUNTRIES; c++) {
            if (counts[c] > 0) {
                this.countryCenterX[c] = this.countrySumX[c] / counts[c];
                this.countryCenterY[c] = this.countrySumY[c] / counts[c];
            } else {
                this.countryCenterX[c] = NaN;
                this.countryCenterY[c] = NaN;
            }
        }
        this.reconcileLabels();
    }

    /* Names come from the painting UI; show a label only for countries
     * that both have a name and are painted on the map. */
    setCountryNames(names: string[]) {
        this.countryNames = names.slice();
        this.reconcileLabels();
    }

    reconcileLabels() {
        for (let c = 0; c < NUM_COUNTRIES; c++) {
            const label = this.countryLabels[c];
            const name = (this.countryNames[c] ?? '').trim();
            const painted = Number.isFinite(this.countryCenterX[c]) && Number.isFinite(this.countryCenterY[c]);
            if (name && painted) {
                label.visible = true;
                label.el.style.display = '';
                label.el.textContent = name;
                label.x = this.countryCenterX[c];
                label.y = this.countryCenterY[c];
            } else {
                label.visible = false;
                label.el.style.display = 'none';
            }
        }
    }

    /* Move each visible label to its country's centroid in screen space. */
    updateLabelPositions() {
        const layer = this.labelLayer;
        const W = layer.clientWidth, H = layer.clientHeight;
        if (W <= 0 || H <= 0) return;
        const v = vec4.create();
        for (const label of this.countryLabels) {
            if (!label.visible) continue;
            vec4.transformMat4(v, vec4.fromValues(label.x, label.y, 0, 1), this.projection);
            label.el.style.transform =
                `translate(${((v[0] + 1) / 2 * W).toFixed(1)}px, ${((1 - v[1]) / 2 * H).toFixed(1)}px)`;
        }
    }

    /* Allow drawing at a different resolution than the internal texture size */
    resizeCanvas() {
        let canvas = document.getElementById('mapgen4') as HTMLCanvasElement;
        let size = canvas.clientWidth;
        size = 2048; /* could be smaller to increase performance */
        if (canvas.width !== size || canvas.height !== size) {
            console.log(`Resizing canvas from ${canvas.width}x${canvas.height} to ${size}x${size}`);
            canvas.width = canvas.height = size;
            this.webgl.gl.viewport(0, 0, canvas.width, canvas.height);
        }
    }

    /* wrapper function to make the other drawing functions more convenient */
    drawGeneric(program: Program, fb: Framebuffer | null, draw: (gl: WebGL2RenderingContext, program: Program) => void) {
        const {gl} = this.webgl;
        fb = fb ?? this.webgl.drawToScreen();
        fb.viewport();
        program.run(() => {
            if (fb.depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
            draw(gl, program);
            if (fb.depth) gl.disable(gl.DEPTH_TEST);
        });
    }

    drawRivers() {
        this.drawGeneric(this.program_river, this.fbo_river, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.topdown);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.blendEquation(gl.FUNC_ADD);

            gl.drawArrays(gl.TRIANGLES, 0, 3 * this.numRiverTriangles);
        });
    }

    drawBorders() {
        this.drawGeneric(this.program_border, this.fbo_border, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.topdown);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.blendEquation(gl.FUNC_ADD);

            gl.drawArrays(gl.TRIANGLES, 0, 6 * this.numBorderSegments);
        });
    }

    drawRoads() {
        this.drawGeneric(this.program_road, this.fbo_road, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.topdown);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.blendEquation(gl.FUNC_ADD);

            gl.drawArrays(gl.TRIANGLES, 0, 6 * this.numRoadSegments);
        });
    }

    /* Draw 3D building boxes into the drape framebuffer after the
     * terrain, using the same projection + depth so they sit on the
     * ground and occlude each other correctly. */
    drawBuildings() {
        this.drawGeneric(this.program_building, this.fbo_drape, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.projection);

            gl.drawArrays(gl.TRIANGLES, 0, 30 * this.numBuildings);
        });
    }

    drawTrees() {
        this.drawGeneric(this.program_tree, this.fbo_drape, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.projection);

            gl.drawArrays(gl.TRIANGLES, 0, 18 * this.numTrees);
        });
    }

    /* Regenerate the tree geometry (used when the map changes and when
     * the tree_density slider moves). */
    updateTrees() {
        this.numTrees = Geometry.setTreeGeometry(this.mesh, this.a_quad_em, this.a_trees, this.treeDensity);
        this.buffer_trees.subdata(0, this.a_trees.subarray(0, 108 * this.numTrees));
    }

    drawLand(outline_water: number) {
        this.drawGeneric(this.program_land, this.fbo_land, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.topdown);
            gl.uniform1f(program.u_outline_water, outline_water);
            this.fbo_river.texture.activate(gl.TEXTURE0, program.u_water);

            gl.drawElements(gl.TRIANGLES, this.quad_elements_length, gl.UNSIGNED_INT, 0);
        });
    }

    drawDepth() {
        this.drawGeneric(this.program_depth, this.fbo_depth, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.projection);

            gl.drawElements(gl.TRIANGLES, this.quad_elements_length, gl.UNSIGNED_INT, 0);
        });
    }

    drawDrape(renderParam: any) {
        const light_angle_rad = Math.PI / 180 * (renderParam.light_angle_deg + renderParam.rotate_deg);
        this.drawGeneric(this.program_drape, this.fbo_drape, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.projection);
            gl.uniform2fv(program.u_light_angle, [Math.cos(light_angle_rad), Math.sin(light_angle_rad)]);
            gl.uniform2fv(program.u_inverse_texture_size, [1.5 / this.fbo_drape.texture.width, 1.5 / this.fbo_drape.texture.height]);
            gl.uniform1f(program.u_slope, renderParam.slope);
            gl.uniform1f(program.u_flat, renderParam.flat);
            gl.uniform1f(program.u_ambient, renderParam.ambient);
            gl.uniform1f(program.u_overhead, renderParam.overhead);
            gl.uniform1f(program.u_outline_depth, renderParam.outline_depth * 5 * renderParam.zoom);
            gl.uniform1f(program.u_outline_coast, renderParam.outline_coast);
            gl.uniform1f(program.u_outline_water, renderParam.outline_water);
            gl.uniform1f(program.u_outline_strength, renderParam.outline_strength);
            gl.uniform1f(program.u_outline_threshold, renderParam.outline_threshold / 1000);
            gl.uniform1f(program.u_biome_colors, renderParam.biome_colors);
            gl.uniform1f(program.u_country_strength, renderParam.country_strength);
            gl.uniform1f(program.u_country_borders, renderParam.country_borders);
            gl.uniform1f(program.u_city_mode, renderParam.city_mode ?? 0);
            gl.uniform1f(program.u_road_strength, renderParam.road_strength ?? 0);

            /* uniform arrays are reflected as "u_countrypalette[0]" */
            const u_countrypalette = program['u_countrypalette[0]'] ?? program.u_countrypalette;
            if (u_countrypalette) gl.uniform3fv(u_countrypalette, this.countryPalette);
            const u_citypalette = program['u_citypalette[0]'] ?? program.u_citypalette;
            if (u_citypalette) gl.uniform3fv(u_citypalette, this.cityPalette);
            const u_terrainpalette = program['u_terrainpalette[0]'] ?? program.u_terrainpalette;
            if (u_terrainpalette) gl.uniform3fv(u_terrainpalette, this.terrainPalette);

            this.texture_colormap.activate(gl.TEXTURE0, program.u_colormap);
            this.fbo_land.texture.activate(gl.TEXTURE1, program.u_elevation);
            this.fbo_river.texture.activate(gl.TEXTURE2, program.u_water);
            this.fbo_depth.texture.activate(gl.TEXTURE3, program.u_depth);
            this.fbo_border.texture.activate(gl.TEXTURE4, program.u_border);
            this.fbo_road.texture.activate(gl.TEXTURE5, program.u_road);

            gl.drawElements(gl.TRIANGLES, this.quad_elements_length, gl.UNSIGNED_INT, 0);
        });
    }

    drawFinal(offset: [number, number]) {
        this.drawGeneric(this.program_final, null, (gl, program) => {
            gl.uniform2fv(program.u_offset, offset);
            this.fbo_drape.texture.activate(gl.TEXTURE0, program.u_texture);

            gl.drawArrays(gl.TRIANGLES, 0, 3);
        });
    }

    startDrawingLoop() {
        const {gl} = this.webgl;

        const clearBuffers = () => {
            this.fbo_river.clear(0, 0, 0, 0);
            this.fbo_depth.clear(0, 0, 0, 1);
            this.fbo_drape.clear(0.3, 0.3, 0.35, 1);
            this.fbo_border.clear(0, 0, 0, 0);
            this.fbo_road.clear(0, 0, 0, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        };

        /* Only draw when render parameters have been passed in;
         * otherwise skip the render and wait for the next tick */
        clearBuffers();
        const renderLoop = () => {
            requestAnimationFrame(renderLoop);
            const renderParam = this.renderParam;
            if (!renderParam) { return; }
            this.renderParam = undefined;

            if (this.numRiverTriangles > 0) {
                this.drawRivers();
            }

            this.drawLand(renderParam.outline_water);

            /* Standard rotation for orthographic view */
            mat4.identity(this.projection);
            mat4.rotateX(this.projection, this.projection, (180 + renderParam.tilt_deg) * Math.PI/180);
            mat4.rotateZ(this.projection, this.projection, renderParam.rotate_deg * Math.PI/180);

            /* Top-down oblique copies column 2 (y input) to row 3 (z
             * output). Typical matrix libraries such as glm's mat4 or
             * Unity's Matrix4x4 or Unreal's FMatrix don't have this
             * this.projection built-in. For mapgen4 I merge orthographic
             * (which will *move* part of y-input to z-output) and
             * top-down oblique (which will *copy* y-input to z-output).
             * <https://en.wikipedia.org/wiki/Oblique_projection> */
            this.projection[9] = 1;

            /* Scale and translate works on the hybrid this.projection */
            mat4.scale(this.projection, this.projection, [renderParam.zoom/100, renderParam.zoom/100, renderParam.mountain_height * renderParam.zoom/100]);
            mat4.translate(this.projection, this.projection, [-renderParam.x, -renderParam.y, 0]);

            /* Keep track of the inverse matrix for mapping mouse to world coordinates */
            mat4.invert(this.inverse_projection, this.projection);

            if (renderParam.outline_depth > 0) {
                this.drawDepth();
            }

            if (this.numBorderSegments > 0) {
                this.drawBorders();
            }

            if (this.numRoadSegments > 0) {
                this.drawRoads();
            }

            this.drawDrape(renderParam);

            if (this.numBuildings > 0 && renderParam.city_mode > 0) {
                this.drawBuildings();
            }

            if (this.numTrees > 0 && renderParam.city_mode > 0) {
                this.drawTrees();
            }

            /* Draw the final texture to the canvas; this slightly blurs the outlines */
            this.drawFinal([0.5 / fbo_texture_size, 0.5 / fbo_texture_size]);

            this.updateLabelPositions();

            if (this.screenshotCallback) {
                const ctx = this.screenshotCanvas.getContext('2d');
                const imageData = ctx.getImageData(0, 0, this.screenshotCanvas.width, this.screenshotCanvas.height);
                const bytesPerRow = 4 * this.screenshotCanvas.width;
                const buffer = new Uint8Array(bytesPerRow * this.screenshotCanvas.height);
                gl.readPixels(0, 0, this.screenshotCanvas.width, this.screenshotCanvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);

                /* Flip row order from WebGL to Canvas */
                for (let y = 0; y < this.screenshotCanvas.height; y++) {
                    const rowBuffer = new Uint8Array(buffer.buffer, y * bytesPerRow, bytesPerRow);
                    imageData.data.set(rowBuffer, (this.screenshotCanvas.height-y-1) * bytesPerRow);
                }
                ctx.putImageData(imageData, 0, 0);

                this.screenshotCallback();
                this.screenshotCallback = null;
            }

            clearBuffers();
        };

        renderLoop();
    }

    updateView(renderParam: any) {
        this.renderParam = renderParam;
        /* the tree density slider only redraws; rebuild the tree
         * geometry when it changes */
        if (renderParam && this.treeDensity !== (renderParam.tree_density ?? 1)) {
            this.treeDensity = renderParam.tree_density ?? 1;
            this.updateTrees();
        }
    }
}
