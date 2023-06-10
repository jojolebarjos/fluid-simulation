const simulate = (canvas) => {

  // Get WebGL context
  const gl = canvas.getContext("webgl2");
  if (!gl)
    throw Error("Failed to create WebGL 2 context");

  // Enable required extension
  if (!gl.getExtension("EXT_color_buffer_float"))
    throw Error("EXT_color_buffer_float not available");

  // Helper to create shader object
  const createShader = (type, source) => {
    let shader = gl.createShader(type);
    if (shader) {
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        shader = null;
      }
    }
    return shader;
  };

  // Helper to create program object
  const createProgram = (vertexSource, fragmentSource) => {
    let program = null;
    let vertexShader = createShader(gl.VERTEX_SHADER, vertexSource);
    let fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentSource);
    if (vertexShader && fragmentShader) {
      program = gl.createProgram();
      if (program) {
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          console.error(gl.getProgramInfoLog(program));
          gl.deleteProgram(program);
          program = null;
        }
      }
    }
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return program;
  };

  // Helper to create float texture with linear interpolation
  const createFloatTexture = (width, height) => {
    let data = new Float32Array(width * height * 4);
    let texture = gl.createTexture();
    if (texture) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        width,
        height,
        0,
        gl.RGBA,
        gl.FLOAT,
        data
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }
    return texture;
  };

  // Helper to create framebuffer with 2D texture
  const createFramebuffer = (texture) => {
    let framebuffer = gl.createFramebuffer();
    if (framebuffer) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status != gl.FRAMEBUFFER_COMPLETE) {
        console.error("Framebuffer not complete (" + status + ")");
        gl.deleteFramebuffer(framebuffer);
        framebuffer = null;
      }
    }
    return framebuffer;
  };

  // First pass: advect and apply forces
  const pass1Program = createProgram(
    `#version 300 es
    layout(location = 0) in vec2 pos;

    void main() {
      gl_Position = vec4(pos, 0.0, 1.0);
    }
    `,
    `#version 300 es
    precision highp float;

    uniform sampler2D u_texture;
    uniform vec2 u_resolution;

    uniform vec3 u_forceLocation;
    uniform vec2 u_forceVector;
    uniform float u_feed;

    out vec4 state;

    vec4 get(vec2 delta) {
      return texture(u_texture, (gl_FragCoord.xy + delta) / u_resolution);
    }

    void main() {

      // Fetch relevant values
      vec4 c = get(vec2( 0.0,  0.0));
      vec4 t = get(vec2( 0.0,  1.0));
      vec4 l = get(vec2(-1.0,  0.0));
      vec4 r = get(vec2( 1.0,  0.0));
      vec4 b = get(vec2( 0.0, -1.0));

      // Self-advection
      vec2 advection = get(-c.xy).xy;

      // Pressure effect
      float density = 1.0;
      vec2 pressure = -vec2(r.z - l.z, t.z - b.z) / (2.0 * density);

      // TODO viscosity? seems that numerical instability tend to dampen the fluid anyway

      // External forces
      float forceDistance = length(gl_FragCoord.xy - u_forceLocation.xy);
      float forceFactor = max(0.0, (u_forceLocation.z - forceDistance) / (u_forceLocation.z + 0.01));
      vec2 force = u_forceVector * forceFactor;

      // Feed dye, if requested
      float dye = clamp(c.w + u_feed * forceFactor, 0.0, 1.0);

      // Compute new (non divergence-free) velocity
      vec2 velocity = advection + pressure + force;

      // Pack
      state = vec4(velocity, c.z, dye);
    }
    `
  );

  // Second pass: apply a step of Jacobi method, to solve pressure equations
  const pass2Program = createProgram(
    `#version 300 es
    layout(location = 0) in vec2 pos;

    void main() {
      gl_Position = vec4(pos, 0.0, 1.0);
    }
    `,
    `#version 300 es
    precision highp float;

    uniform sampler2D u_texture;
    uniform vec2 u_resolution;

    out vec4 state;

    vec4 get(vec2 delta) {
      return texture(u_texture, (gl_FragCoord.xy + delta) / u_resolution);
    }

    void main() {

      // Fetch relevant values
      vec4 c = get(vec2( 0.0,  0.0));
      vec4 t = get(vec2( 0.0,  1.0));
      vec4 l = get(vec2(-1.0,  0.0));
      vec4 r = get(vec2( 1.0,  0.0));
      vec4 b = get(vec2( 0.0, -1.0));

      // Estimate pressure
      float density = 1.0;
      float pressure = (r.z + l.z + t.z + b.z - (r.x - l.x + t.y - b.y) / 2.0) / 4.0;

      // Pack
      state = vec4(c.xy, pressure, c.w);
    }
    `
  );

  // Third pass: compute final velocity and advect dye
  const pass3Program = createProgram(
    `#version 300 es
    layout(location = 0) in vec2 pos;

    void main() {
      gl_Position = vec4(pos, 0.0, 1.0);
    }
    `,
    `#version 300 es
    precision highp float;

    uniform sampler2D u_texture;
    uniform vec2 u_resolution;

    out vec4 state;

    vec4 get(vec2 delta) {
      return texture(u_texture, (gl_FragCoord.xy + delta) / u_resolution);
    }

    void main() {

      // Fetch relevant values
      vec4 c = get(vec2( 0.0,  0.0));
      vec4 t = get(vec2( 0.0,  1.0));
      vec4 l = get(vec2(-1.0,  0.0));
      vec4 r = get(vec2( 1.0,  0.0));
      vec4 b = get(vec2( 0.0, -1.0));

      // Compute divergence-free velocity.
      vec2 velocity = c.xy - 0.5 * vec2(r.z - l.z, t.z - b.z);

      // Advect dye
      float dye = get(-velocity).w;

      // Pack
      state = vec4(velocity, c.z, dye);
    }
    `
  );

  // Render pass: show ink
  const renderProgram = createProgram(
    `#version 300 es
    layout(location = 0) in vec2 pos;

    void main() {
      gl_Position = vec4(pos, 0.0, 1.0);
    }
    `,
    `#version 300 es
    precision highp float;

    uniform sampler2D u_texture;
    uniform vec2 u_resolution;
    uniform int u_mode;

    out vec4 color;

    vec4 get(vec2 delta) {
      return texture(u_texture, (gl_FragCoord.xy + delta) / u_resolution);
    }

    void main() {
      vec4 c = get(vec2(0.0, 0.0));
      if (u_mode == 1)
        color = vec4(c.xyz + 0.5, 1.0);
      else
        color = vec4(c.www + c.xyz * 0.1, 1.0);
    }
    `
  );

  // We will create two sets of textures, and swap at each operation
  let current = 0;

  // Create textures and associated framebuffers
  const textures = [];
  const framebuffers = [];
  for (let i = 0; i < 2; ++i) {
    gl.activeTexture(gl.TEXTURE0 + i);
    let texture = createFloatTexture(gl.canvas.width, gl.canvas.height);
    let framebuffer = createFramebuffer(texture);
    textures.push(texture);
    framebuffers.push(framebuffer);
  }

  // Create vertex buffer object with a single quad
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1.0, -1.0,
    1.0, -1.0,
    -1.0, 1.0,
    1.0, 1.0
  ]), gl.STATIC_DRAW);

  // Create vertex array object
  const vertexArray = gl.createVertexArray();
  gl.bindVertexArray(vertexArray);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Cursor status
  let cursorMode = -1;
  let cursorCurrentLocation = null;
  let cursorPreviousLocation = null;
  let cursorVelocity = null;
  let renderMode = 0;

  // Prevent context menu
  canvas.oncontextmenu = (e) => {
    if (e.button == 2) {
      e.preventDefault();
    }
  };

  // Keep track of mouse events
  canvas.onmousedown = (e) => {
    e.preventDefault();
    cursorMode = e.button;
    cursorCurrentLocation = {x: e.offsetX, y: canvas.height - e.offsetY};
  };
  canvas.onmousemove = (e) => {
    e.preventDefault();
    if (cursorMode >= 0) {
      cursorCurrentLocation = {x: e.offsetX, y: canvas.height - e.offsetY};
    }
  };
  canvas.onmouseup = canvas.onmouseleave = (e) => {
    e.preventDefault();
    cursorMode = -1;
    cursorCurrentLocation = null;
    cursorPreviousLocation = null;
  };

  // React to spacebar
  // TODO should handle properly if there are more than one simulations
  window.onkeydown = (e) => {
    if (e.key == "m") {
      renderMode ^= 1;
      console.log("Switch to mode " + renderMode);
    }
  };

  // Executed at every frame
  const update = () => {
    const dt = 1000.0 / 60.0;

    // Update mouse tracker
    let forceLocation = {x: 0.0, y: 0.0, radius: 0.0};
    let forceVector = {x: 0.0, y: 0.0};
    let feed = 0.0;
    if (cursorMode >= 0) {
      if (cursorPreviousLocation == null)
        cursorPreviousLocation = cursorCurrentLocation;
      if (cursorVelocity == null)
        cursorVelocity = {x: 0.0, y: 0.0};
      if (cursorPreviousLocation != null) {
        let dx = cursorCurrentLocation.x - cursorPreviousLocation.x;
        let dy = cursorCurrentLocation.y - cursorPreviousLocation.y;
        let vx = cursorVelocity.x * 0.5 + (dx / dt) * 0.5;
        let vy = cursorVelocity.y * 0.5 + (dy / dt) * 0.5;
        cursorVelocity = {x: vx, y: vy};
      }

      forceLocation.x = cursorCurrentLocation.x;
      forceLocation.y = cursorCurrentLocation.y;
      forceLocation.radius = 16.0;

      switch (cursorMode) {

      // Left button to add dye
      case 0:
        forceVector.x = cursorVelocity.x * 4.0;
        forceVector.y = cursorVelocity.y * 4.0;
        break;

      // Right button to apply force
      case 2:
        feed = 1.0;
        break;
      }

      cursorPreviousLocation = cursorCurrentLocation;
    }

    // Clear
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Compute non-divergence-free velocity
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers[current ^ 1]);
    gl.useProgram(pass1Program);
    gl.uniform1i(gl.getUniformLocation(pass1Program, "u_texture"), current);
    gl.uniform2f(gl.getUniformLocation(pass1Program, "u_resolution"), gl.canvas.width, gl.canvas.height);
    gl.uniform3f(gl.getUniformLocation(pass1Program, "u_forceLocation"), forceLocation.x, forceLocation.y, forceLocation.radius);
    gl.uniform2f(gl.getUniformLocation(pass1Program, "u_forceVector"), forceVector.x, forceVector.y);
    gl.uniform1f(gl.getUniformLocation(pass1Program, "u_feed"), feed);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    current ^= 1;

    // Apply a few optimization steps
    for (let i = 0; i < 10; ++i) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers[current ^ 1]);
      gl.useProgram(pass2Program);
      gl.uniform1i(gl.getUniformLocation(pass2Program, "u_texture"), current);
      gl.uniform2f(gl.getUniformLocation(pass2Program, "u_resolution"), gl.canvas.width, gl.canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      current ^= 1;
    }

    // Compute divergence-free velocity and advect dye
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers[current ^ 1]);
    gl.useProgram(pass3Program);
    gl.uniform1i(gl.getUniformLocation(pass3Program, "u_texture"), current);
    gl.uniform2f(gl.getUniformLocation(pass3Program, "u_resolution"), gl.canvas.width, gl.canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    current ^= 1;

    // Draw current state to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(renderProgram);
    gl.uniform1i(gl.getUniformLocation(renderProgram, "u_texture"), current);
    gl.uniform2f(gl.getUniformLocation(renderProgram, "u_resolution"), gl.canvas.width, gl.canvas.height);
    gl.uniform1i(gl.getUniformLocation(renderProgram, "u_mode"), renderMode);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Schedule next step
    window.setTimeout(update, dt);
    // TODO maybe use window.requestAnimationFrame?
  };

  // Start infinite loop
  update();
};
