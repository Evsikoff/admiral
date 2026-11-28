// Shared swell field. Distances and wave heights are in the board's world units.
function createSea(terrainTexture, boardTexture, chartTexture, sunDirection) {
  // x/z wave vector, amplitude, angular speed. The highest crest stays below an inactive field puck.
  const swells = [
    new THREE.Vector4(2.45, 1.08, 0.031, 1.67),
    new THREE.Vector4(-1.65, 3.50, 0.017, 2.14),
    new THREE.Vector4(5.10, -2.60, 0.009, 2.85),
    new THREE.Vector4(2.90, 8.30, 0.004, 3.51),
  ];
  function exposure(x, z) {
    const shore = sample(SD, x * PX + 750, z * PX + 750);
    return 0.26 + 0.74 * smooth(1, 38, -shore);
  }
  function height(x, z, time) {
    let y = 0;
    for (let i = 0; i < swells.length; i++) {
      const w = swells[i];
      const cross = (-x*w.y + z*w.x)*0.22 + 0.12*time + i*1.11;
      const phase = x*w.x + z*w.y - time*w.w + i*1.79 + 0.84*Math.sin(cross);
      y += w.z * Math.sin(phase);
    }
    return y * exposure(x, z);
  }

  const geo = new THREE.PlaneGeometry(30, 30, 168, 168);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, shelter = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) shelter[i] = exposure(pos.getX(i), pos.getZ(i));
  geo.setAttribute('exposure', new THREE.BufferAttribute(shelter, 1));

  // The oblique clip plane in Three's Reflector excludes the sea floor from the mirrored view.
  const reflectSize = window.innerWidth < 760 ? 256 : 512;
  const mirror = new Reflector(new THREE.PlaneGeometry(1,1), {textureWidth:reflectSize, textureHeight:reflectSize, multisample:0, clipBias:0.002});
  mirror.rotation.x = -Math.PI/2; mirror.updateMatrixWorld();
  mirror.getRenderTarget().texture.type = THREE.UnsignedByteType;
  mirror.camera.layers.set(1);
  // Add texture uniforms after cloning the light uniforms; terrain and the redrawn route chart stay shared.
  const uniforms = Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.lights), {
    uTime: { value: 0 }, uSwells: { value: swells }, uTerr: { value: terrainTexture },
    uBoard: { value: boardTexture }, uChart: { value: chartTexture }, uArt: { value: 0 },
    uSun: { value: sunDirection }, uBeacons: { value: NATIONS.map(() => new THREE.Vector4(100, 100, 1, 0)) },
    uDockLights: { value: NATIONS.map(() => new THREE.Vector2(100,100)) },
    uMirror: mirror.material.uniforms.tDiffuse, uMirrorMatrix: mirror.material.uniforms.textureMatrix,
    uShallows: { value: C('#65c6bc') }, uChannel: { value: C('#218b9b') }, uDeep: { value: C('#176480') },
  });
  const material = new THREE.ShaderMaterial({
    lights: true, transparent: true, extensions: { derivatives: true }, uniforms,
    vertexShader: /* glsl */`
      #include <common>
      #include <shadowmap_pars_vertex>
      attribute float exposure;
      uniform float uTime;
      uniform mat4 uMirrorMatrix;
      uniform vec4 uSwells[4];
      varying vec2 vUv, vSlope;
      varying vec3 vWorld;
      varying vec4 vMirror;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        float height = 0.0;
        vec2 slope = vec2(0.0);
        for (int i = 0; i < 4; i++) {
          vec4 w = uSwells[i];
          vec2 bendVector = vec2(-w.y,w.x) * 0.22;
          float crossPhase = dot(worldPosition.xz,bendVector) + 0.12*uTime + float(i)*1.11;
          float phase = dot(worldPosition.xz,w.xy) - uTime*w.w + float(i)*1.79 + 0.84*sin(crossPhase);
          height += w.z * sin(phase);
          slope += (w.xy + 0.84*cos(crossPhase)*bendVector) * (w.z*cos(phase));
        }
        worldPosition.y += height * exposure;
        vSlope = slope * exposure;
        vWorld = worldPosition.xyz; vUv = uv;
        vMirror = uMirrorMatrix * vec4(worldPosition.x, -worldPosition.z, worldPosition.y, 1.0);
        vec3 transformedNormal = mat3(viewMatrix) * normalize(vec3(-vSlope.x, 1.0, -vSlope.y));
        #include <shadowmap_vertex>
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <packing>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>
      uniform float uTime, uArt;
      uniform sampler2D uTerr, uBoard, uChart, uMirror;
      uniform vec3 uSun, uShallows, uChannel, uDeep;
      uniform vec4 uBeacons[4];
      uniform vec2 uDockLights[4];
      varying vec2 vUv, vSlope;
      varying vec3 vWorld;
      varying vec4 vMirror;

      float seaHash(vec2 cell) {
        vec3 v = fract(cell.xyx * vec3(0.1031,0.1030,0.0973));
        v += dot(v,v.yzx + 33.33);
        return fract((v.x+v.y)*v.z);
      }
      float seaNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f*f*(3.0-2.0*f);
        return mix(mix(seaHash(i),seaHash(i+vec2(1,0)),f.x),
                   mix(seaHash(i+vec2(0,1)),seaHash(i+vec2(1)),f.x),f.y);
      }
      void main() {
        vec2 p = vWorld.xz; float t = uTime;
        float offshore = (128.0 - texture2D(uTerr, vUv).r * 255.0) / 1.25;
        float depth = smoothstep(2.0, 82.0, offshore);
        float warp = seaNoise(p * 1.3 + vec2(t * 0.12, -t * 0.09));
        // Filter short ripples as the map recedes to avoid glittering pixels at board scale.
        float footprint = max(length(dFdx(p)), length(dFdy(p)));
        float detail = 1.0 - smoothstep(0.045, 0.24, footprint);
        vec2 ripple = vec2(0.74,0.53)*cos(dot(p, vec2(18.1,9.4)) - t*3.7 + warp*5.0)
                    + vec2(-0.37,0.82)*cos(dot(p, vec2(-11.3,23.4)) - t*4.6 - warp*4.0);
        vec3 N = normalize(vec3(-vSlope.x - ripple.x*0.047*detail, 1.0, -vSlope.y - ripple.y*0.047*detail));
        vec3 V = normalize(cameraPosition - vWorld), R = reflect(-V, N);
        vec3 H = normalize(V + uSun);
        vec3 bed = mix(uShallows, uChannel, smoothstep(0.0, 34.0, offshore));
        bed = mix(bed, uDeep, depth * (0.74 + 0.20*warp));
        // Folds in refracted light move over the shallow sea floor.
        vec2 rays = p * 9.0 + 2.0 * vec2(sin(p.y*3.0 + t*0.66), cos(p.x*2.6 - t*0.53));
        float web = abs(sin(rays.x + t*0.58) + 0.78*sin(rays.y - t*0.49));
        float caustic = (1.0-smoothstep(0.02,0.22,web)) * (1.0-smoothstep(7.0,42.0,offshore)) * detail;
        bed += vec3(0.055,0.115,0.071) * caustic;
        vec3 sky = mix(vec3(0.94,0.75,0.52), vec3(0.24,0.53,0.73), smoothstep(0.02,0.85,R.y));
        vec2 mirrorUV = vMirror.xy/vMirror.w + (mat3(viewMatrix)*vec3(N.x,0.0,N.z)).xy*0.027;
        vec4 coast = texture2D(uMirror,clamp(mirrorUV,0.002,0.998));
        vec2 edge = min(mirrorUV,1.0-mirrorUV);
        sky = mix(sky, coast.rgb, coast.a*smoothstep(0.0,0.025,min(edge.x,edge.y)));
        float fresnel = 0.075 + 0.79*pow(1.0-max(dot(N,V),0.0), 3.1);
        float shadow = getShadowMask();
        vec3 col = mix(bed*(0.83+0.24*dot(N,uSun)), sky, fresnel);
        col *= mix(vec3(0.57,0.69,0.76),vec3(1.0),shadow);
        float nh = max(dot(N,H),0.0);
        col += vec3(1.0,0.82,0.60) * (0.12*pow(nh,32.0) + (0.62+0.43*warp)*pow(nh,230.0)) * shadow;
        // Patchy surf rolls towards the actual shore. Space between the thin fronts remains transparent.
        float surfZone = (1.0-smoothstep(0.0,12.0,offshore))*smoothstep(-3.0,1.0,offshore);
        float front = abs(fract(offshore*0.14 + t*0.30 + warp*0.70)-0.48);
        float foam = surfZone * (1.0-smoothstep(0.035,0.18,front)) * (0.36+0.64*warp);
        col = mix(col,vec3(0.85,1.01,0.96),foam*0.82);
        for (int i=0; i<4; i++) {
          vec4 lamp = uBeacons[i]; vec2 d = p-lamp.xy;
          float along = dot(d,lamp.zw);
          float across = abs(dot(d,vec2(-lamp.w,lamp.z)) + ripple.x*0.06);
          float beam = smoothstep(0.0,0.5,along) * (1.0-smoothstep(0.7,4.5,along))
                     * (1.0-smoothstep(0.025,0.11+max(along,0.0)*0.095,across));
          col += vec3(0.52,0.28,0.08)*beam*(0.36+0.64*warp);
          vec2 dock = uDockLights[i]-p;
          vec3 toLantern = normalize(vec3(dock.x,0.65-vWorld.y,dock.y));
          float glint = pow(max(dot(reflect(-toLantern,N),V),0.0),22.0);
          col += vec3(0.94,0.52,0.15)*(0.045+glint)/(1.0+10.0*dot(dock,dock));
        }
        float alpha = mix(0.66,0.97,smoothstep(0.0,38.0,offshore));
        if (uArt > 0.5) { col = texture2D(uBoard,vUv).rgb; alpha = 0.97; }
        gl_FragColor = vec4(col,alpha);
        #include <tonemapping_fragment>
        vec4 ink = texture2D(uChart,vUv);
        float combined = mix(alpha,1.0,ink.a);
        gl_FragColor = vec4(mix(gl_FragColor.rgb, ink.rgb, ink.a/combined), combined);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'Sea'; mesh.receiveShadow = true; mesh.renderOrder = 1;

  function reflect(subjects) {
    for (const root of subjects) root.traverse(obj => {
      if (obj.isMesh && (!obj.material.transparent || obj.material.alphaTest > 0)) obj.layers.enable(1);
    });
    scene.traverse(obj => { if (obj.isLight) obj.layers.enable(1); });
    let lastTime = -Infinity;
    const lastPosition = new THREE.Vector3();
    return function refresh(time, camera) {
      if (time-lastTime < 0.18 && lastPosition.distanceToSquared(camera.position)<2.25) return;
      camera.updateMatrixWorld();
      mirror.onBeforeRender(renderer,scene,camera);
      lastTime=time; lastPosition.copy(camera.position);
    };
  }
  return { mesh, height, reflect, time: uniforms.uTime, beacons: uniforms.uBeacons.value, dockLights: uniforms.uDockLights.value,
    maxHeight: swells.reduce((sum, w) => sum + w.z, 0) };
}

function floatShip(s, sea, time, dt) {
  const { x, y, z } = s.obj.position;
  const c = Math.cos(s.heading), n = Math.sin(s.heading);
  const length = 0.37 * SHIP_SCALE, beam = 0.145 * SHIP_SCALE;
  const bow = sea.height(x + c*length, z - n*length, time), stern = sea.height(x - c*length, z + n*length, time);
  const port = sea.height(x - n*beam, z - c*beam, time), starboard = sea.height(x + n*beam, z + c*beam, time);
  // On a courtyard or at the top of a capture/repair hop the hull loses contact with the swell.
  const afloat = 1 - smooth(PUCK_TOP + 0.025, COURT_H - 0.09, y);
  const response = 1 - Math.exp(-dt * (s.state === 'ok' ? 7.8 : 4.2));
  const heave = (bow + stern + port + starboard) * 0.25 * afloat / SHIP_SCALE;
  s.model.position.y = lerp(s.model.position.y, heave, response);
  s.model.rotation.z = lerp(s.model.rotation.z, afloat * Math.atan2(bow - stern, 2*length), response);
  s.model.rotation.x = lerp(s.model.rotation.x, afloat * Math.atan2(port - starboard, 2*beam), response);
}

// Each wake stores points in world space, so the stern leaves a curved trail when the ship turns.
function createWake(sea, material) {
  const count = 28, lifetime = 1.45, trail = [];
  const positions = new Float32Array(count * 4 * 3), colors = new Float32Array(count * 4 * 4), indices = [];
  colors.fill(1);
  for (let i = 0; i < count-1; i++) for (const start of [0, 2]) {
    const a = i*4 + start;
    indices.push(a,a+1,a+4, a+1,a+5,a+4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color',new THREE.BufferAttribute(colors,4).setUsage(THREE.DynamicDrawUsage));
  const mesh = new THREE.Mesh(geo,material);
  mesh.name = 'Stern wake'; mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 2;
  scene.add(mesh);
  function clear() { trail.length = 0; mesh.visible = false; }
  function update(ship, time) {
    if (!ship.obj.visible) trail.length = 0;
    while (trail.length && time-trail[0].t >= lifetime) trail.shift();
    if (ship.obj.visible && ship.state === 'ok' && ship.anim?.turn && ship.anim.started) {
      const c = Math.cos(ship.heading), n = Math.sin(ship.heading);
      const x = ship.obj.position.x - 0.36*c, z = ship.obj.position.z + 0.36*n;
      const last = trail[trail.length-1];
      if (last && Math.hypot(x-last.x,z-last.z) > 1.3) trail.length = 0;
      if (!trail.length || Math.hypot(x-last.x,z-last.z) > 0.095) {
        if (trail.length === count) trail.shift();
        trail.push({ x, z, n, c, t: time });
      }
    }
    mesh.visible = trail.length >= 2;
    if (!mesh.visible) return;
    trail.forEach((p,i) => {
      const age = (time-p.t)/lifetime;
      for (let j=0; j<4; j++) {
        const width = (j<2 ? -1 : 1)*(0.075 + age*0.48 + (j%2)*(0.035 + age*0.055));
        const x = p.x + p.n*width, z = p.z + p.c*width, k=i*4+j;
        positions[3*k] = x; positions[3*k+1] = sea.height(x,z,time)+0.009; positions[3*k+2] = z;
        colors[4*k+3] = (j%2 ? 0.12 : 0.62)*(1-age)*(1-age);
      }
    });
    geo.setDrawRange(0, (trail.length-1)*12);
    geo.attributes.position.needsUpdate = geo.attributes.color.needsUpdate = true;
  }
  return { update, clear };
}
