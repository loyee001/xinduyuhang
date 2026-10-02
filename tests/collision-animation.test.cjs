'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const road = require('../dist/road.js');
const source = fs.readFileSync(path.join(__dirname,'../dist/simulator.js'),'utf8');

function loadRenderer(backend='canvas',dimensions={width:390,height:300}) {
  const painted = [], buffers = new Map(), uniforms = new Map(), shaderSources = [],listeners=new Map(),glCalls=[];
  let points = [], boundBuffer = null, bufferCount = 0;
  const point = (x,y)=>{assert.ok(Number.isFinite(x)&&Number.isFinite(y));points.push([x,y]);};
  const context2d = {createLinearGradient:()=>({addColorStop(){}}),fillRect(){painted.length=0;},
    beginPath(){points=[];},moveTo:point,lineTo:point,closePath(){},
    fill(){painted.push({color:this.fillStyle,points:[...points]});}};
  const gl = new Proxy({
    BLEND:101,DEPTH_TEST:102,SRC_ALPHA:103,ONE_MINUS_SRC_ALPHA:104,
    enable(value){glCalls.push(['enable',value]);},disable(value){glCalls.push(['disable',value]);},depthMask(value){glCalls.push(['depthMask',value]);},
    createShader:()=>({}),shaderSource(shader,text){shaderSources.push(text);},getShaderParameter:()=>true,
    createProgram:()=>({}),getProgramParameter:()=>true,getAttribLocation:()=>0,getUniformLocation:(_,name)=>name,
    createBuffer:()=>({id:++bufferCount}),bindBuffer(_,buffer){boundBuffer=buffer;},
    bufferData(_,data){buffers.set(boundBuffer,new Float32Array(data));},
    uniform1f(name,...values){uniforms.set(name,values);},uniform2f(name,...values){uniforms.set(name,values);},
    uniform3f(name,...values){uniforms.set(name,values);},uniform4f(name,...values){uniforms.set(name,values);},
    isContextLost:()=>false,
  },{get(target,key){return key in target?target[key]:typeof key==='string'&&key===key.toUpperCase()?1:()=>{};}});
  const canvas = {width:0,height:0,getContext:type=>type==='webgl'?(backend==='webgl'?gl:null):context2d,
    getBoundingClientRect:()=>({...dimensions}),addEventListener(){},removeEventListener(){}};
  const window = {RoverRoad:road,devicePixelRatio:1,addEventListener(name,handler){listeners.set(name,handler);},removeEventListener(){}};
  vm.runInNewContext(source,{window,performance:{now:()=>0}});
  return {api:window.RoverSimulator,canvas,painted,buffers,uniforms,shaderSources,glCalls,resize:()=>listeners.get('resize')?.()};
}
const effect = overrides=>({elapsed:0,duration:1.2,flightTime:.8,peakHeight:.8,pitchDeg:10,rollDeg:-7,...overrides});
const pose = overrides=>({x:0,y:2000,heading:0,gear:'forward',traffic:[],roadSigns:[],...overrides});
const close = (actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} ≈ ${expected}`);
function tightlyPackedTrucks(heading=0) {
  const angle=heading*Math.PI/180,sin=Math.sin(angle),cos=Math.cos(angle);
  return [[0,-6.4],[0,6.4],[-3.75,0],[3.75,0],[-3.75,9],[3.75,-9]].map(([x,z],index)=>({
    id:index+1,kind:'truck',color:'#ead260',width:2.35,length:8.3,direction:1,heading,
    x:x*cos+z*sin,y:1894-x*sin+z*cos}));
}
function roofPixelIsVisible(renderer,camera,heading=0) {
  const yaw=heading*Math.PI/180,x=-.1*Math.sin(yaw),z=1894-.1*Math.cos(yaw);
  const angle=camera.stats.cameraHeading*Math.PI/180,dx=x-camera.stats.cameraX,dz=z-camera.stats.cameraY;
  const side=dx*Math.cos(angle)-dz*Math.sin(angle),flat=dx*Math.sin(angle)+dz*Math.cos(angle),dy=1.46-camera.stats.cameraHeight;
  const pitch=camera.stats.cameraPitch,vertical=dy*Math.cos(pitch)+flat*Math.sin(pitch),depth=flat*Math.cos(pitch)-dy*Math.sin(pitch);
  const px=195+side*222/depth,py=135-vertical*222/depth;
  const covers=points=>{
    let inside=false;
    for(let i=0,j=points.length-1;i<points.length;j=i++) {
      const [ax,ay]=points[i],[bx,by]=points[j];
      if((ay>py)!==(by>py)&&px<(bx-ax)*(py-ay)/(by-ay)+ax)inside=!inside;
    }
    return inside;
  };
  const top=renderer.painted.findLast(face=>covers(face.points));
  const color=top?.color.match(/\d+/g).map(Number);
  return color&&color[0]>180&&color[1]>color[0]&&color[2]<160;
}

test('collision motion follows a bounded parabola and never rebounds after landing',()=>{
  const {api}=loadRenderer();
  const start=api.sampleCollisionEffect(effect()), peak=api.sampleCollisionEffect(effect({elapsed:.4}));
  assert.equal(start.height,0);assert.equal(start.pitch,0);assert.equal(start.roll,0);
  close(peak.height,.8);close(peak.pitch,10);close(peak.roll,-7);
  close(api.sampleCollisionEffect(effect({elapsed:.2})).height,api.sampleCollisionEffect(effect({elapsed:.6})).height);
  const landed=api.sampleCollisionEffect(effect({elapsed:.8}));
  close(landed.height,0);close(landed.pitch,0);close(landed.roll,0);
  for(let elapsed=.8;elapsed<1.2;elapsed+=.01) {
    const state=api.sampleCollisionEffect(effect({elapsed}));
    assert.equal(state.height,0);assert.equal(state.pitch,0);assert.equal(state.roll,0);
  }
  const end=api.sampleCollisionEffect(effect({elapsed:1.2}));
  assert.equal(end.height,0);assert.equal(end.pitch,0);assert.equal(end.roll,0);assert.equal(end.phase,'settled');
});

test('collision sampling rejects exaggerated or invalid movement and settles short effects',()=>{
  const {api}=loadRenderer();
  for(const fields of [{peakHeight:99,pitchDeg:999,rollDeg:-999},{duration:NaN,flightTime:Infinity,peakHeight:NaN},
    {duration:.1,flightTime:5,peakHeight:-1},{duration:3,flightTime:.1,pitchDeg:-99,rollDeg:99}]) {
    for(let elapsed=0;elapsed<=3;elapsed+=.03) {
      const state=api.sampleCollisionEffect(effect({...fields,elapsed}));
      assert.ok(Number.isFinite(state.height)&&Number.isFinite(state.pitch)&&Number.isFinite(state.roll));
      assert.ok(state.height>=0&&state.height<=4);
      assert.ok(Math.abs(state.pitch)<=12&&Math.abs(state.roll)<=9);
    }
  }
  assert.equal(api.sampleCollisionEffect(effect({duration:.1,flightTime:2,elapsed:.1})).height,0);
});

test('reduced motion keeps the collision car level and grounded at every timestamp',()=>{
  const {api}=loadRenderer();
  for(const elapsed of [0,.2,.4,.8,1,1.2,20]) {
    const state=api.sampleCollisionEffect(effect({elapsed,reducedMotion:true}));
    assert.equal(state.height,0);assert.equal(state.pitch,0);assert.equal(state.roll,0);
  }
});

test('Canvas renders the self car in an elevated fixed chase view without changing physical poses',()=>{
  const renderer=loadRenderer(), camera=renderer.api.createCamera(renderer.canvas);
  const input=pose({collisionEffect:effect(),traffic:[{id:1,kind:'car',color:'#ffffff',x:3.75,y:2012,heading:0,direction:1,width:1.85,length:4.5}]});
  const before=JSON.stringify(input);
  camera.draw(input);
  assert.equal(JSON.stringify(input),before,'rendering never mutates the ego, NPC or effect');
  assert.equal(camera.stats.selfVisible,true);assert.ok(camera.stats.cameraHeight>=3.7);
  assert.ok(camera.stats.cameraPitch>0);assert.equal(camera.stats.collisionHeight,0);
  const bodyPixels=()=>renderer.painted.filter(face=>{
    const channels=face.color.match(/\d+/g).map(Number);return channels[0]>180&&channels[1]>channels[0]&&channels[2]<160;
  }).flatMap(face=>face.points);
  const grounded=bodyPixels();assert.ok(grounded.length>30,'the visible self car has a real colored body');
  const averageY=points=>points.reduce((sum,p)=>sum+p[1],0)/points.length;
  camera.draw({...input,collisionEffect:effect({elapsed:.4})});
  const airborne=bodyPixels();assert.ok(airborne.length>30);
  assert.ok(averageY(airborne)<averageY(grounded)-7,'the real body moves upward on the screen');
  close(camera.stats.collisionHeight,.8);
  camera.draw({...input,collisionEffect:effect({elapsed:1.2})});
  assert.equal(camera.stats.collisionHeight,0);assert.equal(camera.stats.collisionPitch,0);assert.equal(camera.stats.collisionRoll,0);
  camera.draw(pose());
  assert.equal(camera.stats.selfVisible,false);assert.equal(camera.stats.cameraHeight,1.25);assert.equal(camera.stats.cameraPitch,0);
  camera.dispose();
});

test('WebGL receives transformed body vertices, a grounded shadow and the same chase camera projection',()=>{
  const renderer=loadRenderer('webgl'),camera=renderer.api.createCamera(renderer.canvas);
  const input=pose({x:3.75,heading:13,collisionEffect:effect({elapsed:.4})}),before=JSON.stringify(input);
  camera.draw(input);
  assert.equal(JSON.stringify(input),before);
  assert.equal(camera.stats.backend,'WebGL');assert.equal(camera.stats.selfVisible,true);
  const cameraUniform=renderer.uniforms.get('uCamera');
  close(cameraUniform[0],camera.stats.cameraHeight);close(cameraUniform[1],Math.sin(camera.stats.cameraPitch));close(cameraUniform[2],Math.cos(camera.stats.cameraPitch));
  assert.ok(renderer.shaderSources[0].includes('flatDepth*uCamera.z-d.y*uCamera.y'));
  const dynamic=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===3)[1];
  assert.ok(dynamic.length>1000);
  const heights=[];for(let i=1;i<dynamic.length;i+=7)heights.push(dynamic[i]);
  assert.ok(heights.some(y=>Math.abs(y-.032)<1e-6),'the shadow stays on the road');
  assert.ok(Math.max(...heights)>2,'the body vertices are raised above their resting height');
  assert.ok(heights.every(y=>y>=.03),'the car does not rotate below the road');
  const airborneCamera=renderer.uniforms.get('uPose');
  camera.draw({...input,collisionEffect:effect({elapsed:1.2})});
  assert.deepEqual(renderer.uniforms.get('uPose'),airborneCamera,'the chase view stays fixed throughout the motion');
  camera.draw(pose({gear:'reverse'}));
  assert.equal(camera.stats.cameraHeading,180);assert.deepEqual(renderer.uniforms.get('uCamera'),[1.25,0,1]);
  camera.dispose();
});

test('collision views work after reverse travel and on an ordinary road across origin changes',()=>{
  const renderer=loadRenderer(),camera=renderer.api.createCamera(renderer.canvas);
  for(const location of [pose({y:-400,gear:'reverse'}),pose({x:29,y:6000,localRoad:true,gear:'reverse'})]) {
    camera.draw({...location,collisionEffect:effect({elapsed:.4})});
    assert.equal(camera.stats.selfVisible,true);assert.ok(camera.stats.cameraHeight>=3.7);
    assert.equal(camera.stats.worldOrigin,Math.floor(location.y/400)*400);
    assert.equal(camera.stats.roadType,location.localRoad?'local':'highway');
    assert.ok(Math.abs(camera.stats.cameraHeading)>90,'the outside view follows the reverse viewing direction');
  }
  camera.dispose();
});

test('small and maximum impacts keep the car mesh above the pavement throughout flight and landing',()=>{
  const renderer=loadRenderer('webgl'),camera=renderer.api.createCamera(renderer.canvas);
  for(const peakHeight of [0,.05,.2,.6,1,1.8,3.8,4]) for(const elapsed of [0,.04,.2,.4,.6,.76,.8,.9,1,1.2]) {
    camera.draw(pose({collisionEffect:effect({peakHeight,elapsed,pitchDeg:-12,rollDeg:9})}));
    const dynamic=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===3)[1];
    for(let i=1;i<dynamic.length;i+=7)
      assert.ok(dynamic[i]>=.03,`body and shadow remain above the asphalt at height ${peakHeight}, time ${elapsed}`);
  }
  camera.dispose();
});

test('front and rear touching trucks cannot conceal the collision car in forward or reverse views',()=>{
  const renderer=loadRenderer(),camera=renderer.api.createCamera(renderer.canvas);
  for(const gear of ['forward','reverse']) {
    const traffic=tightlyPackedTrucks(),input=pose({y:1894,gear,traffic,collisionEffect:effect()});
    const before=JSON.stringify(traffic);
    camera.draw(input);
    assert.equal(camera.stats.collisionViewClear,true);
    assert.notEqual(camera.stats.collisionViewCandidate,0,'the occluded default camera is replaced');
    assert.ok(camera.stats.cameraHeight>3.7,'packed trucks receive a higher outside view');
    assert.ok(roofPixelIsVisible(renderer,camera),'the self roof remains visible after every NPC has actually been painted');
    assert.ok(camera.stats.visibleTraffic>=4,'nearby blocking trucks remain in the scene');
    assert.equal(JSON.stringify(traffic),before);
  }
  camera.dispose();
});

test('the selected unobstructed collision camera stays fixed through flight, landing and replay',()=>{
  const renderer=loadRenderer('webgl'),camera=renderer.api.createCamera(renderer.canvas);
  const animation=effect(),input=pose({y:1894,gear:'reverse',traffic:tightlyPackedTrucks(),collisionEffect:animation});
  camera.draw(input);
  const initial=[camera.stats.cameraX,camera.stats.cameraY,camera.stats.cameraHeight,camera.stats.cameraHeading,camera.stats.cameraPitch];
  for(const elapsed of [.2,.4,.8,1.2,0,.4]) {
    animation.elapsed=elapsed;camera.draw(input);
    assert.deepEqual([camera.stats.cameraX,camera.stats.cameraY,camera.stats.cameraHeight,camera.stats.cameraHeading,camera.stats.cameraPitch],initial);
    assert.equal(camera.stats.collisionViewClear,true);
  }
  camera.dispose();
});

test('rotated truck bounds also select a clear view without erasing the collision obstacle',()=>{
  const renderer=loadRenderer(),camera=renderer.api.createCamera(renderer.canvas),heading=37;
  camera.draw(pose({y:1894,heading,gear:'reverse',traffic:tightlyPackedTrucks(heading),collisionEffect:effect({reducedMotion:true})}));
  assert.equal(camera.stats.collisionViewClear,true);
  assert.ok(roofPixelIsVisible(renderer,camera,heading));
  assert.ok(camera.stats.visibleTraffic>=4);
  assert.equal(camera.stats.collisionHeight,0);
  camera.dispose();
});

test('minimum and maximum full-car flights keep every body and shadow vertex inside a mobile viewport',()=>{
  const renderer=loadRenderer('webgl',{width:350,height:260}),camera=renderer.api.createCamera(renderer.canvas);
  for(const peakHeight of [1.8,3.8])for(const crowded of [false,true])for(const gear of ['forward','reverse']) {
    const flightTime=2*Math.sqrt(2*peakHeight/9.81),duration=flightTime+.4;
    const animation=effect({peakHeight,flightTime,duration,pitchDeg:12,rollDeg:-9});
    const input=pose({y:1894,gear,traffic:crowded?tightlyPackedTrucks():[],collisionEffect:animation});
    let peakWheelHeight=0,shadowVerified=false;
    for(const elapsed of [0,.1*flightTime,.25*flightTime,.5*flightTime,.75*flightTime,.9*flightTime,flightTime,flightTime+.2,duration]) {
      animation.elapsed=elapsed;camera.draw(input);
      const [camX,camZ,sinYaw,cosYaw]=renderer.uniforms.get('uPose');
      const [camHeight,sinPitch,cosPitch]=renderer.uniforms.get('uCamera');
      const data=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===3)[1];
      const self=data.subarray(data.length-camera.stats.selfVertexCount*7);
      assert.ok(self.length>1000,'complete self car geometry is present');
      const bodyHeights=[];
      for(let i=0;i<self.length;i+=7) {
        const x=self[i],height=self[i+1],z=self[i+2];
        const dx=x-camX,dz=z-camZ,dy=height-camHeight,flat=dx*sinYaw+dz*cosYaw;
        const depth=flat*cosPitch-dy*sinPitch;
        const screenX=175+(dx*cosYaw-dz*sinYaw)*260*.74/depth;
        const screenY=117-(dy*cosPitch+flat*sinPitch)*260*.74/depth;
        assert.ok(depth>.08&&screenX>=8&&screenX<=342&&screenY>=8&&screenY<=252,
          `whole car/shadow stays framed at ${peakHeight} m, ${gear}, crowded ${crowded}, time ${elapsed}: ${screenX}, ${screenY}`);
        if(Math.abs(height-.032)<1e-5)shadowVerified=true;
        else bodyHeights.push(height);
        assert.ok(self[i+3]>=0&&self[i+3]<=1&&self[i+4]>=0&&self[i+4]<=1&&self[i+5]>=0&&self[i+5]<=1,'shadow and body colors remain in range');
      }
      if(elapsed===.5*flightTime)peakWheelHeight=Math.min(...bodyHeights);
      if(crowded)assert.equal(camera.stats.collisionViewClear,true,`clear view at ${peakHeight}m, ${gear}`);
    }
    assert.ok(peakWheelHeight>peakHeight-.6,'all four wheels leave the road with the whole body');
    assert.equal(shadowVerified,true,'grounded shadow remains visible throughout the flight');
  }
  camera.dispose();
});

test('rotating the same collision into a narrow portrait viewport reframes the complete flight',()=>{
  const dimensions={width:700,height:350},renderer=loadRenderer('webgl',dimensions),camera=renderer.api.createCamera(renderer.canvas);
  const animation=effect({peakHeight:3.8,flightTime:1.76,duration:2.16}),input=pose({y:1894,gear:'reverse',traffic:tightlyPackedTrucks(),collisionEffect:animation});
  camera.draw(input);
  const wideCamera=[camera.stats.cameraX,camera.stats.cameraY,camera.stats.cameraHeight];
  Object.assign(dimensions,{width:260,height:700});renderer.resize();
  let portraitCamera;
  for(const elapsed of [0,.44,.88,1.32,1.76,2.16]) {
    animation.elapsed=elapsed;camera.draw(input);
    const current=[camera.stats.cameraX,camera.stats.cameraY,camera.stats.cameraHeight];
    if(portraitCamera)assert.deepEqual(current,portraitCamera,'the reframed animation remains fixed');
    else {portraitCamera=current;assert.notDeepEqual(current,wideCamera,'rotation triggers a new fit');}
    const [camX,camZ,sinYaw,cosYaw]=renderer.uniforms.get('uPose'),[camHeight,sinPitch,cosPitch]=renderer.uniforms.get('uCamera');
    const data=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===3)[1],self=data.subarray(data.length-camera.stats.selfVertexCount*7);
    for(let i=0;i<self.length;i+=7) {
      const dx=self[i]-camX,dz=self[i+2]-camZ,dy=self[i+1]-camHeight,flat=dx*sinYaw+dz*cosYaw,depth=flat*cosPitch-dy*sinPitch;
      const px=130+(dx*cosYaw-dz*sinYaw)*700*.74/depth,py=315-(dy*cosPitch+flat*sinPitch)*700*.74/depth;
      assert.ok(depth>.08&&px>=8&&px<=252&&py>=8&&py<=692,`narrow viewport contains all body and shadow vertices at ${elapsed}: ${px},${py}`);
    }
    assert.equal(camera.stats.collisionViewClear,true);
  }
  camera.dispose();
});

const movingEffect=overrides=>{const peakHeight=1.8,flightTime=2*Math.sqrt(2*peakHeight/9.81),slideTime=.8,smokeDwell=1.2;
  return effect({peakHeight,flightTime,slideTime,smokeDwell,duration:flightTime+slideTime+smokeDwell,launchSpeed:8,travelHeading:0,...overrides});};
test('forward momentum decelerates continuously through flight and sliding then retains its final offset',()=>{
  const {api}=loadRenderer(),animation=movingEffect(),sample=t=>api.sampleCollisionEffect({...animation,elapsed:t});
  let previousDistance=0,previousSpeed=Infinity;
  for(let t=0;t<=animation.duration+.05;t+=.01) {
    const current=sample(t);
    assert.ok(current.travelDistance>=previousDistance-1e-8);
    assert.ok(current.travelSpeed<=previousSpeed+1e-8);
    if(t>=animation.flightTime)assert.equal(current.height,0,'ground contact never becomes a spring bounce');
    previousDistance=current.travelDistance;previousSpeed=current.travelSpeed;
  }
  close(sample(animation.flightTime).travelSpeed,8*.65);
  for(const boundary of [animation.flightTime,animation.flightTime+animation.slideTime,animation.duration]) {
    close(sample(boundary-1e-6).travelDistance,sample(boundary+1e-6).travelDistance,.00002);
    close(sample(boundary-1e-6).travelSpeed,sample(boundary+1e-6).travelSpeed,.00002);
  }
  const end=sample(animation.duration);
  close(end.travelDistance,8*animation.flightTime*.825+8*.65*animation.slideTime/2);
  assert.ok(end.travelDistance>9);assert.equal(end.travelSpeed,0);assert.equal(end.phase,'settled');
  close(sample(999).travelDistance,end.travelDistance);
  assert.equal(sample(animation.flightTime+.1).phase,'sliding');
  assert.equal(sample(animation.flightTime+animation.slideTime+.1).phase,'smoking');
  const slow=api.sampleCollisionEffect(movingEffect({launchSpeed:0,elapsed:99}));
  assert.equal(slow.travelDistance,0);assert.equal(slow.travelSpeed,0);
});

test('the chase camera translates with forward or reverse flight without modifying the physical car',()=>{
  const renderer=loadRenderer('webgl'),camera=renderer.api.createCamera(renderer.canvas);
  for(const travelHeading of [0,180,47]) {
    const animation=movingEffect({travelHeading}),input=pose({y:1997,heading:travelHeading===47?47:0,gear:travelHeading===180?'reverse':'forward',collisionEffect:animation});
    camera.draw(input);const first=[camera.stats.cameraX,camera.stats.cameraY],original=[input.x,input.y,input.heading];
    for(const elapsed of [animation.flightTime*.5,animation.flightTime,animation.duration,0]) {
      animation.elapsed=elapsed;camera.draw(input);
      const sample=renderer.api.sampleCollisionEffect(animation),angle=travelHeading*Math.PI/180;
      close(camera.stats.collisionVisualX,input.x+Math.sin(angle)*sample.travelDistance);
      close(camera.stats.collisionVisualY,input.y+Math.cos(angle)*sample.travelDistance);
      close(camera.stats.cameraX-first[0],Math.sin(angle)*sample.travelDistance);
      close(camera.stats.cameraY-first[1],Math.cos(angle)*sample.travelDistance);
      assert.deepEqual([input.x,input.y,input.heading],original);
    }
  }
  camera.dispose();
});

test('damage crumples the impacted panel while transparent engine smoke keeps ordinary depth occlusion',()=>{
  const renderer=loadRenderer('webgl'),camera=renderer.api.createCamera(renderer.canvas),extents={};
  for(const impactEnd of ['front','rear']) {
    camera.draw(pose({y:1894,collisionEffect:movingEffect({launchSpeed:0,elapsed:99,impactEnd})}));
    const data=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===3)[1],body=data.subarray(data.length-camera.stats.selfVertexCount*7);
    const zs=[];for(let i=0;i<body.length;i+=7)if(body[i+1]>.3&&body[i+1]<1.4)zs.push(body[i+2]);
    extents[impactEnd]=[Math.min(...zs),Math.max(...zs)];
    const smoke=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===5)[1];
    assert.equal(camera.stats.smokeParticleCount,8);assert.ok(camera.stats.collisionDamage>.5);
    assert.ok(smoke.length>1000);
    const xs=[],smokeZ=[];for(let i=0;i<smoke.length;i+=7) {
      xs.push(smoke[i]);smokeZ.push(smoke[i+2]);
      assert.ok(smoke[i+6]<0&&smoke[i+6]>-1,'smoke carries translucent alpha instead of an opaque vehicle material');
    }
    assert.ok(smokeZ.reduce((sum,z)=>sum+z,0)/smokeZ.length>1894-camera.stats.worldOrigin,'smoke originates in the front engine area even after a rear impact');
    assert.ok(Math.max(...xs)-Math.min(...xs)>1,'the gray plume spreads enough to be visible');
  }
  assert.ok(extents.front[1]<extents.rear[1]-.2,'front impact compresses the nose');
  assert.ok(extents.rear[0]>extents.front[0]+.2,'reverse impact compresses the rear');
  const blend=renderer.glCalls.findIndex(call=>call[0]==='enable'&&call[1]===101);
  assert.ok(renderer.glCalls.slice(0,blend).some(call=>call[0]==='enable'&&call[1]===102));
  assert.ok(renderer.glCalls.some(call=>call[0]==='depthMask'&&call[1]===false));
  assert.deepEqual(renderer.glCalls.at(-1),['disable',101]);
  camera.dispose();
});

test('reduced motion preserves a damaged smoky still without translating or changing the plume',()=>{
  const renderer=loadRenderer('webgl'),camera=renderer.api.createCamera(renderer.canvas),animation=movingEffect({reducedMotion:true});
  let previousSmoke;
  for(const elapsed of [0,.7,2,10]) {
    animation.elapsed=elapsed;camera.draw(pose({y:1894,collisionEffect:animation}));
    assert.equal(camera.stats.collisionVisualY,1894);assert.equal(camera.stats.collisionHeight,0);
    assert.equal(camera.stats.collisionTravelDistance,0);assert.equal(camera.stats.collisionDamage,1);assert.equal(camera.stats.collisionSmoke,1);
    const smoke=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===5)[1];
    if(previousSmoke)assert.deepEqual(smoke,previousSmoke);previousSmoke=smoke;
  }
  camera.dispose();
});

test('a contacted truck is pushed only within available room and both final offsets replay deterministically',()=>{
  const renderer=loadRenderer('webgl'),camera=renderer.api.createCamera(renderer.canvas);
  for(const blocked of [false,true]) {
    const contact={id:701,kind:'truck',color:'#4488cc',x:0,y:1887.6,width:2.35,length:8.3,heading:0,direction:1};
    const traffic=[contact,...(blocked?[{...contact,id:702,color:'#ead260',y:1877}]:[])],before=JSON.stringify(traffic);
    const animation=movingEffect({launchSpeed:2.75,travelHeading:180,slideTime:.35,contactVehicleId:701,impactEnd:'rear'});
    const input=pose({y:1894,gear:'reverse',traffic,collisionEffect:animation});
    camera.draw(input);animation.elapsed=99;camera.draw(input);
    const finalDistance=camera.stats.collisionTravelDistance,shift=camera.stats.collisionContactShift;
    assert.ok(finalDistance>0);close(shift,finalDistance);
    if(blocked) {assert.equal(camera.stats.collisionTravelLimited,true);assert.ok(shift<=2.180001);}
    else {assert.equal(camera.stats.collisionTravelLimited,false);assert.ok(shift>2.8);}
    const data=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===3)[1],truckZ=[];
    for(let i=0;i<data.length;i+=7)if(data[i+3]>.1&&Math.abs(data[i+4]-2*data[i+3])<.001&&Math.abs(data[i+5]-3*data[i+3])<.001)truckZ.push(data[i+2]+camera.stats.worldOrigin);
    assert.ok(truckZ.length>0);assert.ok(Math.max(...truckZ)<1887.6+4.2-shift+.05,'the actual truck mesh is pushed with its shadow');
    assert.equal(JSON.stringify(traffic),before);
    animation.elapsed=0;camera.draw(input);assert.equal(camera.stats.collisionContactShift,0);
    animation.elapsed=99;camera.draw(input);close(camera.stats.collisionContactShift,shift);
    close(camera.stats.collisionTravelDistance,finalDistance);
  }
  camera.dispose();
});

test('a truck is still displaced when the sliding interval crosses it but the final car has already passed it',()=>{
  const renderer=loadRenderer('webgl'),camera=renderer.api.createCamera(renderer.canvas);
  const peakHeight=3.0916667,flightTime=2*Math.sqrt(2*peakHeight/9.81),launchSpeed=8.525,slideTime=launchSpeed*.65/7;
  const truck={id:88,kind:'truck',color:'#4488cc',x:0,y:1900.4,width:2.35,length:8.3,heading:0,direction:1};
  const animation=movingEffect({peakHeight,flightTime,launchSpeed,slideTime,duration:flightTime+slideTime+1.2,contactVehicleId:88});
  const input=pose({y:1894,traffic:[truck],collisionEffect:animation});
  assert.ok(renderer.api.sampleCollisionEffect({...animation,elapsed:99}).travelDistance>12.8,'the final location alone would miss this overlap');
  for(const elapsed of [flightTime,flightTime+slideTime*.25,flightTime+slideTime*.5,flightTime+slideTime,animation.duration]) {
    animation.elapsed=elapsed;camera.draw(input);
    const playerFront=camera.stats.collisionVisualY+2.25;
    const truckRear=truck.y+camera.stats.collisionContactShift-4.15;
    assert.ok(playerFront<=truckRear+.000001,'the entire grounded slide stays outside the truck');
    assert.ok(camera.stats.collisionContactShift>0);
  }
  assert.equal(truck.y,1900.4);
  camera.dispose();
});

test('mobile framing includes the moving damaged body, grounded shadow and full gray plume',()=>{
  const renderer=loadRenderer('webgl',{width:350,height:260}),camera=renderer.api.createCamera(renderer.canvas);
  for(const peakHeight of [1.8,3.8])for(const travelHeading of [0,180]) {
    const flightTime=2*Math.sqrt(2*peakHeight/9.81),slideTime=1.6,animation=movingEffect({peakHeight,flightTime,slideTime,duration:flightTime+slideTime+1.2,launchSpeed:18,travelHeading});
    const input=pose({y:1992,gear:travelHeading===180?'reverse':'forward',collisionEffect:animation});
    for(const elapsed of [0,.25*flightTime,.5*flightTime,flightTime,flightTime+.8,animation.duration]) {
      animation.elapsed=elapsed;camera.draw(input);
      const [camX,camZ,sinYaw,cosYaw]=renderer.uniforms.get('uPose'),[camHeight,sinPitch,cosPitch]=renderer.uniforms.get('uCamera');
      const data=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===3)[1],self=data.subarray(data.length-camera.stats.selfVertexCount*7);
      const smoke=[...renderer.buffers.entries()].find(([buffer])=>buffer.id===5)[1];
      for(const vertices of [self,smoke])for(let i=0;i<vertices.length;i+=7) {
        const dx=vertices[i]-camX,dz=vertices[i+2]-camZ,dy=vertices[i+1]-camHeight,flat=dx*sinYaw+dz*cosYaw,depth=flat*cosPitch-dy*sinPitch;
        const px=175+(dx*cosYaw-dz*sinYaw)*260*.74/depth,py=117-(dy*cosPitch+flat*sinPitch)*260*.74/depth;
        assert.ok(depth>.08&&px>=8&&px<=342&&py>=8&&py<=252,`complete crash plume/body in frame: ${peakHeight}, ${travelHeading}, ${elapsed}: ${px}, ${py}`);
      }
    }
  }
  camera.dispose();
});
