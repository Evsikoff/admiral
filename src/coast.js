// Port architecture and shoreline scenery, placed in the coordinates of board.jpg.
function buildCoast(sea) {
  const ports = {
    ru: { town: [1004,1252,0],         light: [487,1308], pier: [353,1318],  yard: [109,1398,0.09],   paint: '#bd5541', roof: '#609487' },
    nl: { town: [316,650,-0.65],       light: [153,682],  pier: [163,273],   yard: [156,105,-1.33],   paint: '#a4513b', roof: '#984e3c' },
    en: { town: [487,252,Math.PI],     light: [1118,193], pier: [1218,168],  yard: [1422,102,3.02],   paint: '#685b54', roof: '#54677b' },
    se: { town: [1242,463,Math.PI/2],  light: [1373,783], pier: [1338,1178], yard: [1400,1421,1.28],  paint: '#537b79', roof: '#477b71' },
  };
  const group = new THREE.Group(); group.name = 'Ports and coast'; decor.add(group);
  const box = new THREE.BoxGeometry(1,1,1), drum = new THREE.CylinderGeometry(0.5,0.5,1,16);
  const taper = new THREE.CylinderGeometry(0.37,0.5,1,16), cone = new THREE.ConeGeometry(0.5,1,12);
  const pyramid = new THREE.ConeGeometry(0.70,1,4); pyramid.rotateY(Math.PI/4);
  const ball = new THREE.SphereGeometry(0.5,12,8), crag = new THREE.IcosahedronGeometry(0.5,0);
  const solid = new THREE.MeshStandardMaterial({ roughness: 0.83 });
  const metal = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.36 });
  const lens = new THREE.MeshBasicMaterial({ toneMapped: false });
  const ivory = '#eee1c0', trim = '#f3e5c9', stone = '#a59b89', oak = '#845937', iron = '#344a4d', gold = '#d9a64c';
  const batches = new Map(), palette = new Map(), dummy = new THREE.Object3D();
  const matKey = (geometry, material) => geometry.id + '/' + material.id;

  // Compose details in the building's own coordinates, then draw identical parts in one instanced mesh.
  function site(px, py, yaw = 0, level = heightAt(px,py)) {
    const origin = new THREE.Vector3(wx(px),level,wz(py));
    const frame = new THREE.Matrix4().makeRotationY(yaw).setPosition(origin);
    function part(geo, x,y,z, w,h,d, color, material=solid, rotationY=0, rotationZ=0) {
      dummy.position.set(x,y,z); dummy.scale.set(w,h,d); dummy.rotation.set(0,rotationY,rotationZ,'YXZ'); dummy.updateMatrix();
      const key = matKey(geo,material);
      if (!batches.has(key)) batches.set(key,{ geo, material, parts: [] });
      if (!palette.has(color)) palette.set(color,C(color));
      batches.get(key).parts.push([new THREE.Matrix4().multiplyMatrices(frame,dummy.matrix),palette.get(color)]);
    }
    function point(x,y,z) { return new THREE.Vector3(x,y,z).applyMatrix4(frame); }
    function collider(x,y,z,w,h,d,turn=0) {
      const p = point(x,y,z); collBox(p.x,p.y,p.z,w,h,d,yaw+turn);
    }
    return { part, point, collider, origin, yaw };
  }
  function foundation(px, py, yaw, width, depth) {
    const c=Math.cos(yaw), s=Math.sin(yaw), levels=[heightAt(px,py)];
    for (const x of [-width/2,0,width/2]) for (const z of [-depth/2,0,depth/2]) {
      levels.push(heightAt(px+(c*x+s*z)*PX, py+(-s*x+c*z)*PX));
    }
    const level=Math.max(...levels)+0.012, thickness=level-Math.min(...levels)+0.065;
    const base=site(px,py,yaw,level);
    base.part(box,0,-thickness/2,0,width,thickness,depth,'#cfc3ae',stoneMat);
    return base;
  }

  function roofGeometry(hip) {
    const g = new THREE.BufferGeometry(), vertices = [], uv = [];
    const a=[-0.5,0,-0.5], b=[0.5,0,-0.5], c=[0.5,0,0.5], d=[-0.5,0,0.5];
    const e=[-0.5+hip,1,0], f=[0.5-hip,1,0];
    for (const tri of [[a,e,b],[b,e,f],[d,c,e],[c,f,e],[a,d,e],[b,f,c]]) {
      const end = tri[0]===a && tri[1]===d || tri[0]===b && tri[1]===f && tri[2]===c;
      for (const v of tri) { vertices.push(...v); uv.push((end?v[2]:v[0])+0.5,v[1]); }
    }
    g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
    g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2)); g.computeVertexNormals();
    return g;
  }
  const gable = roofGeometry(0), hip = roofGeometry(0.22);
  const roofMap = canvasTex(128,(g,s) => {
    g.fillStyle='#fcf9f0'; g.fillRect(0,0,s,s);
    for (let row=0;row<10;row++) {
      const y=row*s/10;
      g.fillStyle='#c4c2b9'; g.fillRect(0,y,s,2);
      g.fillStyle='#e4e2db';
      for (let x=(row%2)*6; x<s; x+=13) g.fillRect(x,y+2,1,9);
    }
  });
  const tiles = new THREE.MeshStandardMaterial({ map: roofMap, roughness: 0.72 });

  const styles = {
    ru: ['#eabd80','#a6c3b2'], nl: ['#ac6953','#76544d'],
    en: ['#ece1c4','#c99576'], se: ['#dfb879','#b76753'],
  };
  function facadeBox(frontFace) {
    const geometry = new THREE.BoxGeometry(1,1,1);
    const uv = geometry.attributes.uv;
    for (let i=0; i<uv.count; i++) {
      const tile = Math.floor(i/4)===frontFace ? 0 : 1;
      uv.setX(i,(tile+0.008+0.984*uv.getX(i))/2);
    }
    return geometry;
  }
  const streetWall = facadeBox(4), endWall = facadeBox(0);
  const roofColors = {
    ru: ['#5a9184','#809995','#be6544'], nl: ['#a64f37','#754a40','#697676'],
    en: ['#666f7b','#854f40','#a96047'], se: ['#548778','#b26046','#62717c'],
  };
  function facade(q, variant) {
    const S = 192, face = document.createElement('canvas'), lit = document.createElement('canvas');
    face.width=lit.width=S*2; face.height=lit.height=S;
    const g=face.getContext('2d'), glow=lit.getContext('2d');
    glow.fillStyle='#000'; glow.fillRect(0,0,S*2,S);
    for (let side=0;side<2;side++) {
      g.save(); glow.save(); g.translate(side*S,0); glow.translate(side*S,0);
      g.fillStyle=styles[q][variant]; g.fillRect(0,0,S,S);
      if (q==='nl' || (q==='en' && variant)) {
        g.fillStyle='rgba(242,215,185,.21)';
        for (let y=0; y<S; y+=9) {
          g.fillRect(0,y,S,1);
          for (let x=(y%18?13:0); x<S; x+=26) g.fillRect(x,y,1,8);
        }
      } else if (q==='se') {
        g.fillStyle='rgba(96,51,36,.18)';
        for (let x=6; x<S; x+=12) g.fillRect(x,0,2,S);
      }
      g.fillStyle='#8b8474'; g.fillRect(0,172,S,20);
      const floors = q==='nl' && variant ? 3 : q==='se' && variant ? 1 : 2;
      const columns = side ? 2 : (q==='ru' && !variant ? 4 : 3);
      const stepY = 155/floors, stepX = 162/columns;
      g.fillStyle='#eadbc0'; g.fillRect(0,4,S,7);
      for (let row=1;row<floors;row++) g.fillRect(0,13+row*stepY,S,3);
      if (q==='en' && !variant) {
        g.strokeStyle='#594c41'; g.lineWidth=7; g.beginPath();
        for (const x of [4,65,127,188]) { g.moveTo(x,4); g.lineTo(x,172); }
        g.moveTo(0,91); g.lineTo(S,91); g.moveTo(5,13); g.lineTo(60,87);
        g.moveTo(185,13); g.lineTo(132,87); g.stroke();
      } else {
        g.fillStyle='#ebd9b7';
        for (let y=15; y<171; y+=19) { g.fillRect(0,y,9,12); g.fillRect(183,y,9,12); }
      }
      for (let row=0;row<floors;row++) for (let col=0;col<columns;col++) {
        const door=!side && row===floors-1 && col===Math.floor(columns/2);
        const w=stepX*(door && q==='nl'?0.78:0.48);
        const h=door?stepY*0.91:Math.min(65,stepY*0.60);
        const x=15+(col+0.5)*stepX-w/2, y=door?173-h:17+row*stepY+stepY*0.13;
        if (!door && (q==='se'||q==='ru' && variant)) {
          g.fillStyle=q==='se'?'#784b3b':'#577d70';
          for (const shutter of [x-12,x+w+2]) {
            g.fillRect(shutter,y,9,h);
            g.fillStyle='rgba(247,231,192,.38)';
            for (let sy=y+4;sy<y+h-2;sy+=6) g.fillRect(shutter+1,sy,7,1);
            g.fillStyle=q==='se'?'#784b3b':'#577d70';
          }
        }
        g.fillStyle='#e9d7b5'; g.fillRect(x-4,y-4,w+8,h+8);
        g.fillStyle=door?'#624834':'#384e54'; g.fillRect(x,y,w,h);
        if (door) {
          g.fillStyle='#927453'; g.fillRect(x+4,y+5,w-8,18);
          g.fillStyle='#e1b460'; g.fillRect(x+w-6,y+35,3,3);
        } else {
          const warm=(col+2*row+variant)%3===0;
          g.fillStyle=warm?'#efbc71':'#799095'; g.fillRect(x+3,y+3,w-6,h-6);
          if (warm) { glow.fillStyle='#eb9a42'; glow.fillRect(x+3,y+3,w-6,h-6); }
          for (const ctx of [g,glow]) {
            ctx.fillStyle=ctx===g?'#5b584e':'#000';
            ctx.fillRect(x+w/2-1,y,3,h); ctx.fillRect(x,y+h*0.46,w,3);
          }
          g.fillStyle='#f3dfbe'; g.fillRect(x-5,y+h,w+10,4);
        }
      }
      g.restore(); glow.restore();
    }
    const map=new THREE.CanvasTexture(face); map.colorSpace=THREE.SRGBColorSpace; map.anisotropy=maxAniso;
    const lightMap = new THREE.CanvasTexture(lit); lightMap.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({map, emissiveMap:lightMap, emissive:0xffdb9d, emissiveIntensity:0.53,roughness:0.87});
  }
  const fronts = Object.fromEntries(NATIONS.map(q=>[q,[facade(q,0),facade(q,1)]]));
  const pad = [];
  for (const [q,p] of Object.entries(ports)) {
    pad.push([...p.town.slice(0,2),q==='ru'?49:31], [...p.light,20], [...p.pier,27], [...p.yard.slice(0,2),40]);
  }
  const onPad = (px,py) => pad.some(([x,y,r])=>(px-x)**2+(py-y)**2<r*r);

  // Reserve each footprint so houses form readable blocks and vegetation does not grow through a roof.
  const lots = new Map(), lotSize=34;
  function nearby(px,py,r) {
    const gx=Math.floor(px/lotSize), gy=Math.floor(py/lotSize);
    for (let j=gy-1;j<=gy+1;j++) for (let i=gx-1;i<=gx+1;i++) {
      const group=lots.get(i+':'+j);
      if (group?.some(([x,y,rad])=>(px-x)**2+(py-y)**2<(rad+r)**2)) return true;
    }
    return false;
  }
  function sector(x,y) {
    if (Math.abs(x)>Math.abs(y)) return x>0?'se':'nl';
    return y>0?'ru':'en';
  }
  for (let gy=2;gy<TN-2;gy+=2) for (let gx=2;gx<TN-2;gx+=2) {
    const i=gy*TN+gx, density=TOWN[i];
    if (density<0.25 || SD[i]<7 || rnd()>0.30+0.47*density) continue;
    const px=gx*5+2.5+(rnd()-0.5)*7, py=gy*5+2.5+(rnd()-0.5)*7;
    if (nearKeepout(px,py) || onPad(px,py)) continue;
    const q=sector(wx(px),wz(py)), style=rnd()<0.5?0:1;
    const w=0.27+rnd()*0.24, d=0.19+rnd()*0.14;
    const storeys = q==='nl' && style ? 1.23 : q==='se' && style ? 0.72 : 1;
    const h=(0.20+density*0.13+rnd()*0.19)*storeys;
    const radius=PX*Math.hypot(w,d)*0.47;
    if (nearby(px,py,radius)) continue;
    const key=Math.floor(px/lotSize)+':'+Math.floor(py/lotSize);
    if (!lots.has(key)) lots.set(key,[]); lots.get(key).push([px,py,radius]);
    const dx=sample(SD,px-18,py)-sample(SD,px+18,py), dz=sample(SD,px,py-18)-sample(SD,px,py+18);
    const yaw=Math.round(Math.atan2(dx,dz)/(Math.PI/12))*(Math.PI/12)+(q==='nl'?Math.PI/2:0);
    const b=foundation(px,py,yaw,w*1.025,d*1.03), put=b.part, rh=0.12+rnd()*0.10, color=roofColors[q][Math.floor(rnd()*3)];
    put(q==='nl'?endWall:streetWall,0,h/2,0,w,h,d,style?'#f9eee1':'#ffffff',fronts[q][style]);
    put((q==='ru'||(q==='se'&&style))?hip:gable,0,h,0,w*1.09,rh,d*1.14,color,tiles);
    put(box,-w*0.24,h+rh*0.78,-d*0.15,0.048,rh*0.88,0.047,'#9c7057');
    if (q==='nl' && !style) { // stepped end gable
      for (let tier=0;tier<3;tier++) put(box,w*0.49,h+tier*rh/3,0,0.04,rh*0.38,d*(0.96-tier*0.26),'#b47960');
    } else if (w>0.39 && style===0) {
      put(box,w*0.15,h+rh*0.34,d*0.32,0.093,0.11,0.082,trim);
      put(box,w*0.15,h+rh*0.38,d*0.32+0.043,0.046,0.065,0.009,iron);
      put(gable,w*0.15,h+rh*0.34+0.056,d*0.32,0.11,0.062,0.12,color,tiles,Math.PI/2);
    }
    b.collider(0,(h+rh*0.55)/2,0,w,h+rh*0.55,d);
  }

  // The four shore landmarks follow silhouettes and locations on the printed chart.
  const rotors=[];
  const sailCloth=canvasTex(128,(g,S)=>{
    g.fillStyle='#68462f'; g.fillRect(0,0,12,S);
    g.fillStyle='#e5d5ac'; g.fillRect(16,0,77,98);
    g.strokeStyle='#865e3e'; g.lineWidth=5; g.strokeRect(11,2,112,123);
    for (let y=12;y<S;y+=20) g.fillRect(10,y,114,3);
    g.fillStyle='#765538'; g.fillRect(62,0,4,S);
  });
  const cloth=new THREE.MeshStandardMaterial({map:sailCloth,alphaTest:0.35,side:THREE.DoubleSide,roughness:1});
  const clockMap=canvasTex(160,(g,S)=>{
    const r=S/2; g.translate(r,r);
    g.fillStyle='#283d46'; g.beginPath(); g.arc(0,0,r-2,0,Math.PI*2); g.fill();
    g.strokeStyle='#dfbf72'; g.lineWidth=6; g.stroke();
    for (let i=0;i<12;i++) { g.save(); g.rotate(i*Math.PI/6); g.fillStyle='#f1d38d'; g.fillRect(-2,-r+10,4,i%3?9:14); g.restore(); }
    g.strokeStyle='#ffdf89'; g.lineCap='round'; g.lineWidth=6; g.beginPath(); g.moveTo(-r*0.39,-r*0.19); g.lineTo(0,0); g.lineTo(r*0.17,-r*0.61); g.stroke();
  });
  const dial=new THREE.MeshStandardMaterial({map:clockMap,emissive:0xffdda1,emissiveMap:clockMap,emissiveIntensity:0.25});
  const dialGeo=new THREE.CircleGeometry(0.5,24);
  {
    const b=foundation(...ports.ru.town,1.85,0.72), p=b.part;
    for (const side of [-1,1]) {
      p(streetWall,side*0.55,0.22,0,0.67,0.46,0.49,'#fff4df',fronts.ru[0]);
      p(hip,side*0.55,0.45,0,0.75,0.19,0.55,ports.ru.roof,tiles);
      b.collider(side*0.55,0.26,0,0.67,0.56,0.49);
    }
    p(box,0,0.28,0,0.53,0.6,0.62,'#d5ad69');
    for (const x of [-0.21,-0.07,0.07,0.21]) p(drum,x,0.29,0.34,0.049,0.51,0.049,trim);
    p(gable,0,0.56,0.30,0.18,0.17,0.59,ivory,solid,Math.PI/2);
    p(streetWall,0,0.78,0,0.34,0.42,0.34,ivory,fronts.ru[0]);
    p(box,0,1.00,0,0.39,0.07,0.39,trim); p(drum,0,1.16,0,0.21,0.28,0.21,ivory);
    p(ball,0,1.33,0,0.23,0.22,0.23,gold,metal);
    p(cone,0,1.77,0,0.12,0.83,0.12,gold,metal); p(ball,0,2.19,0,0.067,0.067,0.067,gold,metal);
    b.collider(0,0.57,0,0.52,1.15,0.61); const tip=b.point(0,1.64,0); collCyl(tip.x,tip.y,tip.z,0.012,0.105,1.02);
  }
  {
    const b=site(...ports.nl.town), p=b.part;
    p(taper,0,0.40,0,0.64,0.98,0.64,'#ab7357');
    p(drum,0,0.63,0,0.76,0.07,0.76,oak); p(drum,0,0.78,0,0.51,0.28,0.51,ivory);
    p(ball,0,0.96,0,0.59,0.44,0.59,'#494d49'); p(box,0,0.20,0.285,0.16,0.35,0.045,iron);
    for (let i=0;i<10;i++) {
      const a=i*Math.PI/5; p(box,0.34*Math.cos(a),0.71,0.34*Math.sin(a),0.025,0.15,0.025,oak);
    }
    const head=new THREE.Group(); head.position.copy(b.point(0,0.98,0.37)); head.rotation.y=b.yaw;
    const rotor=new THREE.Group(); head.add(rotor); group.add(head); rotors.push(rotor);
    const bladeGeo=new THREE.PlaneGeometry(0.15,0.62); bladeGeo.translate(0.055,0.36,0);
    for (let i=0;i<4;i++) { const blade=shadowy(new THREE.Mesh(bladeGeo,cloth)); blade.rotation.z=i*Math.PI/2; rotor.add(blade); }
    p(ball,0,0.98,0.38,0.13,0.13,0.12,gold,metal);
    collCyl(b.origin.x,b.origin.y+0.48,b.origin.z,0.24,0.32,1.06);
  }
  {
    const b=site(...ports.en.town), p=b.part;
    p(box,0,0.57,0,0.47,1.28,0.48,'#d0b78e');
    for (const y of [0.22,0.82,1.22]) p(box,0,y,0,0.54,0.066,0.55,trim);
    for (let i=0;i<4;i++) {
      const a=i*Math.PI/2; p(dialGeo,0.245*Math.sin(a),1.026,0.25*Math.cos(a),0.30,0.30,1,'#ffffff',dial,a);
      const x=i%2?0.21:-0.21, z=i<2?0.21:-0.21;
      p(box,x,0.69,z,0.085,1.42,0.085,ivory); p(cone,x,1.49,z,0.11,0.23,0.11,ports.en.roof);
    }
    p(pyramid,0,1.40,0,0.47,0.42,0.47,ports.en.roof,metal);
    p(cone,0,1.72,0,0.07,0.33,0.07,gold,metal);
    p(streetWall,-0.53,0.24,0,0.62,0.5,0.4,'#fff1dd',fronts.en[0]);
    p(gable,-0.53,0.49,0,0.68,0.26,0.48,'#89614c',tiles);
    b.collider(0,0.72,0,0.53,1.52,0.54); b.collider(-0.53,0.29,0,0.62,0.59,0.40);
  }
  {
    const b=site(...ports.se.town), p=b.part;
    p(streetWall,-0.22,0.22,0,0.86,0.50,0.45,'#fff8dc',fronts.se[0]);
    p(gable,-0.22,0.47,0,0.96,0.38,0.52,ports.se.roof,tiles);
    p(streetWall,0.28,0.50,0,0.39,1.08,0.39,'#fcf0d6',fronts.se[0]);
    p(box,0.28,1.02,0,0.46,0.07,0.46,trim);
    p(pyramid,0.28,1.20,0,0.50,0.31,0.50,ports.se.roof,metal);
    p(drum,0.28,1.43,0,0.17,0.23,0.17,iron);
    p(ball,0.28,1.57,0,0.24,0.19,0.24,ports.se.roof,metal);
    p(cone,0.28,1.87,0,0.16,0.60,0.16,ports.se.roof,metal); p(ball,0.28,2.18,0,0.055,0.055,0.055,gold,metal);
    b.collider(-0.22,0.34,0,0.88,0.74,0.46); b.collider(0.28,0.61,0,0.43,1.28,0.43);
    const tip=b.point(0.28,1.66,0); collCyl(tip.x,tip.y,tip.z,0.01,0.13,0.88);
  }

  const halos=canvasTex(96,(g,S)=>{
    const r=S/2, grad=g.createRadialGradient(r,r,0,r,r,r);
    grad.addColorStop(0,'rgba(255,251,218,1)'); grad.addColorStop(0.16,'rgba(255,216,131,.77)');
    grad.addColorStop(0.47,'rgba(255,183,78,.28)'); grad.addColorStop(1,'rgba(255,167,64,0)');
    g.fillStyle=grad; g.fillRect(0,0,S,S);
  });
  const beaconHeads=[];
  const beamGeo=new THREE.ConeGeometry(0.24,3.25,16,1,true);
  // UV.y is one at the lamp, zero at the far end. Tilt the shaft gently towards the water.
  beamGeo.rotateZ(Math.PI/2); beamGeo.translate(1.625,0,0);
  const beamMat=new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.FrontSide,
    vertexShader:'varying float fade; void main(){ fade=uv.y; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader:'varying float fade; void main(){ gl_FragColor=vec4(1.0,0.72,0.37,0.07*fade*fade); }',
  });
  for (const [i,q] of NATIONS.entries()) {
    const port=ports[q], b=site(...port.light), p=b.part;
    p(drum,0,0.005,0,0.49,0.22,0.49,stone); p(taper,0,0.51,0,0.36,0.96,0.36,'#f3e8cc');
    p(taper,0,0.46,0,0.329,0.17,0.329,port.paint); p(taper,0,0.76,0,0.306,0.11,0.306,port.paint);
    p(drum,0,1.02,0,0.43,0.09,0.43,iron);
    p(drum,0,1.16,0,0.20,0.21,0.20,'#ffe4a2',lens);
    for (let k=0;k<8;k++) {
      const a=k*Math.PI/4;
      p(box,0.17*Math.cos(a),1.11,0.17*Math.sin(a),0.018,0.15,0.018,iron);
      if (k%2===0) p(box,0.11*Math.cos(a),1.16,0.11*Math.sin(a),0.021,0.21,0.021,iron);
    }
    p(drum,0,1.27,0,0.34,0.055,0.34,iron); p(cone,0,1.37,0,0.36,0.17,0.36,port.roof,metal);
    p(ball,0,1.49,0,0.05,0.08,0.05,gold,metal);
    collCyl(b.origin.x,b.origin.y+0.61,b.origin.z,0.16,0.22,1.35);
    const head=new THREE.Group(); head.position.copy(b.point(0,1.16,0)); group.add(head);
    const beam=new THREE.Mesh(beamGeo,beamMat); beam.rotation.z=-0.22; beam.renderOrder=3; head.add(beam);
    const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:halos,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false}));
    halo.renderOrder=4; head.add(halo);
    const waterBeam=sea.beacons[i]; waterBeam.set(head.position.x,head.position.z,1,0);
    beaconHeads.push({head,halo,waterBeam,phase:i*1.83,rate:0.41+i*0.034});

    const [px,py]=port.pier;
    const dx=sample(SD,px-6,py)-sample(SD,px+6,py), dz=sample(SD,px,py-6)-sample(SD,px,py+6);
    const dock=site(px,py,Math.atan2(dx,dz),0.21), plank=dock.part;
    for (let j=0;j<12;j++) {
      plank(box,0,-0.04,j*0.090,0.39,0.073,0.085,j%3?'#a88058':'#99724e');
      if (j%4===1 || j===11) for (const side of [-1,1]) {
        plank(drum,side*0.18,-0.16,j*0.09,0.065,0.55,0.065,oak);
        plank(drum,side*0.18,0.065,j*0.09,0.075,0.033,0.075,iron);
      }
    }
    dock.collider(0,-0.06,0.50,0.42,0.16,1.10);
    plank(box,-0.11,0.078,0.07,0.15,0.15,0.155,'#a47c4b');
    plank(box,-0.11,0.08,0.07,0.031,0.158,0.16,oak,solid,0,0.55);
    for (const z of [0.26,0.43]) {
      plank(drum,0.09,0.076,z,0.12,0.16,0.12,oak);
      for (const y of [0.033,0.12]) plank(drum,0.09,y,z,0.125,0.018,0.125,iron);
    }
    plank(drum,-0.18,0.21,0.99,0.043,0.37,0.043,iron);
    plank(box,-0.18,0.43,0.99,0.087,0.095,0.087,'#ffdda0',lens);
    plank(pyramid,-0.18,0.50,0.99,0.14,0.068,0.14,iron);
    const lamp=dock.point(-0.18,0.43,0.99);
    sea.dockLights[i].set(lamp.x,lamp.z);
    const lantern=new THREE.Sprite(new THREE.SpriteMaterial({map:halos,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,opacity:0.67}));
    lantern.position.copy(lamp); lantern.scale.setScalar(0.32); lantern.renderOrder=4; group.add(lantern);

    // A hull on the stocks, still open between its curved ribs, beside a timber hoist.
    const yard=foundation(...port.yard,1.30,0.84), timber=yard.part;
    for (const z of [-0.23,0.23]) timber(box,0,0.053,z,1.18,0.055,0.064,oak);
    timber(box,0,0.16,0,1.08,0.057,0.052,'#785334');
    for (let rib=0; rib<9; rib++) {
      const along=rib/8, x=(along-0.5)*0.96;
      const span=0.06+0.16*Math.sin(Math.PI*along), rise=0.17+0.055*Math.abs(2*along-1);
      timber(box,x,0.09,0,0.049,0.064,0.56,'#ab8961');
      for (const side of [-1,1]) {
        timber(box,x,0.16+rise/2,side*span/2,0.034,Math.hypot(rise,span),0.034,'#8e6848',solid,Math.PI/2,side*Math.atan2(span,rise));
      }
    }
    timber(box,-0.55,0.44,-0.29,0.078,0.85,0.078,oak);
    timber(box,-0.25,0.86,-0.29,0.72,0.065,0.063,'#93673f',solid,0,0.10);
    timber(box,-0.38,0.63,-0.29,0.052,0.53,0.057,oak,solid,0,-0.65);
    timber(drum,0.06,0.70,-0.29,0.014,0.35,0.014,iron);
    timber(box,0.06,0.49,-0.29,0.17,0.13,0.16,'#aa8053');
    yard.collider(0,0.14,0,1.26,0.40,0.80);
    yard.collider(-0.54,0.46,-0.29,0.10,0.88,0.10);
  }

  // Masonry stringcourses and embrasures distinguish the walls from the courtyard behind them.
  for (const q of NATIONS) {
    const {wall,towers}=Z.nations[q];
    for (let i=0;i<wall.length;i++) {
      const [x,z]=wall[i], [xx,zz]=wall[(i+1)%wall.length], length=Math.hypot(xx-x,zz-z)/PX;
      const b=site((x+xx)/2,(z+zz)/2,-Math.atan2(zz-z,xx-x),COURT_H);
      b.part(box,0,0.285,0,length+0.04,0.055,0.165,'#c2b8a2');
      const n=Math.max(1,Math.floor(length/0.48));
      for (let k=0;k<n;k++) {
        const u=length*((k+0.5)/n-0.5);
        b.part(box,u,0.02,0,0.095,0.43,0.185,'#b6ad99');
      }
    }
    for (const [px,py,s] of towers) {
      const b=site(px,py,0,COURT_H-0.25), r=0.22*s;
      b.part(drum,0,0.37*s,0,r*2.15,0.044,r*2.15,'#bbb098');
      for (let k=0;k<8;k++) {
        const a=k*Math.PI/4;
        b.part(box,r*1.025*Math.sin(a),0.71*s,r*1.025*Math.cos(a),0.043,0.13*s,0.023,iron,solid,a);
      }
    }
  }
  for (let gy=4;gy<TN-4;gy+=4) for (let gx=4;gx<TN-4;gx+=4) {
    const px=gx*5+2.5, py=gy*5+2.5, sd=SD[gy*TN+gx];
    if (sd < -3 || sd > 9 || rnd()>0.43 || nearKeepout(px,py) || onPad(px,py) || nearby(px,py,5)) continue;
    const b=site(px,py,rnd()*6), h=0.09+rnd()*0.14;
    b.part(crag,0,0.015,0,h*1.8,h,h*1.4,'#899395',solid,rnd()*6,0.23);
    b.part(crag,h*0.91,-0.006,h*0.24,h*0.92,h*0.64,h*0.85,'#acada2',solid,rnd()*6);
    collBall(b.origin.x,b.origin.y,b.origin.z,h*0.58);
  }
  for (const {geo,material,parts} of batches.values()) {
    const mesh=new THREE.InstancedMesh(geo,material,parts.length);
    parts.forEach(([m,color],i)=>{mesh.setMatrixAt(i,m); mesh.setColorAt(i,color);});
    mesh.castShadow=material!==lens; mesh.receiveShadow=true; group.add(mesh);
  }
  function update(time) {
    for (const rotor of rotors) rotor.rotation.z=0.36+time*0.50;
    for (const {head,halo,waterBeam,phase,rate} of beaconHeads) {
      const angle=time*rate+phase, x=Math.cos(angle), z=-Math.sin(angle);
      head.rotation.y=angle; waterBeam.z=x; waterBeam.w=z;
      const dx=camera.position.x-head.position.x, dz=camera.position.z-head.position.z;
      const flash=Math.pow(Math.max(0,(dx*x+dz*z)/Math.max(0.01,Math.hypot(dx,dz))),12);
      halo.material.opacity=0.43+0.52*flash; halo.scale.setScalar(0.49+0.43*flash);
    }
  }
  return {update, occupied:(px,py)=>onPad(px,py)||nearby(px,py,5)};
}
