/* Meter-scale highway renderer. Pose x/y maps to world X/Z; heading is
   clockwise from +Z. Static scenery repeats every 400 m; traffic and speed
   signs keep absolute positions and are rebased by the same render origin. */
(() => {
  'use strict';

  const ROAD = Object.freeze({ laneWidth: 3.75, lanes: 3, halfWidth: 5.625, shoulderEdge: 7.1, guardrail: 7.4, cameraHeight: 1.25, repeat: 400, far: 1500 });
  const bounds = Object.freeze({ left: -ROAD.guardrail, right: ROAD.guardrail, back: -Infinity, front: Infinity });
  const obstacles = Object.freeze([]);
  const NEAR = .08, FOCAL = 1.48, HORIZON = .45;
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const COLORS = {
    grass: rgb('#91a877'), verge: rgb('#b6b39a'), road: rgb('#515961'), shoulder: rgb('#626a70'),
    paint: rgb('#f6f4db'), steel: rgb('#b1bcc0'), steelDark: rgb('#687a80'), green: rgb('#22705c'),
    amber: rgb('#f5bb51'), red: rgb('#f06456'), white: rgb('#f0f5ee'), dark: rgb('#354448'),
    hills: rgb('#709580'), hillsFar: rgb('#97b4a2')
  };

  // Separate ground, road, paint and object layers also give the Canvas 2D
  // fallback correct occlusion without sorting a giant ground plane over signs.
  function mesh() { return { vertices: [], faces: [] }; }
  function polygon(target, points, color, layer = 3, material = 0, shade = 1) {
    const tint = color.map(value => Math.min(1, value * shade));
    let x = 0, z = 0;
    for (const point of points) { x += point[0]; z += point[2]; }
    x /= points.length; z /= points.length;
    const radius = Math.max(...points.map(point => Math.hypot(point[0] - x, point[2] - z)));
    target.faces.push({ points, color: tint, layer, material, x, z, radius });
    for (let i = 1; i < points.length - 1; i++) {
      for (const index of [0, i, i + 1]) target.vertices.push(...points[index], ...tint, material);
    }
  }
  function ground(target, x1, x2, z1, z2, height, color, layer = 1, material = 0) {
    polygon(target, [[x1,height,z1],[x2,height,z1],[x2,height,z2],[x1,height,z2]], color, layer, material);
  }
  function box(target, x, y, z, width, height, depth, color, layer = 3) {
    const l = x - width / 2, r = x + width / 2, n = z - depth / 2, f = z + depth / 2, t = y + height;
    polygon(target, [[l,y,n],[r,y,n],[r,t,n],[l,t,n]], color, layer, 0, .87);
    polygon(target, [[r,y,f],[l,y,f],[l,t,f],[r,t,f]], color, layer, 0, .94);
    polygon(target, [[l,y,f],[l,y,n],[l,t,n],[l,t,f]], color, layer, 0, .73);
    polygon(target, [[r,y,n],[r,y,f],[r,t,f],[r,t,n]], color, layer, 0, .82);
    polygon(target, [[l,t,n],[r,t,n],[r,t,f],[l,t,f]], color, layer, 0, 1.08);
  }
  function hill(target, x, z, width, depth, height, color) {
    const peak = [x + width * .08, height, z];
    const ring = [[x-width/2,-.1,z-depth/2],[x+width/2,-.1,z-depth/2],[x+width*.55,-.1,z+depth*.45],[x-width*.4,-.1,z+depth/2]];
    for (let i = 0; i < 4; i++) polygon(target, [ring[i], ring[(i+1)%4], peak], color, 0, 0, [.93,1,.86,.8][i]);
  }

  // Small vector lettering stays sharp on both backends and needs no textures,
  // fonts, image downloads or external graphics dependencies.
  const FONT = {
    'A':['01110','10001','10001','11111','10001','10001','10001'],
    'G':['01111','10000','10000','10111','10001','10001','01110'],
    'H':['10001','10001','10001','11111','10001','10001','10001'],
    'I':['111','010','010','010','010','010','111'],
    'W':['10001','10001','10001','10101','10101','10101','01010'],
    'Y':['10001','10001','01010','00100','00100','00100','00100'],
    '0':['01110','10001','10011','10101','11001','10001','01110'],
    '1':['010','110','010','010','010','010','111'],
    '2':['01110','10001','00001','00010','00100','01000','11111'],
    '6':['01110','10000','10000','11110','10001','10001','01110'],
    '8':['01110','10001','10001','01110','10001','10001','01110']
  };
  function lettering(target, text, centerX, bottom, z, height, color = COLORS.white) {
    const pixel = height / 7;
    const width = [...text].reduce((sum, character) => sum + (FONT[character]?.[0].length || 3) + 1, -1) * pixel;
    let left = centerX - width / 2;
    for (const character of text) {
      const glyph = FONT[character];
      if (glyph) glyph.forEach((row, r) => [...row].forEach((value, c) => {
        if (value === '1') {
          const x = left + c * pixel, y = bottom + (6 - r) * pixel;
          polygon(target, [[x,y,z],[x+pixel*.94,y,z],[x+pixel*.94,y+pixel*.94,z],[x,y+pixel*.94,z]], color);
        }
      }));
      left += ((glyph?.[0].length || 3) + 1) * pixel;
    }
  }
  function gantry(target, z) {
    for (const x of [-8.3,8.3]) {
      box(target,x,0,z,.34,7.3,.34,COLORS.steelDark);
      box(target,x,0,z,.75,.3,.75,COLORS.steel);
    }
    box(target,0,7,z,16.9,.28,.38,COLORS.steel);
    box(target,0,5.75,z,10.8,1.65,.18,COLORS.green);
    const front = z - .1;
    // A pale border, route badge, highway name and one arrow per lane.
    box(target,0,5.81,front,10.62,.035,.015,COLORS.white);
    box(target,0,7.3,front,10.62,.035,.015,COLORS.white);
    for (const x of [-5.3,5.3]) box(target,x,5.82,front,.035,1.5,.015,COLORS.white);
    lettering(target,'HIGHWAY',0,6.7,front-.025,.42);
    lettering(target,'G60',-4.45,6.88,front-.025,.22);
    for (const x of [-3.75,0,3.75]) {
      polygon(target,[[x-.055,6.04,front-.03],[x+.055,6.04,front-.03],[x+.055,6.42,front-.03],[x-.055,6.42,front-.03]],COLORS.white);
      polygon(target,[[x-.23,6.29,front-.03],[x,6.55,front-.03],[x,6.38,front-.03]],COLORS.white);
      polygon(target,[[x,6.38,front-.03],[x,6.55,front-.03],[x+.23,6.29,front-.03]],COLORS.white);
    }
  }

  function buildHighway() {
    const target = mesh();
    const start = -1600, end = 2000;
    // Short ground strips preserve fog and perspective near the horizon.
    for (let z = start; z < end; z += 50) {
      ground(target,-2000,2000,z,z+50,-.07,COLORS.grass,0);
      ground(target,-9.5,9.5,z,z+50,-.015,COLORS.verge,0);
      ground(target,-ROAD.shoulderEdge,ROAD.shoulderEdge,z,z+50,0,COLORS.shoulder,1,1);
      ground(target,-ROAD.halfWidth,ROAD.halfWidth,z,z+50,.003,COLORS.road,1,1);
      for (const x of [-ROAD.halfWidth,ROAD.halfWidth]) ground(target,x-.085,x+.085,z,z+50,.012,COLORS.paint,2);
      // A parallel opposing carriageway, beyond the planted central reservation.
      ground(target,-29.1,-14.9,z,z+50,0,COLORS.shoulder,1,1);
      ground(target,-27.625,-16.375,z,z+50,.003,COLORS.road,1,1);
      for (const x of [-27.625,-16.375]) ground(target,x-.08,x+.08,z,z+50,.012,COLORS.paint,2);
      for (const x of [-7.4,7.4,-14.6,-29.4]) {
        box(target,x,0,z+25,.34,.37,50,COLORS.steelDark);
        box(target,x,.62,z+25,.13,.23,50,COLORS.steel);
        box(target,x,.6,z+25,.14,.045,50,COLORS.steelDark);
      }
    }
    for (let z = start; z < end; z += 16) {
      for (const x of [-1.875,1.875,-20.125,-23.875]) ground(target,x-.075,x+.075,z,z+6,.014,COLORS.paint,2);
    }
    for (let z = start; z < end; z += 12.5) {
      for (const x of [-7.4,7.4]) box(target,x,0,z,.12,.77,.13,COLORS.steelDark);
    }
    for (let z = start; z < end; z += 50) {
      for (const x of [-8.2,8.2]) {
        box(target,x,0,z,.16,1.05,.16,COLORS.white);
        box(target,x,.65,z-.09,.18,.27,.02,COLORS.dark);
        box(target,x,.72,z-.105,.09,.11,.022,x < 0 ? COLORS.amber : COLORS.red);
      }
      // Rumble-strip insets along the hard shoulder provide near-field motion.
      for (const x of [-6,6]) for (let dz = 0; dz < 50; dz += 5) ground(target,x-.17,x+.17,z+dz,z+dz+.16,.008,COLORS.steelDark,2);
    }
    for (let z = start; z < end; z += ROAD.repeat) {
      gantry(target,z+200);
      hill(target,480,z+150,670,470,120,COLORS.hillsFar);
      hill(target,-520,z+290,660,500,155,COLORS.hillsFar);
      hill(target,310,z+65,340,290,72,COLORS.hills);
      hill(target,-355,z+310,320,310,91,COLORS.hills);
      // Low roadside planting, kept well outside the driving surface.
      for (const [x,dz,h] of [[24,45,5],[-41,135,6],[34,280,4.4],[-43,340,5.5]]) {
        box(target,x,0,z+dz,.22,h*.58,.22,COLORS.dark);
        hill(target,x,z+dz,4.5,4.5,h,COLORS.hills);
      }
    }
    target.data = new Float32Array(target.vertices);
    target.vertices = null;
    return target;
  }
  const highway = buildHighway();

  const vehicleTemplates = new Map();
  function buildVehicleTemplate(vehicle, detail) {
    const key = `${vehicle.kind}-${vehicle.color}-${detail}`;
    if (vehicleTemplates.has(key)) return vehicleTemplates.get(key);
    const target = mesh(), truck = vehicle.kind === 'truck';
    const body = rgb(vehicle.color), glass = rgb('#264454'), tyres = rgb('#20292c');
    const metal = rgb('#a0adb0'), lamps = rgb('#fff0ba'), tail = rgb('#e74637');
    // Local +Z is the nose. The complete template is turned 180 degrees for
    // opposing traffic, including windscreens, cab, lamps and wheel positions.
    ground(target,-vehicle.width*.57,vehicle.width*.57,-vehicle.length*.52,vehicle.length*.52,.023,rgb('#384245'),2);
    if (truck) {
      box(target,0,.46,0,2.12,.4,8.2,tyres);
      box(target,0,.87,-1.05,2.35,2.34,6.2,body);
      box(target,0,.75,3,2.23,1.84,2.24,body);
      box(target,0,1.63,4.125,1.96,.65,.022,glass);
      box(target,0,.9,4.15,1.15,.3,.025,tyres);
      for (const side of [-1,1]) {
        box(target,side*1.12,1.66,3.24,.022,.59,1.22,glass);
        box(target,side*.88,.9,4.16,.39,.2,.025,lamps);
        box(target,side*.91,.9,-4.16,.29,.23,.025,tail);
      }
      if (detail) {
        for (const x of [-.91,0,.91]) box(target,x,.92,-4.165,.038,2.17,.02,metal);
        box(target,0,.81,-4.18,2.31,.075,.03,metal);
        box(target,0,.59,4.18,2.19,.18,.06,metal);
        for (const side of [-1,1]) box(target,side*1.26,1.92,3.81,.18,.32,.13,tyres);
      }
    } else {
      box(target,0,.39,0,1.85,.49,4.5,body);
      box(target,0,.84,1.64,1.8,.11,1.16,body);
      // A tapered roof and sloping windows give cars a readable silhouette.
      polygon(target,[[-.88,.86,-1.27],[.88,.86,-1.27],[.7,1.46,-.75],[-.7,1.46,-.75]],glass);
      polygon(target,[[.88,.86,1.11],[-.88,.86,1.11],[-.7,1.46,.51],[.7,1.46,.51]],glass);
      polygon(target,[[-.7,1.46,-.75],[.7,1.46,-.75],[.7,1.46,.51],[-.7,1.46,.51]],body,3,0,1.08);
      for (const side of [-1,1]) {
        polygon(target,[[side*.88,.9,-1.16],[side*.88,.9,1.02],[side*.71,1.43,.48],[side*.71,1.43,-.71]],glass,3,0,side < 0 ? .8 : 1);
        box(target,side*.65,.63,2.261,.42,.16,.025,lamps);
        box(target,side*.65,.63,-2.261,.43,.17,.025,tail);
        if (detail) {
          polygon(target,[[side*.889,.88,-.14],[side*.889,.88,-.02],[side*.712,1.445,-.02],[side*.712,1.445,-.14]],body);
          box(target,side*.98,.98,.68,.16,.12,.26,body);
        }
      }
      if (detail) {
        box(target,0,.46,2.27,1.72,.09,.04,metal);
        box(target,0,.46,-2.27,1.72,.09,.04,metal);
        box(target,0,.62,-2.282,.4,.14,.02,COLORS.white);
        box(target,0,.61,2.281,.64,.18,.02,tyres);
      }
    }
    const axles = truck ? [-2.95,-1.75,2.83] : [-1.4,1.38];
    const wheelRadius = truck ? .44 : .32;
    for (const z of axles) for (const side of [-1,1]) {
      const x = side*(vehicle.width/2-.065);
      box(target,x,.08,z,.21,wheelRadius*2,.67+(truck ? .18 : 0),tyres);
      if (detail) box(target,x+side*.111,.22,z,.014,wheelRadius*.9,wheelRadius*.9,metal);
    }
    vehicleTemplates.set(key,target);
    return target;
  }
  function disc(target,x,y,z,radius,color) {
    const points = [];
    for (let i=0;i<24;i++) { const angle = i*Math.PI/12; points.push([x+Math.cos(angle)*radius,y+Math.sin(angle)*radius,z]); }
    polygon(target,points,color);
  }
  function speedSign(target,sign,origin) {
    const x = 8.5, z = sign.y-origin;
    box(target,x,0,z,.12,3.6,.12,COLORS.steel);
    disc(target,x,3.55,z+.012,.88,COLORS.steelDark);
    disc(target,x,3.55,z-.02,.88,rgb('#d4493f'));
    disc(target,x,3.55,z-.028,.71,COLORS.white);
    lettering(target,String(sign.limitKmh),x,3.28,z-.035,.55,rgb('#26363b'));
  }
  function buildTraffic(pose,origin,stats) {
    const target = mesh(), sin = Math.sin(pose.heading*Math.PI/180), cos = Math.cos(pose.heading*Math.PI/180);
    stats.visibleTraffic = 0;
    for (const vehicle of pose.traffic || []) {
      if (![vehicle.x,vehicle.y].every(Number.isFinite)) continue;
      const dx = vehicle.x-pose.x, dz = vehicle.y-pose.y;
      const depth = dx*sin+dz*cos, side = dx*cos-dz*sin;
      const margin = vehicle.length || 8;
      if (depth+margin < NEAR || depth-margin > ROAD.far || Math.abs(side) > Math.max(12,depth*1.4)+margin) continue;
      stats.visibleTraffic++;
      const template = buildVehicleTemplate(vehicle,depth < 260);
      const direction = vehicle.direction < 0 ? -1 : 1, z = vehicle.y-origin;
      for (const face of template.faces) {
        const points = face.points.map(p => [vehicle.x+p[0]*direction,p[1],z+p[2]*direction]);
        polygon(target,points,face.color,face.layer,face.material);
      }
      if (vehicle.braking && depth < 130) {
        for (const side of [-1,1]) box(target,vehicle.x+side*vehicle.width*.34,.62,z-direction*(vehicle.length/2+.022),.4,.21,.024,rgb('#ff7155'));
      }
    }
    const signs = pose.roadSigns || window.RoverTraffic?.signsAround(pose.y) || [];
    for (const sign of signs) speedSign(target,sign,origin);
    return target;
  }

  // No road length limit: guardrails are the only collision boundaries.
  function canOccupy(x, y, radius = .9) {
    return Number.isFinite(x) && Number.isFinite(y) && x - radius > bounds.left && x + radius < bounds.right;
  }
  function rangeAhead(x, y, heading) {
    if (![x,y,heading].every(Number.isFinite)) return 0;
    if (x <= bounds.left || x >= bounds.right) return 0;
    const side = Math.sin(heading * Math.PI / 180);
    if (Math.abs(side) < 1e-7) return ROAD.far;
    return Math.max(0,Math.min(ROAD.far,((side > 0 ? bounds.right : bounds.left)-x)/side));
  }

  function buildBrakingGuide(pose, origin, stats) {
    const target = mesh();
    const anchor = pose.brakeAnchor;
    const anchored = anchor && [anchor.x,anchor.y,anchor.heading,anchor.distance].every(Number.isFinite);
    const distance = Math.max(0,anchored ? anchor.distance : Number(pose.brakePrediction) || 0);
    const heading = (anchored ? anchor.heading : pose.heading) * Math.PI / 180;
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const ax = anchored ? anchor.x : pose.x, az = (anchored ? anchor.y : pose.y) - origin;
    const travelled = anchored ? (pose.x-ax)*sin+(pose.y-origin-az)*cos : 0;
    const facingForward = Math.cos(pose.heading*Math.PI/180-heading) >= 0;
    const windowStart = travelled-(facingForward ? 2 : 1198);
    const start = Math.max(0,Math.min(Math.max(0,distance-1200),windowStart));
    const end = Math.min(distance,start+1200);
    stats.brakeClipped = distance > end;
    stats.brakeDistance = distance;
    if (distance < .12 || end < start) return target;
    function point(side, along, height = .034) { return [ax+sin*along+cos*side,height,az+cos*along-sin*side]; }
    function strip(left,right,from,to,color) { polygon(target,[point(left,from),point(right,from),point(right,to),point(left,to)],color,2); }
    const spacing = distance < 20 ? 2 : 8, dash = Math.min(spacing*.6,distance*.4);
    for (let d = Math.floor(start/spacing)*spacing; d < end; d += spacing) {
      const from = Math.max(start,d), to = Math.min(end,d+dash);
      if (to <= from) continue;
      strip(-1.08,-.96,from,to,COLORS.amber);
      strip(.96,1.08,from,to,COLORS.amber);
      if (d > 1) {
        const tip = Math.min(to,from+.6);
        polygon(target,[point(-.36,from),point(0,tip),point(0,from+.16)],COLORS.amber,2);
        polygon(target,[point(0,from+.16),point(0,tip),point(.36,from)],COLORS.amber,2);
      }
    }
    // The true projected endpoint alone gets a red stop line. A long estimate
    // clipped at 1200 m never gets a false endpoint at the visibility cap.
    if (!stats.brakeClipped && distance >= start) {
      strip(-1.7,1.7,Math.max(0,distance-.18),distance+.18,COLORS.red);
      for (const side of [-1.7,1.7]) {
        const p = point(side,distance);
        box(target,p[0],.035,p[2],.055,.7,.055,COLORS.red);
        box(target,p[0],.61,p[2],.19,.14,.055,COLORS.red);
      }
    }
    return target;
  }

  function createCamera(canvas) {
    let gl = null, context = null, program = null, staticBuffer = null, guideBuffer = null, trafficBuffer = null, skyBuffer = null;
    let width = 0, height = 0, frames = 0, totalFrames = 0, frameStart = performance.now(), disposed = false;
    let locations;
    const shaders = [];
    const stats = { backend: '', fps: 0, frames: 0, worldOrigin: 0, cameraHeight: ROAD.cameraHeight, brakeClipped: false, brakeDistance: 0, visibleTraffic: 0 };
    try { gl = canvas.getContext('webgl',{alpha:false,antialias:true,preserveDrawingBuffer:true,powerPreference:'low-power'}); } catch {}
    if (gl) {
      const compile = (type,source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader,source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        shaders.push(shader); return shader;
      };
      program = gl.createProgram();
      gl.attachShader(program,compile(gl.VERTEX_SHADER,`
        attribute vec3 aPosition; attribute vec3 aColor; attribute float aMaterial;
        uniform vec4 uPose; uniform mediump vec2 uSize; uniform mediump float uSky;
        varying mediump vec3 vColor; varying mediump float vDepth; varying mediump float vMaterial;
        void main(){
          vColor=aColor;vMaterial=aMaterial;
          if(uSky>.5){gl_Position=vec4(aPosition.xy,0.,1.);vDepth=0.;}
          else{
            vec3 d=aPosition-vec3(uPose.x,1.25,uPose.y);
            float side=d.x*uPose.w-d.z*uPose.z;
            float depth=d.x*uPose.z+d.z*uPose.w;
            gl_Position=vec4(side*1.48/(uSize.x/uSize.y),d.y*1.48+.1*depth,1.000107*depth-.160009,depth);
            vDepth=depth;
          }
        }`));
      gl.attachShader(program,compile(gl.FRAGMENT_SHADER,`
        precision mediump float;
        uniform mediump vec2 uSize; uniform mediump float uSky; uniform float uWet;
        varying mediump vec3 vColor; varying mediump float vDepth; varying mediump float vMaterial;
        void main(){
          if(uSky>.5){
            float h=gl_FragCoord.y/uSize.y;
            vec3 sky=mix(vec3(.83,.89,.88),vec3(.36,.65,.83),smoothstep(.45,1.,h));
            gl_FragColor=vec4(mix(sky,vec3(.67,.76,.79),uWet*.2),1.);
          }else{
            vec3 color=vColor;
            if(vMaterial>.5){
              color=mix(color,color*vec3(.72,.79,.86),uWet);
              color+=vec3(.07,.09,.11)*uWet*smoothstep(30.,400.,vDepth);
            }
            float fog=smoothstep(110.,1480.,vDepth)*.91;
            gl_FragColor=vec4(mix(color,vec3(.79,.86,.86),fog),1.);
          }
        }`));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(`Highway camera shader link failed: ${gl.getProgramInfoLog(program) || 'No WebGL linker log available'}`);
      gl.useProgram(program);
      locations = {
        position:gl.getAttribLocation(program,'aPosition'), color:gl.getAttribLocation(program,'aColor'), material:gl.getAttribLocation(program,'aMaterial'),
        pose:gl.getUniformLocation(program,'uPose'), size:gl.getUniformLocation(program,'uSize'), sky:gl.getUniformLocation(program,'uSky'), wet:gl.getUniformLocation(program,'uWet')
      };
      for (const key of ['position','color','material']) gl.enableVertexAttribArray(locations[key]);
      staticBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,staticBuffer); gl.bufferData(gl.ARRAY_BUFFER,highway.data,gl.STATIC_DRAW);
      guideBuffer = gl.createBuffer();
      trafficBuffer = gl.createBuffer();
      skyBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,skyBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,0,0,0,0,3,-1,0,0,0,0,0,-1,3,0,0,0,0,0]),gl.STATIC_DRAW);
      gl.disable(gl.CULL_FACE); gl.clearColor(.79,.86,.86,1);
      stats.backend = 'WebGL';
    } else {
      context = canvas.getContext('2d',{alpha:false});
      if (!context) throw new Error('Highway camera rendering unavailable');
      stats.backend = 'Canvas 2D';
    }
    function bind(buffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.vertexAttribPointer(locations.position,3,gl.FLOAT,false,28,0);
      gl.vertexAttribPointer(locations.color,3,gl.FLOAT,false,28,12);
      gl.vertexAttribPointer(locations.material,1,gl.FLOAT,false,28,24);
    }
    function resize() {
      const rect = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1,1.5);
      width = Math.max(1,Math.round(rect.width*ratio)); height = Math.max(1,Math.round(rect.height*ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      if (gl) gl.viewport(0,0,width,height);
    }
    function clipDepth(points, boundary, greater) {
      const clipped = [];
      for (let i = 0; i < points.length; i++) {
        const p = points[i], q = points[(i+1)%points.length];
        const pin = greater ? p[2] >= boundary : p[2] <= boundary, qin = greater ? q[2] >= boundary : q[2] <= boundary;
        if (pin) clipped.push(p);
        if (pin !== qin) {
          const t = (boundary-p[2])/(q[2]-p[2]);
          clipped.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t,boundary]);
        }
      }
      return clipped;
    }
    function softwareDraw(pose, localY, guide, traffic) {
      const angle = pose.heading*Math.PI/180, sin = Math.sin(angle), cos = Math.cos(angle), focal = height*FOCAL/2;
      const sky = context.createLinearGradient(0,0,0,height*.59);
      sky.addColorStop(0,pose.wet ? '#73a1b7' : '#5ca6d4'); sky.addColorStop(1,'#d4e3e0');
      context.fillStyle = sky; context.fillRect(0,0,width,height);
      const projected = [];
      for (const face of [...highway.faces,...guide.faces,...traffic.faces]) {
        const centerDepth = (face.x-pose.x)*sin+(face.z-localY)*cos;
        if (centerDepth+face.radius < NEAR || centerDepth-face.radius > ROAD.far) continue;
        let points = face.points.map(([x,y,z]) => { const dx = x-pose.x, dz = z-localY; return [dx*cos-dz*sin,y-ROAD.cameraHeight,dx*sin+dz*cos]; });
        points = clipDepth(clipDepth(points,NEAR,true),ROAD.far,false);
        if (points.length < 3) continue;
        const screen = points.map(p => [width/2+p[0]*focal/p[2],height*HORIZON-p[1]*focal/p[2]]);
        if (screen.every(p => p[0] < 0) || screen.every(p => p[0] > width) || screen.every(p => p[1] < 0) || screen.every(p => p[1] > height)) continue;
        const depth = points.reduce((sum,p) => sum+p[2],0)/points.length;
        projected.push({face,points:screen,depth});
      }
      projected.sort((a,b) => a.face.layer-b.face.layer || b.depth-a.depth);
      for (const entry of projected) {
        const t = Math.max(0,Math.min(1,(entry.depth-110)/1370)), fog = t*t*(3-2*t)*.91;
        const color = entry.face.color.map((value,i) => {
          if (entry.face.material && pose.wet) value *= [.72,.79,.86][i];
          return Math.round((value*(1-fog)+[.79,.86,.86][i]*fog)*255);
        });
        context.fillStyle = `rgb(${color.join(',')})`; context.beginPath();
        entry.points.forEach(([x,y],i) => i ? context.lineTo(x,y) : context.moveTo(x,y));
        context.closePath(); context.fill();
      }
    }
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    if (!observer) window.addEventListener('resize',resize);
    const lost = event => { event.preventDefault(); window.dispatchEvent(new CustomEvent('rover-camera-lost')); };
    const restored = () => window.dispatchEvent(new CustomEvent('rover-camera-lost'));
    canvas.addEventListener('webglcontextlost',lost); canvas.addEventListener('webglcontextrestored',restored);
    return {
      stats,
      draw(pose,now = performance.now()) {
        if (disposed || gl?.isContextLost() || ![pose.x,pose.y,pose.heading].every(Number.isFinite)) return false;
        const origin = Math.floor(pose.y/ROAD.repeat)*ROAD.repeat, localY = pose.y-origin;
        stats.worldOrigin = origin;
        const guide = buildBrakingGuide(pose,origin,stats);
        const traffic = buildTraffic(pose,origin,stats);
        if (gl) {
          gl.useProgram(program); gl.uniform2f(locations.size,width,height); gl.uniform1f(locations.wet,pose.wet ? 1 : 0);
          gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
          gl.disable(gl.DEPTH_TEST); gl.uniform1f(locations.sky,1); bind(skyBuffer); gl.drawArrays(gl.TRIANGLES,0,3);
          gl.enable(gl.DEPTH_TEST); gl.uniform1f(locations.sky,0);
          const angle = pose.heading*Math.PI/180;
          gl.uniform4f(locations.pose,pose.x,localY,Math.sin(angle),Math.cos(angle));
          bind(staticBuffer); gl.drawArrays(gl.TRIANGLES,0,highway.data.length/7);
          if (guide.vertices.length) {
            bind(guideBuffer); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(guide.vertices),gl.DYNAMIC_DRAW);
            gl.drawArrays(gl.TRIANGLES,0,guide.vertices.length/7);
          }
          if (traffic.vertices.length) {
            bind(trafficBuffer); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(traffic.vertices),gl.DYNAMIC_DRAW);
            gl.drawArrays(gl.TRIANGLES,0,traffic.vertices.length/7);
          }
        } else softwareDraw(pose,localY,guide,traffic);
        frames++; totalFrames++;
        if (now-frameStart >= 1000) { stats.fps = Math.round(frames*1000/(now-frameStart)); frameStart = now; frames = 0; }
        stats.frames = totalFrames;
        return true;
      },
      pause() { frames = 0; stats.fps = 0; frameStart = performance.now(); },
      dispose() {
        disposed = true; observer?.disconnect(); window.removeEventListener('resize',resize);
        canvas.removeEventListener('webglcontextlost',lost); canvas.removeEventListener('webglcontextrestored',restored);
        if (gl) { for (const buffer of [staticBuffer,guideBuffer,trafficBuffer,skyBuffer]) gl.deleteBuffer(buffer); for (const shader of shaders) gl.deleteShader(shader); gl.deleteProgram(program); }
      }
    };
  }
  window.RoverSimulator = Object.freeze({createCamera,canOccupy,rangeAhead,bounds,obstacles,road:ROAD});
})();
