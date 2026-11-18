import { CHART_THEME } from "./chart-theme";

/** A GPU triangle strip keeps a consistent line width on WebGL implementations. */
export class WebGLLine {
  readonly gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private count = 0;
  private lost = false;
  private valueOrigin = 0;
  private onLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.error("Graphics context lost. Reload this page to restore the graph.");
  };
  constructor(
    private canvas: HTMLCanvasElement,
    private error: (message: string) => void,
  ) {
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    if (!gl)
      throw new Error(
        "WebGL is unavailable. Enable hardware acceleration and reload the page.",
      );
    this.gl = gl;
    const shader = (type: number, source: string) => {
      const value = gl.createShader(type)!;
      gl.shaderSource(value, source);
      gl.compileShader(value);
      if (!gl.getShaderParameter(value, gl.COMPILE_STATUS))
        throw new Error(
          gl.getShaderInfoLog(value) ?? "Shader compilation failed",
        );
      return value;
    };
    const vertex = shader(
      gl.VERTEX_SHADER,
      `
      attribute vec2 a_previous; attribute vec2 a_position; attribute vec2 a_next; attribute float a_side;
      uniform float u_start; uniform vec2 u_domain; uniform vec2 u_resolution; uniform float u_width;
      vec2 project(vec2 p) { return vec2((p.x-u_start)*2.0-1.0, (p.y-u_domain.x)/(u_domain.y-u_domain.x)*2.0-1.0); }
      void main() {
        vec2 previous=project(a_previous), current=project(a_position), next=project(a_next);
        vec2 direction=(next-previous)*u_resolution;
        if(length(direction)<0.0001) direction=vec2(1.0,0.0);
        vec2 normal=normalize(vec2(-direction.y,direction.x));
        gl_Position=vec4(current+normal*a_side*u_width/u_resolution,0.0,1.0);
      }`,
    );
    const fragment = shader(
      gl.FRAGMENT_SHADER,
      `precision mediump float; void main(){gl_FragColor=vec4(${CHART_THEME.line.join(",")},1.0);}`,
    );
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error("WebGL program linking failed");
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    this.buffer = gl.createBuffer()!;
    canvas.addEventListener("webglcontextlost", this.onLost);
  }
  upload(
    points: { time: number; value: number }[],
    base: number,
    span: number,
    valueOrigin: number,
  ) {
    this.valueOrigin = valueOrigin;
    const data = new Float32Array(points.length * 14);
    for (let i = 0; i < points.length; i++) {
      const previous = points[Math.max(0, i - 1)],
        current = points[i],
        next = points[Math.min(points.length - 1, i + 1)];
      for (let side = 0; side < 2; side++)
        data.set(
          [
            (previous.time - base) / span,
            previous.value - valueOrigin,
            (current.time - base) / span,
            current.value - valueOrigin,
            (next.time - base) / span,
            next.value - valueOrigin,
            side === 0 ? -1 : 1,
          ],
          i * 14 + side * 7,
        );
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.count = points.length * 2;
  }
  draw(
    start: number,
    domain: [number, number],
    plot: { left: number; bottom: number; width: number; height: number },
    dpr: number,
  ) {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(...CHART_THEME.background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(
      Math.round(plot.left * dpr),
      Math.round(plot.bottom * dpr),
      Math.round(plot.width * dpr),
      Math.round(plot.height * dpr),
    );
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const [name, size, offset] of [
      ["a_previous", 2, 0],
      ["a_position", 2, 8],
      ["a_next", 2, 16],
      ["a_side", 1, 24],
    ] as const) {
      const location = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 28, offset);
    }
    gl.uniform1f(gl.getUniformLocation(this.program, "u_start"), start);
    gl.uniform2f(
      gl.getUniformLocation(this.program, "u_domain"),
      domain[0] - this.valueOrigin,
      domain[1] - this.valueOrigin,
    );
    gl.uniform2f(
      gl.getUniformLocation(this.program, "u_resolution"),
      plot.width * dpr,
      plot.height * dpr,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "u_width"),
      CHART_THEME.lineWidth * dpr,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.count);
  }
  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
  }
}
